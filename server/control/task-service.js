// TaskService：唯一允许写 agent_tasks.status 的入口（设计文档 §5.2）。
// 每次状态迁移都带 version 乐观锁，并与 agent_events 同事务提交。
import {
  createTask as repoCreateTask,
  getTask,
  getTaskForUpdate,
  listTasks as repoListTasks,
  transitionTask,
  appendEvent,
  SQL_NOW,
  listPlanItems,
  getPendingInput,
  getLatestCheckpoint,
  listInFlightToolCalls,
} from './task-repo.js';
import { withTransaction, getPool } from './pg.js';
import { countEvidence } from './evidence-repo.js';

export class TaskValidationError extends Error {
  constructor(message){
    super(message);
    this.name = 'TaskValidationError';
    this.code = 'validation_error';
  }
}

export class TaskForbiddenError extends Error {
  constructor(message = '没有权限执行此操作'){
    super(message);
    this.name = 'TaskForbiddenError';
    this.code = 'forbidden';
  }
}

export class TaskStateError extends Error {
  constructor(message, code = 'conflict'){
    super(message);
    this.name = 'TaskStateError';
    this.code = code;
  }
}

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
export const RETRYABLE_ERRORS = new Set([
  'model_timeout', 'model_rate_limited', 'model_unavailable', 'model_invalid_output',
  'knowledge_unavailable', 'mcp_unavailable', 'internal_error', 'worker_lost',
]);
export const DEFAULT_BUDGET = Object.freeze({
  max_steps: 40,
  max_model_calls: 40,
  max_tool_calls: 25,
  max_tokens: 200000,
  max_wall_ms: 30 * 60 * 1000,
  model_timeout_ms: 120000,
});
const BUDGET_CAPS = Object.freeze({
  max_steps: 200,
  max_model_calls: 200,
  max_tool_calls: 100,
  max_tokens: 1000000,
  max_wall_ms: 4 * 60 * 60 * 1000,
  model_timeout_ms: 5 * 60 * 1000,
});

function normalizeBudget(overrides = {}){
  if (overrides == null || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TaskValidationError('budget 必须是对象');
  const merged = { ...DEFAULT_BUDGET };
  for (const key of Object.keys(overrides)){
    if (!(key in DEFAULT_BUDGET)) throw new TaskValidationError(`未知预算字段：${key}`);
    const value = overrides[key];
    if (!Number.isFinite(value) || value <= 0) throw new TaskValidationError(`预算 ${key} 必须是正数`);
    merged[key] = Math.min(Math.floor(value), BUDGET_CAPS[key]);
  }
  return merged;
}

function assertGoal(goal){
  const value = typeof goal === 'string' ? goal.trim() : '';
  if (!value) throw new TaskValidationError('goal 不能为空');
  if (value.length > 8000) throw new TaskValidationError('goal 不能超过 8000 字符');
  // 控制字符（允许换行与制表符）
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new TaskValidationError('goal 包含非法控制字符');
  return value;
}

const KB_SCOPE_MODES = new Set(['visible', 'explicit', 'preset', 'none']);

function normalizeKbScope(raw){
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TaskValidationError('kb_scope 必须是对象');
  const mode = raw.mode == null ? null : raw.mode;
  if (mode != null && !KB_SCOPE_MODES.has(mode)) throw new TaskValidationError('kb_scope.mode 不合法');
  let kbIds = null;
  if (raw.kb_ids != null){
    if (!Array.isArray(raw.kb_ids) || raw.kb_ids.length > 50) throw new TaskValidationError('kb_scope.kb_ids 最多 50 项');
    kbIds = [...new Set(raw.kb_ids.map(String).filter(Boolean))];
    if (mode === 'explicit' && kbIds.length === 0) throw new TaskValidationError('explicit 模式必须提供 kb_ids');
  }
  const versionPolicy = raw.version_policy == null ? 'pin_on_first_use' : raw.version_policy;
  if (!['pin_on_first_use', 'latest'].includes(versionPolicy)) throw new TaskValidationError('kb_scope.version_policy 不合法');
  return { mode, kb_ids: kbIds, version_policy: versionPolicy };
}

function normalizeSkill(raw){
  if (typeof raw === 'string'){
    const ref = raw.trim();
    if (!ref || ref.length > 200) throw new TaskValidationError('skill 不合法');
    return { ref };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)){
    const out = {};
    for (const key of ['ref', 'id', 'name', 'version', 'content_hash']){
      if (raw[key] != null){
        if (typeof raw[key] !== 'string' || raw[key].length > 200) throw new TaskValidationError(`skill.${key} 不合法`);
        out[key] = raw[key];
      }
    }
    if (!out.ref && !out.id && !out.name) throw new TaskValidationError('skill 需要 name 或 id');
    return out;
  }
  throw new TaskValidationError('skill 必须是字符串或对象');
}

