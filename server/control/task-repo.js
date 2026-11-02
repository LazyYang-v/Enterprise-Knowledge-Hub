// 任务仓储：控制面 PostgreSQL 的原子操作。所有写入必须带 tenant_id；
// Worker 写入必须带 lease_owner + version（fencing）。
import crypto from 'node:crypto';
import { getPool, withTransaction } from './pg.js';
import { assertTaskArtifacts, ArtifactClaimError } from './artifact-repo.js';

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

export class EvidenceClaimError extends Error {
  constructor(message = '引用不属于当前领取'){
    super(message);
    this.name = 'EvidenceClaimError';
    this.code = 'evidence_conflict';
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
    lease_epoch: Number(row.lease_epoch ?? 0),
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

function likePattern(value){
  return `%${String(value).replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
}

export async function listTasks(tenantId, ownerId, {
  limit = 20, cursor = null, statuses = null, q = null,
} = {}){
  const params = [tenantId, ownerId];
  let where = 'tenant_id = $1 AND owner_id = $2';
  if (Array.isArray(statuses) && statuses.length){
    params.push(statuses);
    where += ` AND status = ANY($${params.length}::text[])`;
  }
  if (q){
    params.push(likePattern(q));
    where += ` AND (title ILIKE $${params.length} ESCAPE '\\' OR goal ILIKE $${params.length} ESCAPE '\\')`;
  }
  if (cursor){
    params.push(cursor.createdAt, cursor.id);
    where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(Math.min(Math.max(Number(limit) || 20, 1), 100));
  const r = await getPool().query(
    `SELECT * FROM agent_tasks WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows.map(toTask);
}

/** 任务列表筛选计数：搜索词不影响状态分组，但会同时收窄四类计数。 */
export async function listTaskCounts(tenantId, ownerId, { q = null } = {}){
  const params = [tenantId, ownerId];
  let where = 'tenant_id = $1 AND owner_id = $2';
  if (q){
    params.push(likePattern(q));
    where += ` AND (title ILIKE $${params.length} ESCAPE '\\' OR goal ILIKE $${params.length} ESCAPE '\\')`;
  }
  const r = await getPool().query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN
              ('queued','running','cancel_requested','waiting_input','retry_wait'))::int AS running,
            COUNT(*) FILTER (WHERE status = 'waiting_approval')::int AS waiting_approval,
            COUNT(*) FILTER (WHERE status IN ('completed','failed','cancelled'))::int AS finished
       FROM agent_tasks WHERE ${where}`,
    params,
  );
  const row = r.rows[0] || {};
  return {
    all: Number(row.total || 0),
    running: Number(row.running || 0),
    waiting_approval: Number(row.waiting_approval || 0),
    finished: Number(row.finished || 0),
  };
}

/** 领取一个 queued 任务：SKIP LOCKED + 数据库时间 + 租约写入 + task.started 同事务。 */
export async function claimNextTask({ workerId, leaseTtlMs, tenantId = null }){
  return withTransaction(async client => {
    const tenantFilter = tenantId ? ' AND tenant_id = $1' : '';
    const picked = await client.query(
      `SELECT id FROM agent_tasks
        WHERE status = 'queued' AND ready_at <= now() AND attempt_count < max_attempts${tenantFilter}
        ORDER BY priority ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      tenantId ? [tenantId] : [],
    );
    if (!picked.rowCount) return null;
    const taskId = picked.rows[0].id;
    const updated = await client.query(
      `UPDATE agent_tasks
          SET status = 'running',
              lease_owner = $2,
              lease_epoch = lease_epoch + 1,
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
      payload: { worker_id: workerId, attempt: task.attempt_count, lease_epoch: task.lease_epoch },
    });
    task.event_seq += 1;
    return task;
  });
}

/**
 * 续租：要求当前所有者、领取标识，且租约尚未到期。
 * 续租不改变 version，避免与 Step 迁移竞争导致误判失租。
 */
export async function renewLease({ tenantId, taskId, workerId, leaseEpoch, leaseTtlMs }){
  const r = await getPool().query(
    `UPDATE agent_tasks
        SET lease_expires_at = now() + ($5::numeric * interval '1 millisecond'),
            heartbeat_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND lease_epoch = $4
        AND status = 'running' AND lease_expires_at > now()
      RETURNING lease_expires_at, version, lease_epoch`,
    [tenantId, taskId, workerId, leaseEpoch, leaseTtlMs],
  );
  if (!r.rowCount) throw new LeaseLostError();
  return {
    lease_expires_at: r.rows[0].lease_expires_at,
    version: Number(r.rows[0].version),
    lease_epoch: Number(r.rows[0].lease_epoch),
  };
}

/** 主动释放任务回队列（优雅停机/中止）。 */
export async function releaseTask({ tenantId, taskId, workerId, leaseEpoch, expectVersion, reason = 'worker_shutdown' }){
  return withTransaction(client => transitionTask(client, {
    tenantId, taskId, workerId, leaseEpoch,
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
  tenantId, taskId, expectStatus = 'running', expectVersion, workerId = null, leaseEpoch = null,
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
  if (workerId && leaseEpoch != null){
    params.push(leaseEpoch);
    where += ` AND lease_epoch = $${params.length} AND lease_expires_at > now()`;
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

export async function startStep({ tenantId, taskId, workerId, leaseEpoch, expectVersion, kind = 'model_turn' }){
  return withTransaction(async client => {
    const current = await client.query(
      `SELECT current_step_seq FROM agent_tasks
        WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND lease_epoch = $4
          AND version = $5 AND status = 'running' AND lease_expires_at > now()
        FOR UPDATE`,
      [tenantId, taskId, workerId, leaseEpoch, expectVersion],
    );
    if (!current.rowCount) throw new LeaseLostError();
    const seq = Number(current.rows[0].current_step_seq) + 1;
    const updated = await client.query(
      `UPDATE agent_tasks SET current_step_seq = $6, version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND lease_epoch = $4
          AND version = $5 AND status = 'running' AND lease_expires_at > now()
        RETURNING *`,
      [tenantId, taskId, workerId, leaseEpoch, expectVersion, seq],
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

export async function finishStep({
  tenantId, taskId, stepId, workerId = null, leaseEpoch = null,
  status = 'completed', errorCode = null, inputTokens = 0, outputTokens = 0,
}){
  if (workerId && leaseEpoch == null) throw new TypeError('Worker 写入必须提供 leaseEpoch');
  await withTransaction(async client => {
    const params = [tenantId, stepId, status, errorCode, inputTokens, outputTokens];
    let where = 'tenant_id = $1 AND id = $2 AND status = \'running\'';
    if (workerId){
      params.push(taskId, workerId);
      where += ` AND task_id = $7 AND EXISTS (
        SELECT 1 FROM agent_tasks t
         WHERE t.tenant_id = $1 AND t.id = $7 AND t.lease_owner = $8
           AND t.lease_epoch = $9 AND t.status IN ('running', 'cancel_requested')
           AND t.lease_expires_at > now()
      )`;
      params.push(leaseEpoch);
    }
    const updated = await client.query(
      `UPDATE agent_steps SET status = $3, error_code = $4, input_tokens = $5, output_tokens = $6, ended_at = now()
        WHERE ${where} RETURNING task_id, seq`,
      params,
    );
    if (!updated.rowCount) throw new LeaseLostError('步骤已完成或租约已失效');
    await appendEvent(client, {
      tenantId, taskId, type: 'step.completed', actorType: 'worker', actorId: workerId,
      payload: { step_seq: Number(updated.rows[0].seq), status, error_code: errorCode },
    });
  });
}

/**
 * 原子完成：同一事务内校验本领取的证据、完成 Step、写检查点、完成任务并追加事件。
 * 任一校验失败时整个事务回滚，不留下部分完成状态。
 */
export async function completeTask({
  tenantId, taskId, workerId, leaseEpoch, stepId, stepSeq,
  summary, citations = [], evidenceIds = [], artifactIds = [], usage = {}, checkpointState = null,
}){
  return withTransaction(async client => {
    const owned = await client.query(
      `SELECT id FROM agent_tasks
        WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND lease_epoch = $4
          AND status = 'running' AND lease_expires_at > now()
        FOR UPDATE`,
      [tenantId, taskId, workerId, leaseEpoch],
    );
    if (!owned.rowCount) throw new LeaseLostError('租约已失效：完成写入不属于当前领取');

    const cited = [...new Set((citations || []).map(String))];
    if (cited.length){
      const rows = await client.query(
        `SELECT id FROM agent_evidence
          WHERE tenant_id = $1 AND task_id = $2 AND lease_epoch = $3 AND id = ANY($4::uuid[])`,
        [tenantId, taskId, leaseEpoch, cited],
      );
      if (rows.rowCount !== cited.length) throw new EvidenceClaimError();
    }

    const step = await client.query(
      `UPDATE agent_steps SET status = 'completed', ended_at = now()
        WHERE tenant_id = $1 AND task_id = $2 AND id = $3 AND status = 'running'
        RETURNING seq`,
      [tenantId, taskId, stepId],
    );
    if (!step.rowCount) throw new LeaseLostError('租约已失效：步骤已完成或不属于当前领取');

    const artifacts = [...new Set((artifactIds || []).map(String))];
    if (artifacts.length){
      try {
        await assertTaskArtifacts({ tenantId, taskId, ids: artifacts, client });
      } catch {
        throw new ArtifactClaimError();
      }
    }

    if (checkpointState){
      const stateJson = JSON.stringify(checkpointState);
      const hash = crypto.createHash('sha256').update(stateJson).digest('hex');
      await client.query(
        `INSERT INTO agent_checkpoints (tenant_id, task_id, step_seq, state_json, state_hash)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (task_id, step_seq) DO UPDATE SET state_json = EXCLUDED.state_json, state_hash = EXCLUDED.state_hash, created_at = now()`,
        [tenantId, taskId, stepSeq, stateJson, hash],
      );
    }

    const updated = await client.query(
      `UPDATE agent_tasks
          SET status = 'completed', result_summary = $5, usage_json = $6::jsonb,
              current_step_seq = $7, lease_owner = NULL, lease_expires_at = NULL,
              version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND lease_epoch = $4
          AND status = 'running'
        RETURNING *`,
      [tenantId, taskId, workerId, leaseEpoch, summary, JSON.stringify(usage), stepSeq],
    );
    if (!updated.rowCount) throw new LeaseLostError();
    const task = toTask(updated.rows[0]);
    task.event_seq = await appendEvent(client, {
      tenantId, taskId, type: 'task.completed',
      payload: { summary, artifact_ids: artifactIds, citations: cited, evidence_ids: evidenceIds },
      actorType: 'model',
    });
    return task;
  });
}

export async function recordPlan({ tenantId, taskId, workerId, leaseEpoch, expectVersion, items }){
  return withTransaction(async client => {
    const current = await client.query(
      `SELECT plan_version FROM agent_tasks
        WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND lease_epoch = $4
          AND version = $5 AND status = 'running' AND lease_expires_at > now()
        FOR UPDATE`,
      [tenantId, taskId, workerId, leaseEpoch, expectVersion],
    );
    if (!current.rowCount) throw new LeaseLostError();
    const version = Number(current.rows[0].plan_version) + 1;
    const updated = await client.query(
      `UPDATE agent_tasks SET plan_version = $6, version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND lease_epoch = $4
          AND version = $5 AND status = 'running' AND lease_expires_at > now()
        RETURNING *`,
      [tenantId, taskId, workerId, leaseEpoch, expectVersion, version],
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

export async function appendMessage({
  tenantId, taskId, role, content, contentJson = null, actorId = null, leaseEpoch = null,
}){
  return withTransaction(async client => {
    if (leaseEpoch != null){
      const owned = await client.query(
        `SELECT id FROM agent_tasks
          WHERE tenant_id = $1 AND id = $2 AND lease_epoch = $3
            AND status IN ('running', 'cancel_requested') AND lease_expires_at > now() FOR UPDATE`,
        [tenantId, taskId, leaseEpoch],
      );
      if (!owned.rowCount) throw new LeaseLostError('租约已失效：消息写入不属于当前领取');
    } else {
      await client.query('SELECT id FROM agent_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, taskId]);
    }
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
    `SELECT seq, role, content, created_at FROM agent_messages
      WHERE tenant_id = $1 AND task_id = $2
      ORDER BY seq DESC LIMIT $3`,
    [tenantId, taskId, limit],
  );
  return r.rows.reverse();
}

export async function saveCheckpoint({ tenantId, taskId, stepSeq, state, leaseEpoch = null }){
  const stateJson = JSON.stringify(state);
  const hash = crypto.createHash('sha256').update(stateJson).digest('hex');
  return withTransaction(async client => {
    if (leaseEpoch != null){
      const owned = await client.query(
        `SELECT 1 FROM agent_tasks
          WHERE tenant_id = $1 AND id = $2 AND lease_epoch = $3
            AND status IN ('running', 'cancel_requested', 'waiting_input', 'waiting_approval')
            AND (status IN ('waiting_input', 'waiting_approval') OR lease_expires_at > now())`,
        [tenantId, taskId, leaseEpoch],
      );
      if (!owned.rowCount) throw new LeaseLostError('租约已失效：检查点写入不属于当前领取');
    }
    await client.query(
      `INSERT INTO agent_checkpoints (tenant_id, task_id, step_seq, state_json, state_hash)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (task_id, step_seq) DO UPDATE SET state_json = EXCLUDED.state_json, state_hash = EXCLUDED.state_hash, created_at = now()`,
      [tenantId, taskId, stepSeq, stateJson, hash],
    );
    return hash;
  });
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
export async function createToolCall({ tenantId, taskId, stepId = null, toolName, toolVersion = '', source = 'builtin', args = {}, argsHash, sideEffect = 'read', idempotencyKey = null, status = 'proposed', codeHash = '' }){
  const r = await getPool().query(
    `INSERT INTO agent_tool_calls
       (tenant_id, task_id, step_id, tool_name, tool_version, source, args_json, args_hash, side_effect, idempotency_key, status, code_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12) RETURNING *`,
    [tenantId, taskId, stepId, toolName, toolVersion, source, JSON.stringify(args), argsHash, sideEffect, idempotencyKey, status, codeHash],
  );
  return r.rows[0];
}

export async function startToolAttempt({ tenantId, toolCallId, attemptNo = null, workerId, leaseEpoch }){
  if (workerId == null || leaseEpoch == null) throw new TypeError('Worker 写入必须提供 leaseEpoch');
  return withTransaction(async client => {
    const owned = await client.query(
      `UPDATE agent_tool_calls c SET status = 'running', updated_at = now()
         FROM agent_tasks t
        WHERE c.tenant_id = $1 AND c.id = $2
          AND t.tenant_id = c.tenant_id AND t.id = c.task_id
          AND t.lease_owner = $3 AND t.lease_epoch = $4
          AND t.status IN ('running', 'cancel_requested')
          AND t.lease_expires_at > now()
          AND c.status IN ('proposed', 'running')
        RETURNING c.task_id`,
      [tenantId, toolCallId, workerId, leaseEpoch],
    );
    if (!owned.rowCount) throw new LeaseLostError('租约已失效：工具调用不属于当前领取');
    let no = attemptNo;
    if (no == null){
      const n = await client.query(
        `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next
           FROM agent_tool_attempts WHERE tenant_id = $1 AND tool_call_id = $2`,
        [tenantId, toolCallId],
      );
      no = Number(n.rows[0].next);
    }
    const r = await client.query(
      `INSERT INTO agent_tool_attempts (tenant_id, tool_call_id, attempt_no, worker_id, lease_epoch, status)
       VALUES ($1, $2, $3, $4, $5, 'running') RETURNING *`,
      [tenantId, toolCallId, no, workerId, leaseEpoch],
    );
    return r.rows[0];
  });
}

export async function getToolCallByIdempotencyKey({ tenantId, taskId, idempotencyKey }){
  if (!idempotencyKey) return null;
  const r = await getPool().query(
    `SELECT * FROM agent_tool_calls
      WHERE tenant_id = $1 AND task_id = $2 AND idempotency_key = $3
      ORDER BY created_at LIMIT 1`,
    [tenantId, taskId, idempotencyKey],
  );
  return r.rows[0] || null;
}

/**
 * Worker 崩溃后重开同一逻辑调用：只允许当前领取、且状态为 failed/unknown。
 * 不改变 id/幂等键/尝试历史，尝试号由 startToolAttempt 递增。
 */
export async function reopenToolCallForRetry({ tenantId, toolCallId, workerId, leaseEpoch }){
  if (!workerId || leaseEpoch == null) throw new TypeError('Worker 写入必须提供 leaseEpoch');
  return withTransaction(async client => {
    const r = await client.query(
      `UPDATE agent_tool_calls c
          SET status = 'proposed', error_code = NULL, updated_at = now()
         FROM agent_tasks t
        WHERE c.tenant_id = $1 AND c.id = $2
          AND t.tenant_id = c.tenant_id AND t.id = c.task_id
          AND t.lease_owner = $3 AND t.lease_epoch = $4
          AND t.status IN ('running', 'cancel_requested')
          AND t.lease_expires_at > now()
          AND c.status IN ('failed', 'unknown')
        RETURNING c.*`,
      [tenantId, toolCallId, workerId, leaseEpoch],
    );
    if (!r.rowCount) throw new LeaseLostError('租约已失效：无法重开工具调用');
    return r.rows[0];
  });
}

/**
 * 结束一次工具尝试。传入 workerId/leaseEpoch 时必须仍持有有效领取，
 * 迟到的旧 Worker 写入会被拒绝（LeaseLostError），不能覆盖新领取的结果。
 */
export async function finishToolAttempt({
  tenantId, attemptId, status, errorCode = null, resultHash = null,
  workerId = null, leaseEpoch = null,
}){
  if (workerId && leaseEpoch == null) throw new TypeError('Worker 写入必须提供 leaseEpoch');
  if (workerId){
    const r = await getPool().query(
      `UPDATE agent_tool_attempts a
          SET status = $3, error_code = $4, result_hash = $5, ended_at = now()
         FROM agent_tool_calls c, agent_tasks t
        WHERE a.tenant_id = $1 AND a.id = $2 AND a.status = 'running'
          AND a.worker_id = $6 AND a.lease_epoch = $7
          AND c.tenant_id = a.tenant_id AND c.id = a.tool_call_id
          AND t.tenant_id = c.tenant_id AND t.id = c.task_id
          AND t.lease_owner = $6 AND t.lease_epoch = $7
          AND t.lease_expires_at > now()
        RETURNING a.id`,
      [tenantId, attemptId, status, errorCode, resultHash, workerId, leaseEpoch],
    );
    if (!r.rowCount) throw new LeaseLostError('租约已失效：工具尝试不属于当前领取');
    return;
  }
  await getPool().query(
    `UPDATE agent_tool_attempts SET status = $3, error_code = $4, result_hash = $5, ended_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, attemptId, status, errorCode, resultHash],
  );
}

