// 任务仓储：控制面 PostgreSQL 的原子操作。所有写入必须带 tenant_id；
// Worker 写入必须带 lease_owner + version（fencing）。
import crypto from 'node:crypto';
import { getPool, withTransaction } from './pg.js';

export class TaskConflictError extends Error {
  constructor(message = '任务版本冲突'){
    super(message);
    this.name = 'TaskConflictError';
    this.code = 'conflict';
  }
}

export class LeaseLostError extends Error {
  constructor(message = '租约已失效'){
    super(message);
    this.name = 'LeaseLostError';
    this.code = 'lease_lost';
  }
}

export class TaskNotFoundError extends Error {
  constructor(message = '任务不存在'){
    super(message);
    this.name = 'TaskNotFoundError';
    this.code = 'not_found';
  }
}

const PATCH_JSON_FIELDS = new Set(['usage_json', 'budget_json', 'input_json']);
/** 让 ready_at 使用数据库时间，避免 Worker/客户端时钟偏差导致任务不可领取。 */
export const SQL_NOW = Symbol('sql_now');
export function sqlNowPlusMs(ms){ return { __sqlIntervalMs: ms }; }
const PATCH_FIELDS = new Set([
  'title', 'goal', 'priority', 'ready_at', 'lease_owner', 'lease_expires_at', 'heartbeat_at',
  'last_error_code', 'last_error_detail', 'result_summary', 'cancel_requested_at',
  'cancel_requested_by', 'cancelled_by', 'resume_count', 'recovery_count', 'plan_version',
  'current_step_seq', 'usage_json', 'budget_json', 'input_json', 'max_attempts', 'attempt_count',
]);

export function toTask(row){
  if (!row) return null;
  return {
    ...row,
    event_seq: Number(row.event_seq),
    version: Number(row.version),
    attempt_count: Number(row.attempt_count),
    max_attempts: Number(row.max_attempts),
    resume_count: Number(row.resume_count),
    recovery_count: Number(row.recovery_count ?? 0),
    current_step_seq: Number(row.current_step_seq),
    plan_version: Number(row.plan_version),
    priority: Number(row.priority),
  };
}

function toEvent(row){
  return {
    id: Number(row.seq),
    seq: Number(row.seq),
    type: row.type,
    task_id: row.task_id,
    ts: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    schema_version: row.schema_version,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    payload: row.payload,
  };
}