function pickInput(raw){
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TaskValidationError('input 必须是对象');
  const out = {};
  if (raw.preset_id != null) out.preset_id = String(raw.preset_id);
  if (raw.kb_scope != null) out.kb_scope = normalizeKbScope(raw.kb_scope);
  if (raw.skill != null) out.skill = normalizeSkill(raw.skill);
  if (raw.approval_mode != null){
    if (!['risk_based', 'never', 'always'].includes(raw.approval_mode)) throw new TaskValidationError('approval_mode 不合法');
    out.approval_mode = raw.approval_mode;
  }
  if (raw.input_ids != null){
    if (!Array.isArray(raw.input_ids) || raw.input_ids.length > 20) throw new TaskValidationError('input_ids 最多 20 项');
    out.input_ids = raw.input_ids.map(String);
  }
  if (raw.metadata != null){
    if (typeof raw.metadata !== 'object' || Array.isArray(raw.metadata)) throw new TaskValidationError('metadata 必须是对象');
    out.metadata = raw.metadata;
  }
  return out;
}

function assertOwner(task, userId, isAdmin = false){
  if (!task) throw new TaskStateError('任务不存在', 'not_found');
  if (task.owner_id !== userId && !isAdmin) throw new TaskForbiddenError();
}

function isoOrNull(v){
  return v instanceof Date ? v.toISOString() : v || null;
}

export class TaskService {
  constructor({
    defaultBudget = DEFAULT_BUDGET,
    getPreset = null, resolveKnowledgeScope = null, assertInputDocs = null, selectSkill = null,
  } = {}){
    this.defaultBudget = { ...defaultBudget };
    this.getPreset = getPreset;
    this.resolveKnowledgeScope = resolveKnowledgeScope;
    this.assertInputDocs = assertInputDocs;
    this.selectSkill = selectSkill;
  }

  async createTask({ tenantId, ownerId, goal, title = '', input = {}, budget = {}, priority = 100 }){
    const safeGoal = assertGoal(goal);
    const safeTitle = String(title || '').trim().slice(0, 200) || safeGoal.slice(0, 60);
    const mergedBudget = normalizeBudget(budget);
    const safeInput = pickInput(input);
    if (!Number.isInteger(priority) || priority < 0 || priority > 1000){
      throw new TaskValidationError('priority 必须是 0-1000 的整数');
    }

    let preset = null;
    const extraEvents = [];
    if (this.getPreset && safeInput.preset_id){
      preset = await this.getPreset({ tenantId, presetId: safeInput.preset_id });
      if (!preset) throw new TaskValidationError('预设不存在');
      if (preset.status !== 'active') throw new TaskValidationError('预设不可用');
    }
    if (this.assertInputDocs){
      await this.assertInputDocs({ userId: ownerId, inputIds: safeInput.input_ids || [] });
    }
    if (this.resolveKnowledgeScope){
      safeInput.knowledge = await this.resolveKnowledgeScope({
        tenantId, ownerId, preset,
        kbScope: safeInput.kb_scope || null,
        inputDocIds: safeInput.input_ids || [],
      });
      if (safeInput.knowledge.reduced_count > 0){
        extraEvents.push({
          type: 'policy.scope_reduced',
          payload: {
            reduced_count: safeInput.knowledge.reduced_count,
            source: preset ? 'preset' : 'visible',
          },
        });
      }
    }
    if (this.selectSkill){
      const rawSkill = safeInput.skill;
      const skillRef = rawSkill && typeof rawSkill === 'object' && rawSkill.ref ? rawSkill.ref : rawSkill;
      const selected = await this.selectSkill({
        tenantId, userId: ownerId,
        skillRef,
        presetId: preset?.id || null,
      });
      if (selected){
        safeInput.skill = {
          id: selected.skill_id, name: selected.name, version: selected.version,
          content_hash: selected.content_hash,
        };
        extraEvents.push({
          type: 'skill.selected',
          payload: { skill_id: selected.skill_id, name: selected.name, version: selected.version },
        });
      } else {
        delete safeInput.skill;
      }
    }

    return repoCreateTask({
      tenantId, ownerId, title: safeTitle, goal: safeGoal,
      input: safeInput, budget: mergedBudget, priority,
      actorId: ownerId,
      presetId: preset?.id || null,
      presetVersion: preset?.config_version || null,
      extraEvents,
    });
  }