/**
 * 结束工具调用。传入 workerId/leaseEpoch 时同样要求当前领取有效，
 * 避免失去租约的 Worker 把旧调用标记为成功。
 */
export async function finishToolCall({
  tenantId, toolCallId, status, errorCode = null, resultPreview = null, resultHash = null,
  workerId = null, leaseEpoch = null, attemptId = null,
}){
  if (workerId && leaseEpoch == null) throw new TypeError('Worker 写入必须提供 leaseEpoch');
  const setSql = `SET status = $3, error_code = $4, result_preview = $5, result_hash = $6, updated_at = now()`;
  if (workerId){
    const r = await getPool().query(
      `UPDATE agent_tool_calls c ${setSql}
         FROM agent_tasks t
        WHERE c.tenant_id = $1 AND c.id = $2
          AND t.tenant_id = c.tenant_id AND t.id = c.task_id
          AND t.lease_owner = $7 AND t.lease_epoch = $8
          AND t.lease_expires_at > now()
          AND ($9::uuid IS NULL OR EXISTS (
            SELECT 1 FROM agent_tool_attempts a
             WHERE a.tenant_id = c.tenant_id AND a.id = $9
               AND a.tool_call_id = c.id
               AND a.worker_id = $7 AND a.lease_epoch = $8
          ))
        RETURNING c.id`,
      [tenantId, toolCallId, status, errorCode, resultPreview, resultHash || '', workerId, leaseEpoch, attemptId],
    );
    if (!r.rowCount) throw new LeaseLostError('租约已失效：工具调用不属于当前领取');
    return;
  }
  await getPool().query(
    `UPDATE agent_tool_calls c ${setSql}
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, toolCallId, status, errorCode, resultPreview, resultHash || ''],
  );
}

export async function getToolCall(tenantId, toolCallId){
  const r = await getPool().query(
    'SELECT * FROM agent_tool_calls WHERE tenant_id = $1 AND id = $2',
    [tenantId, toolCallId],
  );
  return r.rows[0] || null;
}

/** 更新工具调用状态（写入方必须持有效租约）。 */
export async function setToolCallStatus({ tenantId, toolCallId, status, workerId = null, leaseEpoch = null }){
  if (workerId && leaseEpoch == null) throw new TypeError('Worker 写入必须提供 leaseEpoch');
  if (workerId){
    const r = await getPool().query(
      `UPDATE agent_tool_calls c SET status = $3, updated_at = now()
         FROM agent_tasks t
        WHERE c.tenant_id = $1 AND c.id = $2
          AND t.tenant_id = c.tenant_id AND t.id = c.task_id
          AND t.lease_owner = $4 AND t.lease_epoch = $5
          AND t.lease_expires_at > now()
          AND c.status IN ('proposed', 'awaiting_approval', 'running', 'failed', 'unknown')
        RETURNING c.*`,
      [tenantId, toolCallId, status, workerId, leaseEpoch],
    );
    if (!r.rowCount) throw new LeaseLostError('租约已失效：无法更新工具调用状态');
    return r.rows[0];
  }
  const r = await getPool().query(
    'UPDATE agent_tool_calls SET status = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *',
    [tenantId, toolCallId, status],
  );
  return r.rows[0] || null;
}

export async function countToolCalls({ tenantId, taskId, toolName = null }){
  const params = [tenantId, taskId];
  let where = 'tenant_id = $1 AND task_id = $2';
  if (toolName){ params.push(toolName); where += ' AND tool_name = $3'; }
  const r = await getPool().query(`SELECT COUNT(*)::int AS n FROM agent_tool_calls WHERE ${where}`, params);
  return r.rows[0]?.n || 0;
}

export async function listToolCalls({ tenantId, taskId, limit = 100 }){
  const r = await getPool().query(
    `SELECT * FROM agent_tool_calls WHERE tenant_id = $1 AND task_id = $2
      ORDER BY created_at ASC LIMIT $3`,
    [tenantId, taskId, Math.min(Math.max(Number(limit) || 100, 1), 500)],
  );
  return r.rows;
}

export async function markToolCallReconciled({ tenantId, toolCallId, note = null }){
  const r = await getPool().query(
    `UPDATE agent_tool_calls
        SET status = 'reconciled', error_code = NULL, result_preview = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId, toolCallId, note],
  );
  return r.rows[0] || null;
}