/** 在事务内追加事件；任务行锁保证 seq 连续。 */
export async function appendEvent(client, { tenantId, taskId, type, payload = {}, actorType = 'system', actorId = null, schemaVersion = 1 }){
  const updated = await client.query(
    `UPDATE agent_tasks SET event_seq = event_seq + 1, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING event_seq`,
    [tenantId, taskId],
  );
  if (!updated.rowCount) throw new TaskNotFoundError();
  const seq = Number(updated.rows[0].event_seq);
  await client.query(
    `INSERT INTO agent_events (tenant_id, task_id, seq, type, schema_version, payload, actor_type, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [tenantId, taskId, seq, type, schemaVersion, JSON.stringify(payload), actorType, actorId],
  );
  return seq;
}

export async function createTask({
  tenantId, ownerId, title, goal, input = {}, budget = {}, priority = 100,
  maxAttempts = 5, actorId = null, presetId = null, presetVersion = null, extraEvents = [],
} = {}){
  return withTransaction(async client => {
    const inserted = await client.query(
      `INSERT INTO agent_tasks (tenant_id, owner_id, preset_id, preset_version, title, goal, input_json, budget_json, priority, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
       RETURNING *`,
      [tenantId, ownerId, presetId, presetVersion, title, goal, JSON.stringify(input), JSON.stringify(budget), priority, maxAttempts],
    );
    const taskId = inserted.rows[0].id;
    await appendEvent(client, {
      tenantId, taskId, type: 'task.created', actorType: 'user', actorId: actorId || ownerId,
      payload: { title, preset_id: presetId || null },
    });
    for (const ev of extraEvents || []){
      if (!ev || !ev.type) continue;
      await appendEvent(client, {
        tenantId, taskId, type: String(ev.type), payload: ev.payload || {},
        actorType: ev.actorType || 'system', actorId: ev.actorId || null,
      });
    }
    await appendEvent(client, {
      tenantId, taskId, type: 'task.queued', actorType: 'system',
      payload: { reason: 'created' },
    });
    const fresh = await client.query('SELECT * FROM agent_tasks WHERE tenant_id = $1 AND id = $2', [tenantId, taskId]);
    return toTask(fresh.rows[0]);
  });
}

export async function getTask(tenantId, taskId, client = null){
  const q = client || getPool();
  const r = await q.query('SELECT * FROM agent_tasks WHERE tenant_id = $1 AND id = $2', [tenantId, taskId]);
  if (!r.rowCount) return null;
  return toTask(r.rows[0]);
}

export async function listTasks(tenantId, ownerId, { limit = 20, cursor = null } = {}){
  const params = [tenantId, ownerId];
  let where = 'tenant_id = $1 AND owner_id = $2';
  if (cursor){
    params.push(cursor.createdAt, cursor.id);
    where += ' AND (created_at, id) < ($3::timestamptz, $4::uuid)';
  }
  params.push(Math.min(Math.max(limit, 1), 100));
  const r = await getPool().query(
    `SELECT * FROM agent_tasks WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows.map(toTask);
}

/** 领取一个 queued 任务：SKIP LOCKED + 数据库时间 + 租约写入 + task.started 同事务。 */
export async function claimNextTask({ workerId, leaseTtlMs }){
  return withTransaction(async client => {
    const picked = await client.query(
      `SELECT id FROM agent_tasks
        WHERE status = 'queued' AND ready_at <= now() AND attempt_count < max_attempts
        ORDER BY priority ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    );
    if (!picked.rowCount) return null;
    const taskId = picked.rows[0].id;
    const updated = await client.query(
      `UPDATE agent_tasks
          SET status = 'running',
              lease_owner = $2,
              lease_expires_at = now() + ($3::numeric * interval '1 millisecond'),
              heartbeat_at = now(),
              attempt_count = attempt_count + 1,
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND status = 'queued'
        RETURNING *`,
      [taskId, workerId, leaseTtlMs],
    );
    if (!updated.rowCount) return null;
    const task = toTask(updated.rows[0]);
    await appendEvent(client, {
      tenantId: task.tenant_id, taskId: task.id, type: 'task.started', actorType: 'worker', actorId: workerId,
      payload: { worker_id: workerId, attempt: task.attempt_count },
    });
    task.event_seq += 1;
    return task;
  });
}

/**
 * 续租：只以 lease_owner + status 作为护栏。
 * 状态写入仍必须带 version；续租不改变 version，避免与 Step 迁移竞争导致误判失租。
 */
export async function renewLease({ tenantId, taskId, workerId, leaseTtlMs }){
  const r = await getPool().query(
    `UPDATE agent_tasks
        SET lease_expires_at = now() + ($4::numeric * interval '1 millisecond'),
            heartbeat_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND status = 'running'
      RETURNING lease_expires_at, version`,
    [tenantId, taskId, workerId, leaseTtlMs],
  );
  if (!r.rowCount) throw new LeaseLostError();
  return { lease_expires_at: r.rows[0].lease_expires_at, version: Number(r.rows[0].version) };
}

/** 主动释放任务回队列（优雅停机/中止）。 */
export async function releaseTask({ tenantId, taskId, workerId, expectVersion, reason = 'worker_shutdown' }){
  return withTransaction(client => transitionTask(client, {
    tenantId, taskId, workerId,
    expectStatus: 'running', expectVersion,
    to: 'queued',
    patch: { ready_at: SQL_NOW, lease_owner: null, lease_expires_at: null },
    eventType: 'task.queued', eventPayload: { reason },
    actorType: 'worker', actorId: workerId,
  }));
}

/**
 * 受控状态迁移：同一事务内更新任务并追加事件。
 * 影响行数为 0 时抛出 LeaseLostError（Worker 写入）或 TaskConflictError。
 */
export async function transitionTask(client, {
  tenantId, taskId, expectStatus = 'running', expectVersion, workerId = null,
  to, patch = {}, eventType = null, eventPayload = {}, actorType = 'worker', actorId = null,
}){
  const sets = ['status = $1', 'version = version + 1', 'updated_at = now()'];
  const params = [to];
  for (const [key, value] of Object.entries(patch)){
    if (!PATCH_FIELDS.has(key)) throw new Error(`不允许更新字段：${key}`);
    if (key === 'ready_at' && value === SQL_NOW){
      sets.push('ready_at = now()');
      continue;
    }
    if (key === 'ready_at' && value && typeof value === 'object' && '__sqlIntervalMs' in value){
      params.push(Number(value.__sqlIntervalMs));
      sets.push(`ready_at = now() + ($${params.length}::numeric * interval '1 millisecond')`);
      continue;
    }
    params.push(PATCH_JSON_FIELDS.has(key) ? JSON.stringify(value) : value);
    sets.push(`${key} = $${params.length}${PATCH_JSON_FIELDS.has(key) ? '::jsonb' : ''}`);
  }
  params.push(tenantId, taskId, expectStatus, expectVersion);
  let where = `tenant_id = $${params.length - 3} AND id = $${params.length - 2} AND status = $${params.length - 1} AND version = $${params.length}`;
  if (workerId){
    params.push(workerId);
    where += ` AND lease_owner = $${params.length}`;
  }
  const r = await client.query(
    `UPDATE agent_tasks SET ${sets.join(', ')} WHERE ${where} RETURNING *`,
    params,
  );
  if (!r.rowCount){
    if (workerId) throw new LeaseLostError();
    throw new TaskConflictError('任务状态已变化，请刷新后重试');
  }
  const task = toTask(r.rows[0]);
  if (eventType){
    task.event_seq = await appendEvent(client, {
      tenantId, taskId, type: eventType, payload: eventPayload, actorType, actorId,
    });
  }
  return task;
}

export async function transitionTaskTx(args){
  return withTransaction(client => transitionTask(client, args));
}

export async function startStep({ tenantId, taskId, workerId, expectVersion, kind = 'model_turn' }){
  return withTransaction(async client => {
    const current = await client.query(
      `SELECT current_step_seq FROM agent_tasks
        WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND version = $4 AND status = 'running'
        FOR UPDATE`,
      [tenantId, taskId, workerId, expectVersion],
    );
    if (!current.rowCount) throw new LeaseLostError();
    const seq = Number(current.rows[0].current_step_seq) + 1;
    const updated = await client.query(
      `UPDATE agent_tasks SET current_step_seq = $5, version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND version = $4 AND status = 'running'
        RETURNING *`,
      [tenantId, taskId, workerId, expectVersion, seq],
    );
    if (!updated.rowCount) throw new LeaseLostError();
    const step = await client.query(
      `INSERT INTO agent_steps (tenant_id, task_id, seq, kind, status, started_at)
       VALUES ($1, $2, $3, $4, 'running', now()) RETURNING *`,
      [tenantId, taskId, seq, kind],
    );
    const task = toTask(updated.rows[0]);
    task.event_seq = await appendEvent(client, {
      tenantId, taskId, type: 'step.started', actorType: 'worker', actorId: workerId,
      payload: { step_seq: seq, kind },
    });
    return { task, step: step.rows[0] };
  });
}

export async function finishStep({ tenantId, taskId, stepId, workerId = null, status = 'completed', errorCode = null, inputTokens = 0, outputTokens = 0 }){
  await withTransaction(async client => {
    const params = [tenantId, stepId, status, errorCode, inputTokens, outputTokens];
    let where = 'tenant_id = $1 AND id = $2';
    if (workerId){
      params.push(taskId, workerId);
      where += ` AND EXISTS (
        SELECT 1 FROM agent_tasks t
         WHERE t.tenant_id = $1 AND t.id = $7 AND t.lease_owner = $8 AND t.status IN ('running', 'cancel_requested')
      )`;
    }
    const updated = await client.query(
      `UPDATE agent_steps SET status = $3, error_code = $4, input_tokens = $5, output_tokens = $6, ended_at = now()
        WHERE ${where} RETURNING task_id, seq`,
      params,
    );
    if (!updated.rowCount) return; // 租约已失效：旧 Worker 不得再写
    await appendEvent(client, {
      tenantId, taskId, type: 'step.completed', actorType: 'worker', actorId: workerId,
      payload: { step_seq: Number(updated.rows[0].seq), status, error_code: errorCode },
    });
  });
}

export async function recordPlan({ tenantId, taskId, workerId, expectVersion, items }){
  return withTransaction(async client => {
    const current = await client.query(
      `SELECT plan_version FROM agent_tasks
        WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND version = $4 AND status = 'running'
        FOR UPDATE`,
      [tenantId, taskId, workerId, expectVersion],
    );
    if (!current.rowCount) throw new LeaseLostError();
    const version = Number(current.rows[0].plan_version) + 1;
    const updated = await client.query(
      `UPDATE agent_tasks SET plan_version = $5, version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND version = $4 AND status = 'running'
        RETURNING *`,
      [tenantId, taskId, workerId, expectVersion, version],
    );
    if (!updated.rowCount) throw new LeaseLostError();
    for (const item of items){
      await client.query(
        `INSERT INTO agent_plan_items
           (tenant_id, task_id, plan_version, item_key, title, description, status, depends_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [tenantId, taskId, version, item.item_key, item.title, item.description || '', item.status || 'pending',
          JSON.stringify(item.depends_on || [])],
      );
    }
    const task = toTask(updated.rows[0]);
    task.event_seq = await appendEvent(client, {
      tenantId, taskId, type: 'plan.updated', actorType: 'model',
      payload: { plan_version: version, items: items.map(i => ({ item_key: i.item_key, title: i.title, status: i.status || 'pending' })) },
    });
    return task;
  });
}

export async function listPlanItems(tenantId, taskId, planVersion = null){
  const params = [tenantId, taskId];
  let where = 'tenant_id = $1 AND task_id = $2';
  if (planVersion != null){ params.push(planVersion); where += ' AND plan_version = $3'; }
  const r = await getPool().query(
    `SELECT * FROM agent_plan_items WHERE ${where} ORDER BY plan_version DESC, created_at ASC`,
    params,
  );
  if (!r.rowCount) return [];
  const latest = Number(r.rows[0].plan_version);
  return r.rows.filter(row => Number(row.plan_version) === latest);
}

export async function appendMessage({ tenantId, taskId, role, content, contentJson = null, actorId = null }){
  return withTransaction(async client => {
    await client.query('SELECT id FROM agent_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, taskId]);
    const seqRow = await client.query(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM agent_messages WHERE tenant_id = $1 AND task_id = $2',
      [tenantId, taskId],
    );
    const seq = Number(seqRow.rows[0].seq);
    const r = await client.query(
      `INSERT INTO agent_messages (tenant_id, task_id, seq, role, content, content_json, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
      [tenantId, taskId, seq, role, content, contentJson ? JSON.stringify(contentJson) : null, actorId],
    );
    return { ...r.rows[0], seq };
  });
}

export async function listMessages(tenantId, taskId, limit = 40){
  const r = await getPool().query(
    `SELECT role, content FROM agent_messages
      WHERE tenant_id = $1 AND task_id = $2
      ORDER BY seq DESC LIMIT $3`,
    [tenantId, taskId, limit],
  );
  return r.rows.reverse();
}

export async function saveCheckpoint({ tenantId, taskId, stepSeq, state }){
  const stateJson = JSON.stringify(state);
  const hash = crypto.createHash('sha256').update(stateJson).digest('hex');
  await getPool().query(
    `INSERT INTO agent_checkpoints (tenant_id, task_id, step_seq, state_json, state_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (task_id, step_seq) DO UPDATE SET state_json = EXCLUDED.state_json, state_hash = EXCLUDED.state_hash, created_at = now()`,
    [tenantId, taskId, stepSeq, stateJson, hash],
  );
  return hash;
}

export async function getLatestCheckpoint(tenantId, taskId){
  const r = await getPool().query(
    `SELECT * FROM agent_checkpoints WHERE tenant_id = $1 AND task_id = $2 ORDER BY step_seq DESC LIMIT 1`,
    [tenantId, taskId],
  );
  return r.rows[0] || null;
}

export async function getEventsAfter(tenantId, taskId, afterSeq = 0, limit = 200){
  const r = await getPool().query(
    `SELECT * FROM agent_events
      WHERE tenant_id = $1 AND task_id = $2 AND seq > $3
      ORDER BY seq ASC LIMIT $4`,
    [tenantId, taskId, afterSeq, Math.min(Math.max(limit, 1), 500)],
  );
  return r.rows.map(toEvent);
}

export async function getTaskStatus(tenantId, taskId){
  const r = await getPool().query('SELECT status, event_seq FROM agent_tasks WHERE tenant_id = $1 AND id = $2', [tenantId, taskId]);
  if (!r.rowCount) return null;
  return { status: r.rows[0].status, event_seq: Number(r.rows[0].event_seq) };
}

// —— 输入请求 ——
export async function createInputRequest({ tenantId, taskId, stepId = null, question, inputSchema, expiresAt = null }){
  return withTransaction(async client => {
    const r = await client.query(
      `INSERT INTO agent_input_requests (tenant_id, task_id, step_id, question, input_schema, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING *`,
      [tenantId, taskId, stepId, question, JSON.stringify(inputSchema), expiresAt],
    );
    await appendEvent(client, {
      tenantId, taskId, type: 'input.requested', actorType: 'model',
      payload: { input_request_id: r.rows[0].id, question, schema: inputSchema },
    });
    return r.rows[0];
  });
}

export async function getPendingInput(tenantId, taskId){
  const r = await getPool().query(
    `SELECT * FROM agent_input_requests WHERE tenant_id = $1 AND task_id = $2 AND status = 'pending'
      ORDER BY requested_at DESC LIMIT 1`,
    [tenantId, taskId],
  );
  return r.rows[0] || null;
}

// —— 审批（P0-2 先用于恢复对账的骨架） ——
export async function createApproval({ tenantId, taskId, toolCallId, kind = 'tool_call', riskLevel = 'medium', requestPayload = {}, argsHash, requestedBy, expiresAt }){
  return withTransaction(async client => {
    const r = await client.query(
      `INSERT INTO agent_approvals
         (tenant_id, task_id, tool_call_id, kind, risk_level, request_payload_json, args_hash, requested_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9) RETURNING *`,
      [tenantId, taskId, toolCallId, kind, riskLevel, JSON.stringify(requestPayload), argsHash, requestedBy, expiresAt],
    );
    await appendEvent(client, {
      tenantId, taskId, type: 'approval.requested', actorType: 'system',
      payload: { approval_id: r.rows[0].id, risk_level: riskLevel, kind },
    });
    return r.rows[0];
  });
}

export async function getApproval(tenantId, approvalId){
  const r = await getPool().query('SELECT * FROM agent_approvals WHERE tenant_id = $1 AND id = $2', [tenantId, approvalId]);
  return r.rows[0] || null;
}

// —— 工具调用（P0-2 提供持久化与恢复查询；执行器在 P0-4 接入） ——
export async function createToolCall({ tenantId, taskId, stepId = null, toolName, toolVersion = '', source = 'builtin', args = {}, argsHash, sideEffect = 'read', idempotencyKey = null, status = 'proposed' }){
  const r = await getPool().query(
    `INSERT INTO agent_tool_calls
       (tenant_id, task_id, step_id, tool_name, tool_version, source, args_json, args_hash, side_effect, idempotency_key, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11) RETURNING *`,
    [tenantId, taskId, stepId, toolName, toolVersion, source, JSON.stringify(args), argsHash, sideEffect, idempotencyKey, status],
  );
  return r.rows[0];
}

export async function startToolAttempt({ tenantId, toolCallId, attemptNo, workerId, leaseEpoch }){
  return withTransaction(async client => {
    await client.query('UPDATE agent_tool_calls SET status = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId, toolCallId, 'running']);
    const r = await client.query(
      `INSERT INTO agent_tool_attempts (tenant_id, tool_call_id, attempt_no, worker_id, lease_epoch, status)
       VALUES ($1, $2, $3, $4, $5, 'running') RETURNING *`,
      [tenantId, toolCallId, attemptNo, workerId, leaseEpoch],
    );
    return r.rows[0];
  });
}

export async function finishToolAttempt({ tenantId, attemptId, status, errorCode = null, resultHash = null }){
  await getPool().query(
    `UPDATE agent_tool_attempts SET status = $3, error_code = $4, result_hash = $5, ended_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, attemptId, status, errorCode, resultHash],
  );
}

export async function finishToolCall({ tenantId, toolCallId, status, errorCode = null, resultPreview = null }){
  await getPool().query(
    `UPDATE agent_tool_calls SET status = $3, error_code = $4, result_preview = $5, updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, toolCallId, status, errorCode, resultPreview],
  );
}

export async function listInFlightToolCalls(tenantId, taskId, client = null){
  const q = client || getPool();
  const r = await q.query(
    `SELECT tc.*, ta.id AS attempt_id, ta.attempt_no
       FROM agent_tool_calls tc
       LEFT JOIN agent_tool_attempts ta ON ta.tool_call_id = tc.id AND ta.status = 'running'
      WHERE tc.tenant_id = $1 AND tc.task_id = $2 AND tc.status IN ('running', 'awaiting_approval')
      ORDER BY tc.created_at`,
    [tenantId, taskId],
  );
  return r.rows;
}

// —— Worker 节点 ——
/** worker_nodes.id 是 uuid；允许 CLI 使用可读 ID，映射为稳定 UUID。 */
export function workerNodeId(workerId){
  const s = String(workerId);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s;
  const h = crypto.createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function registerWorker({ workerId, hostname, pid, version }){
  await getPool().query(
    `INSERT INTO worker_nodes (id, hostname, pid, version, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (id) DO UPDATE SET hostname = EXCLUDED.hostname, pid = EXCLUDED.pid, version = EXCLUDED.version, status = 'active', last_heartbeat_at = now()`,
    [workerNodeId(workerId), hostname, pid, version],
  );
}

export async function heartbeatWorker(workerId){
  await getPool().query('UPDATE worker_nodes SET last_heartbeat_at = now() WHERE id = $1', [workerNodeId(workerId)]);
}

export async function setWorkerStatus(workerId, status){
  await getPool().query('UPDATE worker_nodes SET status = $2, last_heartbeat_at = now() WHERE id = $1', [workerNodeId(workerId), status]);
}

export async function getTaskForUpdate(client, tenantId, taskId){
  const r = await client.query('SELECT * FROM agent_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, taskId]);
  return r.rowCount ? toTask(r.rows[0]) : null;
}