  async getTaskForUser({ tenantId, taskId, userId, isAdmin = false }){
    const task = await getTask(tenantId, taskId);
    assertOwner(task, userId, isAdmin);
    return task;
  }

  async listTasks({ tenantId, ownerId, limit = 20, cursor = null }){
    const rows = await repoListTasks(tenantId, ownerId, { limit, cursor });
    const last = rows[rows.length - 1];
    return {
      tasks: rows,
      next_cursor: rows.length === limit && last ? `${last.created_at.toISOString()}|${last.id}` : null,
    };
  }

  parseCursor(raw){
    if (!raw) return null;
    const [createdAt, id] = String(raw).split('|');
    if (!createdAt || !id) throw new TaskValidationError('cursor 不合法');
    return { createdAt, id };
  }

  async snapshot({ tenantId, taskId, userId, isAdmin = false }){
    const task = await this.getTaskForUser({ tenantId, taskId, userId, isAdmin });
    const [plan, pendingInput, checkpoint, steps, evidenceCount] = await Promise.all([
      listPlanItems(tenantId, taskId),
      getPendingInput(tenantId, taskId),
      getLatestCheckpoint(tenantId, taskId),
      this._recentSteps(tenantId, taskId),
      countEvidence({ tenantId, taskId }),
    ]);
    const lastStep = steps[0] || null;
    return {
      id: task.id,
      title: task.title,
      goal: task.goal,
      status: task.status,
      preset: task.preset_id ? { id: task.preset_id, version: task.preset_version } : null,
      knowledge: task.input_json?.knowledge || null,
      skill: task.input_json?.skill || null,
      evidence_count: evidenceCount,
      plan: plan.map(p => ({
        item_key: p.item_key, title: p.title, description: p.description,
        status: p.status, depends_on: p.depends_on,
      })),
      current_step: lastStep ? {
        seq: Number(lastStep.seq), kind: lastStep.kind, status: lastStep.status,
        error_code: lastStep.error_code, started_at: isoOrNull(lastStep.started_at), ended_at: isoOrNull(lastStep.ended_at),
      } : null,
      pending: {
        input: pendingInput ? {
          id: pendingInput.id, question: pendingInput.question,
          input_schema: pendingInput.input_schema, expires_at: isoOrNull(pendingInput.expires_at),
        } : null,
        approval: null,
      },
      artifacts: [],
      usage: {
        steps: Number(task.usage_json?.steps || 0),
        model_calls: Number(task.usage_json?.model_calls || 0),
        tool_calls: Number(task.usage_json?.tool_calls || 0),
        input_tokens: Number(task.usage_json?.input_tokens || 0),
        output_tokens: Number(task.usage_json?.output_tokens || 0),
        wall_ms: Number(task.usage_json?.wall_ms || 0),
      },
      budget: task.budget_json,
      last_event_seq: task.event_seq,
      checkpoint_step: checkpoint ? Number(checkpoint.step_seq) : 0,
      last_error: task.last_error_code ? { code: task.last_error_code, detail: task.last_error_detail } : null,
      recovery_count: task.recovery_count,
      resume_count: task.resume_count,
      permissions: {
        can_cancel: !TERMINAL_STATUSES.has(task.status) && (task.owner_id === userId || isAdmin),
        can_resume: task.status === 'failed' && RETRYABLE_ERRORS.has(task.last_error_code || '') && (task.owner_id === userId || isAdmin),
        can_approve: false,
        can_download: false,
      },
      created_at: isoOrNull(task.created_at),
      updated_at: isoOrNull(task.updated_at),
    };
  }