/** 待处理审批：任务快照与审批 API 使用。 */
export async function getPendingApproval(tenantId, taskId){
  const r = await getPool().query(
    `SELECT * FROM agent_approvals
      WHERE tenant_id = $1 AND task_id = $2 AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, taskId],
  );
  return r.rows[0] || null;
}

/** 已批准但尚未消费的调用；Worker 恢复时先执行它。 */
export async function getApprovedToolApproval(tenantId, taskId){
  const r = await getPool().query(
    `SELECT a.* FROM agent_approvals a
      WHERE a.tenant_id = $1 AND a.task_id = $2 AND a.status = 'approved'
        AND a.kind = 'tool_call' AND a.consumed_at IS NULL
      ORDER BY a.decided_at ASC LIMIT 1`,
    [tenantId, taskId],
  );
  return r.rows[0] || null;
}

/** 一次性消费：同一审批只可能成功一次（事务内行锁 + consumed_at IS NULL）。 */
export async function consumeApproval(client, { tenantId, approvalId, userId }){
  const r = await client.query(
    `UPDATE agent_approvals
        SET consumed_at = now(), consumed_by = $3
      WHERE tenant_id = $1 AND id = $2 AND status = 'approved' AND consumed_at IS NULL
      RETURNING *`,
    [tenantId, approvalId, userId],
  );
  return r.rows[0] || null;
}

export async function cancelPendingApprovals({ tenantId, taskId, status = 'cancelled', actorId = null }){
  const r = await getPool().query(
    `UPDATE agent_approvals SET status = $3, decided_at = now(), decided_by = COALESCE(decided_by, $4)
      WHERE tenant_id = $1 AND task_id = $2 AND status = 'pending' RETURNING *`,
    [tenantId, taskId, status, actorId],
  );
  return r.rows;
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