  async _recentSteps(tenantId, taskId, limit = 1){
    const r = await getPool().query(
      `SELECT * FROM agent_steps WHERE tenant_id = $1 AND task_id = $2 ORDER BY seq DESC LIMIT $3`,
      [tenantId, taskId, limit],
    );
    return r.rows;
  }

  async cancelTask({ tenantId, taskId, userId, reason = 'user_cancelled', isAdmin = false }){
    return withTransaction(async client => {
      const task = await getTaskForUpdate(client, tenantId, taskId);
      assertOwner(task, userId, isAdmin);
      if (TERMINAL_STATUSES.has(task.status)) throw new TaskStateError('任务已结束，无法取消');
      if (task.status === 'cancel_requested') return task;

      if (task.status === 'running'){
        return transitionTask(client, {
          tenantId, taskId, expectStatus: 'running', expectVersion: task.version,
          to: 'cancel_requested',
          patch: { cancel_requested_at: new Date(), cancel_requested_by: userId },
          eventType: 'task.cancel_requested', eventPayload: { reason, requested_by: userId },
          actorType: 'user', actorId: userId,
        });
      }

      return transitionTask(client, {
        tenantId, taskId, expectStatus: task.status, expectVersion: task.version,
        to: 'cancelled',
        patch: { cancelled_by: userId, cancel_requested_at: new Date(), cancel_requested_by: userId },
        eventType: 'task.cancelled', eventPayload: { reason, cancelled_by: userId },
        actorType: 'user', actorId: userId,
      });
    });
  }

  async resumeTask({ tenantId, taskId, userId, reason = 'manual_resume', isAdmin = false }){
    const task = await this.getTaskForUser({ tenantId, taskId, userId, isAdmin });
    if (task.status !== 'failed') throw new TaskStateError('只有 failed 任务可以恢复');
    if (!RETRYABLE_ERRORS.has(task.last_error_code || '')) throw new TaskStateError('不可重试的错误不能恢复');
    if (task.resume_count >= 3) throw new TaskStateError('恢复次数已达上限');
    return withTransaction(client => transitionTask(client, {
      tenantId, taskId, expectStatus: 'failed', expectVersion: task.version,
      to: 'queued',
      patch: {
        ready_at: SQL_NOW, last_error_code: null, last_error_detail: null,
        attempt_count: 0, resume_count: task.resume_count + 1,
        lease_owner: null, lease_expires_at: null,
      },
      eventType: 'task.resumed', eventPayload: { reason, resume_count: task.resume_count + 1 },
      actorType: 'user', actorId: userId,
    }));
  }

  async submitInput({ tenantId, taskId, userId, requestId = null, values = {}, isAdmin = false }){
    if (values == null || typeof values !== 'object' || Array.isArray(values)) throw new TaskValidationError('values 必须是对象');
    return withTransaction(async client => {
      const task = await getTaskForUpdate(client, tenantId, taskId);
      assertOwner(task, userId, isAdmin);
      if (task.status !== 'waiting_input') throw new TaskStateError('任务不在等待输入状态');
      const params = [tenantId, taskId];
      let where = 'tenant_id = $1 AND task_id = $2 AND status = \'pending\'';
      if (requestId){ params.push(requestId); where += ` AND id = $${params.length}`; }
      const r = await client.query(`SELECT * FROM agent_input_requests WHERE ${where} FOR UPDATE LIMIT 1`, params);
      if (!r.rowCount) throw new TaskStateError('没有待处理的输入请求', 'not_found');
      const request = r.rows[0];
      if (request.expires_at && new Date(request.expires_at) < new Date()) throw new TaskStateError('输入请求已过期', 'expired');
      validateInputValues(request.input_schema || {}, values);

      await client.query(
        `UPDATE agent_input_requests SET status = 'answered', answer_json = $3::jsonb, answered_at = now(), answered_by = $4
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, request.id, JSON.stringify(values), userId],
      );
      await appendEvent(client, {
        tenantId, taskId, type: 'input.received', actorType: 'user', actorId: userId,
        payload: { input_request_id: request.id },
      });
      return transitionTask(client, {
        tenantId, taskId, expectStatus: 'waiting_input', expectVersion: task.version,
        to: 'queued',
        patch: { ready_at: SQL_NOW, lease_owner: null, lease_expires_at: null },
        eventType: 'task.queued', eventPayload: { reason: 'input_received' },
        actorType: 'user', actorId: userId,
      });
    });
  }

  async decideApproval({ tenantId, approvalId, userId, decision, argsHash, comment = '', isAdmin = false }){
    if (!['approve', 'deny'].includes(decision)) throw new TaskValidationError('decision 必须是 approve 或 deny');
    return withTransaction(async client => {
      const a = await client.query('SELECT * FROM agent_approvals WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, approvalId]);
      if (!a.rowCount) throw new TaskStateError('审批不存在', 'not_found');
      const approval = a.rows[0];
      const task = await getTaskForUpdate(client, approval.tenant_id, approval.task_id);
      assertOwner(task, userId, isAdmin);
      if (approval.status !== 'pending') throw new TaskStateError('审批已处理', 'conflict');
      if (approval.expires_at && new Date(approval.expires_at) < new Date()) throw new TaskStateError('审批已过期', 'expired');
      if (argsHash && argsHash !== approval.args_hash) throw new TaskStateError('审批参数不匹配', 'approval_args_mismatch');
      if (approval.requested_by === userId) throw new TaskForbiddenError('不能审批自己发起的请求');

      const status = decision === 'approve' ? 'approved' : 'denied';
      await client.query(
        `UPDATE agent_approvals SET status = $3, decided_by = $4, decision_comment = $5, decided_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, approval.id, status, userId, comment],
      );
      await appendEvent(client, {
        tenantId, taskId: task.id, type: 'approval.decided', actorType: 'user', actorId: userId,
        payload: { approval_id: approval.id, decision, decided_by: userId },
      });
      if (decision === 'approve'){
        await client.query(
          `UPDATE agent_tool_calls SET status = 'proposed', updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND status = 'awaiting_approval'`,
          [tenantId, approval.tool_call_id],
        );
        return transitionTask(client, {
          tenantId, taskId: task.id, expectStatus: 'waiting_approval', expectVersion: task.version,
          to: 'queued',
          patch: { ready_at: SQL_NOW, lease_owner: null, lease_expires_at: null },
          eventType: 'task.queued', eventPayload: { reason: 'approval_approved' },
          actorType: 'user', actorId: userId,
        });
      }
      return transitionTask(client, {
        tenantId, taskId: task.id, expectStatus: 'waiting_approval', expectVersion: task.version,
        to: 'cancelled',
        patch: { cancelled_by: userId, lease_owner: null, lease_expires_at: null },
        eventType: 'task.cancelled', eventPayload: { reason: 'approval_denied', approval_id: approval.id },
        actorType: 'user', actorId: userId,
      });
    });
  }

  async listApprovals({ tenantId, taskId = null, status = 'pending', ownerId = null, limit = 50 }){
    const params = [tenantId, status];
    let where = 'a.tenant_id = $1 AND a.status = $2';
    if (taskId){ params.push(taskId); where += ` AND a.task_id = $${params.length}`; }
    if (ownerId){ params.push(ownerId); where += ` AND t.owner_id = $${params.length}`; }
    params.push(Math.min(Math.max(limit, 1), 100));
    const r = await getPool().query(
      `SELECT a.* FROM agent_approvals a JOIN agent_tasks t ON t.tenant_id = a.tenant_id AND t.id = a.task_id
        WHERE ${where} ORDER BY a.created_at DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows;
  }

  /**
   * Reaper：回收过期租约、推进退避到期、使审批/输入超时失效。
   * 返回各类处理数量，便于运维观测。
   */
  async reapExpired({ workerId = 'reaper', limit = 50 } = {}){
    const stats = { recovered: 0, requeued_retry: 0, cancel_confirmed: 0, approvals_expired: 0, inputs_expired: 0 };

    // 1. retry_wait → queued（退避到期）
    const retryRows = await withTransaction(async client => {
      const sel = await client.query(
        `SELECT id, tenant_id, version FROM agent_tasks
          WHERE status = 'retry_wait' AND ready_at <= now()
          ORDER BY ready_at FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      );
      const applied = [];
      for (const row of sel.rows){
        const task = await getTaskForUpdate(client, row.tenant_id, row.id);
        const updated = await transitionTask(client, {
          tenantId: row.tenant_id, taskId: row.id, expectStatus: 'retry_wait', expectVersion: task.version,
          to: 'queued',
          patch: { ready_at: SQL_NOW, lease_owner: null, lease_expires_at: null },
          eventType: 'task.queued', eventPayload: { reason: 'retry_due' },
          actorType: 'system',
        });
        applied.push(updated);
      }
      return applied;
    });
    stats.requeued_retry = retryRows.length;

    // 2. 过期租约 → 恢复
    const expiredRows = await withTransaction(async client => {
      const sel = await client.query(
        `SELECT id, tenant_id FROM agent_tasks
          WHERE status = 'running' AND lease_expires_at < now()
          ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      );
      const applied = [];
      for (const row of sel.rows){
        const task = await getTaskForUpdate(client, row.tenant_id, row.id);
        const inFlight = await listInFlightToolCalls(row.tenant_id, row.id, client);
        const hasUnknownWrite = inFlight.some(c =>
          c.status === 'running' && c.side_effect !== 'read' && (c.idempotency || 'none') === 'none');

        for (const call of inFlight){
          if (call.attempt_id){
            await client.query(
              `UPDATE agent_tool_attempts SET status = 'unknown', ended_at = now(), error_code = 'worker_lost'
                WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
              [row.tenant_id, call.attempt_id],
            );
          }
          await client.query(
            `UPDATE agent_tool_calls SET status = 'unknown', error_code = 'worker_lost', updated_at = now()
              WHERE tenant_id = $1 AND id = $2 AND status IN ('running', 'awaiting_approval')`,
            [row.tenant_id, call.id],
          );
        }
        await client.query(
          `UPDATE agent_steps SET status = 'failed', error_code = 'worker_lost', ended_at = now()
            WHERE tenant_id = $1 AND task_id = $2 AND status = 'running'`,
          [row.tenant_id, row.id],
        );

        const resolution = hasUnknownWrite ? 'reconciliation_required' : 'requeued';
        let approvalId = null;
        if (hasUnknownWrite){
          const target = inFlight.find(c => c.side_effect !== 'read' && (c.idempotency || 'none') === 'none');
          if (target){
            const existing = await client.query(
              `SELECT id FROM agent_approvals WHERE tenant_id = $1 AND tool_call_id = $2 AND status = 'pending'`,
              [row.tenant_id, target.id],
            );
            if (existing.rowCount){
              approvalId = existing.rows[0].id;
            } else {
              const ar = await client.query(
                `INSERT INTO agent_approvals
                   (tenant_id, task_id, tool_call_id, kind, risk_level, request_payload_json, args_hash, requested_by, expires_at)
                 VALUES ($1, $2, $3, 'reconciliation', 'high', $4::jsonb, $5, $6, now() + interval '24 hours')
                 RETURNING id`,
                [row.tenant_id, row.id, target.id,
                  JSON.stringify({ reason: 'worker_lost', note: '外部写结果未知，需要人工对账' }),
                  target.args_hash, workerId],
              );
              approvalId = ar.rows[0].id;
            }
            await appendEvent(client, {
              tenantId: row.tenant_id, taskId: row.id, type: 'approval.requested', actorType: 'system',
              payload: { approval_id: approvalId, risk_level: 'high', kind: 'reconciliation' },
            });
          }
        }

        const updated = await transitionTask(client, {
          tenantId: row.tenant_id, taskId: row.id, expectStatus: 'running', expectVersion: task.version,
          to: hasUnknownWrite ? 'waiting_approval' : 'queued',
          patch: {
            lease_owner: null, lease_expires_at: null,
            ready_at: hasUnknownWrite ? task.ready_at : SQL_NOW,
            recovery_count: task.recovery_count + 1,
          },
          eventType: 'task.recovered', eventPayload: { recovery_count: task.recovery_count + 1, resolution, approval_id: approvalId },
          actorType: 'worker', actorId: workerId,
        });
        applied.push(updated);
        stats.recovered += 1;
      }
      return applied;
    });
    void expiredRows;

    // 2b. 取消请求已发出但 Worker 已死：由 Reaper 确认取消。
    stats.cancel_confirmed = await withTransaction(async client => {
      const sel = await client.query(
        `SELECT id, tenant_id FROM agent_tasks
          WHERE status = 'cancel_requested' AND (lease_expires_at IS NULL OR lease_expires_at < now())
          ORDER BY cancel_requested_at FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      );
      let n = 0;
      for (const row of sel.rows){
        const task = await getTaskForUpdate(client, row.tenant_id, row.id);
        if (!task || task.status !== 'cancel_requested') continue;
        await client.query(
          `UPDATE agent_steps SET status = 'failed', error_code = 'cancelled', ended_at = now()
            WHERE tenant_id = $1 AND task_id = $2 AND status = 'running'`,
          [row.tenant_id, row.id],
        );
        await transitionTask(client, {
          tenantId: row.tenant_id, taskId: row.id,
          expectStatus: 'cancel_requested', expectVersion: task.version,
          to: 'cancelled',
          patch: { cancelled_by: task.cancel_requested_by || 'reaper', lease_owner: null, lease_expires_at: null },
          eventType: 'task.cancelled', eventPayload: { reason: 'cancel_confirmed_by_reaper' },
          actorType: 'worker', actorId: workerId,
        });
        n += 1;
      }
      return n;
    });

    // 3. 审批超时
    stats.approvals_expired = await withTransaction(async client => {
      const sel = await client.query(
        `SELECT id, tenant_id, task_id FROM agent_approvals
          WHERE status = 'pending' AND expires_at < now()
          ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      );
      let n = 0;
      for (const a of sel.rows){
        await client.query(`UPDATE agent_approvals SET status = 'expired' WHERE tenant_id = $1 AND id = $2`, [a.tenant_id, a.id]);
        const task = await getTaskForUpdate(client, a.tenant_id, a.task_id);
        if (task && task.status === 'waiting_approval'){
          await appendEvent(client, {
            tenantId: a.tenant_id, taskId: a.task_id, type: 'approval.decided', actorType: 'system',
            payload: { approval_id: a.id, decision: 'expired' },
          });
          await transitionTask(client, {
            tenantId: a.tenant_id, taskId: a.task_id, expectStatus: 'waiting_approval', expectVersion: task.version,
            to: 'failed',
            patch: { last_error_code: 'approval_expired', last_error_detail: '审批超时', lease_owner: null, lease_expires_at: null },
            eventType: 'task.failed', eventPayload: { error_code: 'approval_expired', message: '审批超时' },
            actorType: 'system',
          });
          n += 1;
        }
      }
      return n;
    });

    // 4. 输入超时
    stats.inputs_expired = await withTransaction(async client => {
      const sel = await client.query(
        `SELECT id, tenant_id, task_id FROM agent_input_requests
          WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < now()
          ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      );
      let n = 0;
      for (const input of sel.rows){
        await client.query(`UPDATE agent_input_requests SET status = 'expired' WHERE tenant_id = $1 AND id = $2`, [input.tenant_id, input.id]);
        const task = await getTaskForUpdate(client, input.tenant_id, input.task_id);
        if (task && task.status === 'waiting_input'){
          await transitionTask(client, {
            tenantId: input.tenant_id, taskId: input.task_id, expectStatus: 'waiting_input', expectVersion: task.version,
            to: 'failed',
            patch: { last_error_code: 'input_timeout', last_error_detail: '输入超时', lease_owner: null, lease_expires_at: null },
            eventType: 'task.failed', eventPayload: { error_code: 'input_timeout', message: '输入超时' },
            actorType: 'system',
          });
          n += 1;
        }
      }
      return n;
    });

    return stats;
  }
}

export function validateInputValues(schema, values){
  const properties = schema?.properties || {};
  const keys = Object.keys(values);
  for (const key of keys){
    if (!(key in properties)) throw new TaskValidationError(`未知输入字段：${key}`);
  }
  for (const [key, field] of Object.entries(properties)){
    const value = values[key];
    const required = field.required === true;
    if (value == null){
      if (required) throw new TaskValidationError(`缺少必填字段：${key}`);
      continue;
    }
    switch (field.type){
      case 'string':
        if (typeof value !== 'string') throw new TaskValidationError(`${key} 必须是字符串`);
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new TaskValidationError(`${key} 必须是数字`);
        break;
      case 'integer':
        if (!Number.isInteger(value)) throw new TaskValidationError(`${key} 必须是整数`);
        break;
      case 'boolean':
        if (typeof value !== 'boolean') throw new TaskValidationError(`${key} 必须是布尔值`);
        break;
      case 'string[]':
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new TaskValidationError(`${key} 必须是字符串数组`);
        break;
      default:
        throw new TaskValidationError(`${key} 的类型不受支持`);
    }
  }
}
