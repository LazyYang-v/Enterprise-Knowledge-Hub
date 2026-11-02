// 任务执行器：每个 Step 一次模型调用，严格解析为 AgentAction。
// 工具调用必须先通过任务快照、schema 与 PolicyEngine，再持久化后执行。
import { completeModel } from '../agent/model-adapter.js';
import { parseAgentAction, ActionValidationError } from '../agent/actions.js';
import { buildAgentSystemPrompt } from '../agent/context-builder.js';
import {
  getTask,
  getTaskForUpdate,
  startStep,
  finishStep,
  completeTask,
  recordPlan,
  appendMessage,
  listMessages,
  listPlanItems,
  saveCheckpoint,
  transitionTask,
  createInputRequest,
  createToolCall,
  startToolAttempt,
  finishToolAttempt,
  finishToolCall,
  getToolCall,
  listToolCalls,
  getPendingApproval,
  getApprovedToolApproval,
  consumeApproval,
  createApproval,
  appendEvent,
} from './task-repo.js';
import { withTransaction } from './pg.js';
import { DEFAULT_BUDGET, RETRYABLE_ERRORS } from './task-service.js';
import { config } from '../config.js';
import { getEvidenceByIds } from './evidence-repo.js';
import { createToolExecutor } from '../tools/executor.js';
import { getArtifactService } from '../artifacts/service.js';
import { PolicyDeniedError } from '../tools/policy.js';
import { ToolSchemaError } from '../tools/schema.js';
import { hashArgs } from '../tools/contract.js';
import { toolMessageContent } from '../tools/result.js';
import { scanSecrets } from '../skills/secret-scan.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACTION_INSTRUCTION = [
  '你必须只输出一个 JSON 对象作为本轮动作，不要输出 Markdown 或解释。可用类型：',
  '{"type":"plan","plan_items":[{"item_key":"k1","title":"...","completion_criteria":"..."}]}',
  '{"type":"call_tool","tool_name":"...","arguments":{}}',
  '{"type":"ask_user","question":"...","input_schema":{"type":"object","properties":{"field":{"type":"string","required":true}}}}',
  '{"type":"finish","summary":"...","artifact_refs":[],"citations":["<evidence_id>"]}',
  '{"type":"fail","error_code":"lower_snake_case","message":"..."}',
].join('\n');

export class TaskExecutionError extends Error {
  constructor(code, message, { retryable = false } = {}){
    super(message);
    this.name = 'TaskExecutionError';
    this.code = code;
    this.retryable = retryable;
  }
}

function classifyError(e){
  if (e instanceof TaskExecutionError) return e;
  if (e instanceof ActionValidationError){
    return new TaskExecutionError('model_invalid_output', e.message, { retryable: true });
  }
  const code = e?.code || 'internal_error';
  return new TaskExecutionError(code, e?.message || String(e), { retryable: RETRYABLE_ERRORS.has(code) });
}

function budgetOf(task){
  return { ...DEFAULT_BUDGET, ...(task.budget_json || {}) };
}

function wallMs(task){
  const created = task.created_at instanceof Date ? task.created_at.getTime() : Date.parse(task.created_at);
  return Number.isFinite(created) ? Date.now() - created : 0;
}

async function persistUsage(task, workerId, usage){
  return withTransaction(client => transitionTask(client, {
    tenantId: task.tenant_id, taskId: task.id, workerId, leaseEpoch: task.lease_epoch,
    expectStatus: 'running', expectVersion: task.version,
    to: 'running',
    patch: { usage_json: usage },
  }));
}

async function emit(task, type, payload, actorType = 'worker', actorId = null){
  await withTransaction(client => appendEvent(client, {
    tenantId: task.tenant_id, taskId: task.id, type, payload, actorType, actorId,
  }));
}

async function failTask(task, workerId, code, message){
  await withTransaction(client => transitionTask(client, {
    tenantId: task.tenant_id, taskId: task.id, workerId, leaseEpoch: task.lease_epoch,
    expectStatus: 'running', expectVersion: task.version,
    to: 'failed',
    patch: {
      last_error_code: code, last_error_detail: message,
      lease_owner: null, lease_expires_at: null,
    },
    eventType: 'task.failed', eventPayload: { error_code: code, message },
    actorType: 'worker', actorId: workerId,
  }));
}

async function cancelByWorker(task, workerId){
  return withTransaction(client => transitionTask(client, {
    tenantId: task.tenant_id, taskId: task.id, workerId, leaseEpoch: task.lease_epoch,
    expectStatus: 'running', expectVersion: task.version,
    to: 'cancelled',
    patch: { cancelled_by: 'worker', lease_owner: null, lease_expires_at: null },
    eventType: 'task.cancelled', eventPayload: { reason: 'cancel_requested' },
    actorType: 'worker', actorId: workerId,
  }));
}

async function finalizeCancel(task, workerId){
  return withTransaction(client => transitionTask(client, {
    tenantId: task.tenant_id, taskId: task.id, workerId, leaseEpoch: task.lease_epoch,
    expectStatus: 'cancel_requested', expectVersion: task.version,
    to: 'cancelled',
    patch: { cancelled_by: 'worker', lease_owner: null, lease_expires_at: null },
    eventType: 'task.cancelled', eventPayload: { reason: 'cancel_requested', confirmed_by: workerId },
    actorType: 'worker', actorId: workerId,
  }));
}

function buildMessages(goal, plan, history, { skill = '', evidence = [], toolCatalog = '', artifactCatalog = '' } = {}){
  const planLines = plan.map(p => ({ title: p.title, status: p.status }));
  const system = [
    buildAgentSystemPrompt({ goal, plan: planLines, evidence }),
    ACTION_INSTRUCTION,
    toolCatalog ? `=== ALLOWED TOOLS ===\n${toolCatalog}` : '',
    artifactCatalog ? `=== TASK ARTIFACTS (untrusted metadata) ===\n${artifactCatalog}` : '',
  ].filter(Boolean).join('\n\n');
  const messages = [{ role: 'system', content: skill ? `${system}\n\n=== SKILL ===\n${skill}` : system }, { role: 'user', content: goal }];
  for (const m of history){
    if (!m.content) continue;
    if (m.role === 'tool'){
      messages.push({ role: 'user', content: m.content });
      continue;
    }
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  return messages;
}

function toolCatalogText(executor){
  if (!executor) return '';
  const lines = [];
  for (const tool of executor.snapshots){
    lines.push([
      `- ${tool.name}@${tool.version} [${tool.side_effect}/${tool.approval_policy}]`,
      tool.source === 'custom' || tool.source === 'mcp' ? '（不可信描述）' : '',
      tool.description ? `：${tool.description}` : '',
      `\n  input_schema: ${JSON.stringify(tool.input_schema).slice(0, 3000)}`,
    ].join(''));
  }
  const text = lines.join('\n');
  return text.length > config.tools.catalogMaxChars
    ? text.slice(0, config.tools.catalogMaxChars) + '\n…(工具目录已截断)'
    : text;
}

function cleanLabel(value, max = 120){
  return String(value || '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').slice(0, max);
}

/** 当前任务成果目录：只注入 ID/名称/类型/大小，绝不注入内容。 */
async function artifactCatalogText(task){
  try {
    const list = await getArtifactService().listForPrompt({
      tenantId: task.tenant_id, taskId: task.id, limit: 50,
    });
    if (!list.length) return '';
    const text = list.map(a => (
      `- ${a.id} [${a.kind} v${a.version}] ${cleanLabel(a.name)} (${cleanLabel(a.mime, 80)}, ${a.size_bytes}B)`
    )).join('\n');
    return text.length > 2000 ? text.slice(0, 2000) + '\n…(成果目录已截断)' : text;
  } catch {
    return '';
  }
}

function locatorText(locator){
  if (!locator) return '';
  if (typeof locator === 'string') return locator;
  const parts = [];
  if (locator.page != null) parts.push(`第 ${locator.page} 页`);
  if (locator.sheet) parts.push(`工作表 ${locator.sheet}`);
  if (locator.slide != null) parts.push(`幻灯片 ${locator.slide}`);
  if (locator.char_start != null) parts.push(`字符 ${locator.char_start}-${locator.char_end}`);
  if (!parts.length && locator.chunk_index != null) parts.push(`分块 ${locator.chunk_index}`);
  return parts.join('，');
}

function scopeFromSnapshot(snapshot){
  return {
    mode: snapshot.mode || 'explicit',
    kbIds: Array.isArray(snapshot.effective_kb_ids) ? snapshot.effective_kb_ids : [],
    documentIds: Array.isArray(snapshot.input_doc_ids) ? snapshot.input_doc_ids : [],
    sessionId: snapshot.session_id || null,
    versionPolicy: snapshot.version_policy === 'latest' ? 'latest' : 'pin_on_first_use',
    reducedCount: Number(snapshot.reduced_count) || 0,
    scopeHash: snapshot.scope_hash || '',
  };
}

async function loadSkillInstructions(task, skillLoader){
  const ref = task.input_json?.skill;
  if (!ref) return '';
  if (!skillLoader) throw new TaskExecutionError('skill_unavailable', 'Worker 未配置 Skill 加载器', { retryable: false });
  try {
    const loaded = await skillLoader({
      skillId: ref.id, version: ref.version, contentHash: ref.content_hash,
    });
    if (!loaded?.instructions) throw new Error('Skill instructions 为空');
    return String(loaded.instructions);
  } catch (e){
    if (e instanceof TaskExecutionError) throw e;
    const permanent = e?.code === 'skill_version_conflict' || e?.code === 'skill_unavailable';
    throw new TaskExecutionError('skill_unavailable', `Skill 加载失败：${e.message}`, { retryable: !permanent });
  }
}

async function createKnowledgeContext(task, knowledgeFactory){
  const snapshot = task.input_json?.knowledge;
  if (!snapshot) return null;
  const hasScope = (snapshot.effective_kb_ids?.length || snapshot.input_doc_ids?.length || snapshot.session_id);
  if (!hasScope) return null; // 空范围任务不加载知识面，保持 Worker 与 SQLite 解耦
  if (!knowledgeFactory){
    throw new TaskExecutionError('knowledge_unavailable', 'Worker 未配置知识库服务', { retryable: false });
  }
  try {
    const service = await knowledgeFactory({ task });
    if (!service) throw new Error('知识库服务不可用');
    return { service, scope: scopeFromSnapshot(snapshot) };
  } catch (e){
    if (e instanceof TaskExecutionError) throw e;
    throw new TaskExecutionError('knowledge_unavailable', e.message, { retryable: false });
  }
}

/**
 * 执行一个已被 Worker 领取的任务。
 * 返回 { status }；可重试错误抛出 TaskExecutionError，由 Worker 决定重试/失败。
 */
export async function executeTask(task, {
  workerId, model, signal, log = () => {}, knowledgeFactory = null, skillLoader = null, toolFactory = null,
} = {}){
  if (!model) throw new TaskExecutionError('model_unavailable', 'Worker 未配置任务模型', { retryable: false });
  if (task.lease_epoch == null) throw new TaskExecutionError('lease_lost', '任务缺少领取标识', { retryable: false });
  // 固定本次领取的 fencing epoch；重载任务后 epoch 变化即表示领取已被回收。
  const leaseEpoch = task.lease_epoch;
  let current = task;
  const budget = budgetOf(current);
  const evidenceMax = config.knowledge.evidenceMax;
  const skillInstructions = await loadSkillInstructions(current, skillLoader);
  const knowledge = await createKnowledgeContext(current, knowledgeFactory);
  const hasToolSnapshot = Array.isArray(current.input_json?.tools) && current.input_json.tools.length > 0;
  let toolExecutor = null;

  async function ensureToolExecutor(){
    if (!hasToolSnapshot) return null;
    if (toolExecutor) return toolExecutor;
    // Worker 未配置工具执行器时，仍可执行不调用工具的旧任务；
    // 若模型真的发起 call_tool，会在该分支以 tool_unavailable 失败。
    if (!toolFactory) return null;
    toolExecutor = await toolFactory({ task: current, knowledge, signal });
    return toolExecutor;
  }

  async function appendToolResult(taskObj, name, result){
    const content = `工具 ${name} ${result.status === 'succeeded' ? '返回' : '失败'}：\n${toolMessageContent(result)}`;
    const message = await appendMessage({
      tenantId: taskObj.tenant_id, taskId: taskObj.id, role: 'tool', content,
      actorId: workerId, leaseEpoch,
    });
    await emit(taskObj, 'message.created', {
      role: 'tool', seq: message.seq, tool_name: name, content_preview: result.content.slice(0, 200),
    }, 'system');
  }
  let evidenceForPrompt = [];
  const evidenceIds = new Set();
  let retrievalCount = 0;
  let refreshPending = true;

  async function retrieveForPrompt(taskObj, plan){
    if (!knowledge || retrievalCount >= 2 || !(retrievalCount === 0 || refreshPending)) return;
    refreshPending = false;
    const query = retrievalCount === 0
      ? taskObj.goal
      : [taskObj.goal, ...plan.map(p => p.title)].join('\n');
    retrievalCount += 1;
    let result;
    try {
      result = await knowledge.service.search({
        actor: { userId: taskObj.owner_id, tenantId: taskObj.tenant_id, principalType: 'user' },
        scope: knowledge.scope,
        query,
        topK: evidenceMax,
        taskId: taskObj.id,
        leaseEpoch,
      });
    } catch (e){
      if (e instanceof TaskExecutionError) throw e;
      throw new TaskExecutionError('knowledge_unavailable', `知识检索失败：${e.message}`, {
        retryable: e?.retryable !== false,
      });
    }
    evidenceForPrompt = result.evidence.map(e => ({
      evidence_id: e.evidence_id,
      title: e.title,
      kb_name: e.kb_name,
      document_version: e.document_version,
      locator: locatorText(e.locator),
      excerpt: e.excerpt,
    }));
    for (const e of result.evidence){
      if (e.evidence_id) evidenceIds.add(e.evidence_id);
    }
    if (result.newEvidence.length){
      await emit(taskObj, 'evidence.retrieved', {
        count: result.evidence.length,
        new_count: result.newEvidence.length,
        evidence_ids: result.evidence.map(e => e.evidence_id).filter(Boolean),
        degraded: !!result.degraded,
        capped: !!result.candidateCapped,
      }, 'system');
    }
    for (const change of result.versionChanges || []){
      await emit(taskObj, 'evidence.version_changed', change, 'system');
    }
    const baseReduced = Number(knowledge.scope.reducedCount) || 0;
    if (result.reducedCount > baseReduced){
      await emit(taskObj, 'policy.scope_reduced', {
        reduced_count: result.reducedCount, source: 'runtime',
      }, 'system');
    }
  }

  const usage = {
    steps: Number(current.usage_json?.steps || 0),
    model_calls: Number(current.usage_json?.model_calls || 0),
    tool_calls: Number(current.usage_json?.tool_calls || 0),
    input_tokens: Number(current.usage_json?.input_tokens || 0),
    output_tokens: Number(current.usage_json?.output_tokens || 0),
  };

  // 审批恢复：先执行已批准但未消费的调用，再进入模型循环。
  async function resumeApprovedToolCall(){
    if (!hasToolSnapshot) return;
    const approval = await getApprovedToolApproval(current.tenant_id, current.id);
    if (!approval) return;
    const executor = await ensureToolExecutor();
    if (!executor) return;
    executor.setTask?.(current);
    let resumed;
    try {
      resumed = await withTransaction(async client => {
        const fresh = await getTaskForUpdate(client, current.tenant_id, current.id);
        if (!fresh || fresh.status !== 'running' || fresh.lease_owner !== workerId
          || fresh.lease_epoch !== leaseEpoch) return null;
        const a = await client.query(
          `SELECT * FROM agent_approvals WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [current.tenant_id, approval.id],
        );
        if (!a.rowCount) return null;
        const row = a.rows[0];
        if (row.status !== 'approved' || row.consumed_at || row.kind !== 'tool_call') return null;
        const c = await client.query(
          `SELECT * FROM agent_tool_calls WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [current.tenant_id, row.tool_call_id],
        );
        if (!c.rowCount) return null;
        const call = c.rows[0];
        const expired = row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
        if (expired){
          await client.query(
            `UPDATE agent_approvals SET status = 'expired', decided_at = now()
              WHERE tenant_id = $1 AND id = $2 AND status = 'approved' AND consumed_at IS NULL`,
            [current.tenant_id, row.id],
          );
          await client.query(
            `UPDATE agent_tool_calls SET status = 'failed', error_code = 'approval_expired', updated_at = now()
              WHERE tenant_id = $1 AND id = $2 AND status = 'awaiting_approval'`,
            [current.tenant_id, row.tool_call_id],
          );
          await appendEvent(client, {
            tenantId: current.tenant_id, taskId: current.id, type: 'approval.decided',
            actorType: 'system', actorId: workerId,
            payload: { approval_id: row.id, decision: 'expired', tool_call_id: call.id },
          });
          return { expired: true, call };
        }
        if (call.status !== 'awaiting_approval' || call.args_hash !== row.args_hash){
          await client.query(
            `UPDATE agent_tool_calls SET status = 'failed', error_code = 'approval_args_mismatch', updated_at = now()
              WHERE tenant_id = $1 AND id = $2`,
            [current.tenant_id, call.id],
          );
          return { mismatch: true, call };
        }
        const consumed = await consumeApproval(client, {
          tenantId: current.tenant_id, approvalId: row.id, userId: workerId,
        });
        if (!consumed) return null;
        await client.query(
          `UPDATE agent_tool_calls SET status = 'running', updated_at = now()
            WHERE tenant_id = $1 AND id = $2`,
          [current.tenant_id, call.id],
        );
        await appendEvent(client, {
          tenantId: current.tenant_id, taskId: current.id, type: 'tool.started',
          actorType: 'worker', actorId: workerId,
          payload: { tool_call_id: call.id, tool_name: call.tool_name, approval_id: row.id, resumed: true },
        });
        return { call, approval: row };
      });
    } catch (e){
      log(`approval resume skipped: ${e.message}`);
      return;
    }
    if (!resumed) return;
    if (resumed.expired){
      await emit(current, 'tool.failed', {
        tool_call_id: resumed.call.id, tool_name: resumed.call.tool_name,
        error_code: 'approval_expired', retryable: false,
      }, 'system');
      await appendToolResult(current, resumed.call.tool_name, {
        status: 'failed', content: '审批已过期，工具未执行', untrusted: false,
      });
      current = await persistUsage(current, workerId, usage).catch(() => current);
      return;
    }
    if (resumed.mismatch){
      await appendToolResult(current, resumed.call.tool_name, {
        status: 'failed', content: '审批参数与工具调用不匹配', untrusted: false,
      });
      current = await persistUsage(current, workerId, usage).catch(() => current);
      return;
    }

    const { call } = resumed;
    const snapshot = executor.findSnapshot(call.tool_name);
    let result;
    let attemptId = null;
    if (!snapshot){
      result = { status: 'failed', content: '工具不在任务快照内', untrusted: false, error_code: 'tool_not_found' };
    } else if (hashArgs(call.args_json || {}) !== call.args_hash){
      result = { status: 'failed', content: '工具参数哈希不一致', untrusted: false, error_code: 'approval_args_mismatch' };
    } else {
      try {
        const descriptor = await executor.pinned(snapshot);
        const attempt = await startToolAttempt({
          tenantId: current.tenant_id, toolCallId: call.id, attemptNo: 1,
          workerId, leaseEpoch,
        });
        attemptId = attempt.id;
        result = await executor.execute(descriptor, call.args_json || {}, {
          toolCallId: call.id, stepId: call.step_id,
        });
        await finishToolAttempt({
          tenantId: current.tenant_id, attemptId: attempt.id,
          status: result.status === 'succeeded' ? 'succeeded' : 'failed',
          errorCode: result.error_code || null, resultHash: result.result_hash || null,
          workerId, leaseEpoch,
        });
      } catch (e){
        result = {
          status: 'failed', content: e.message || String(e), untrusted: false,
          error_code: e.code || 'tool_execution_failed',
        };
      }
    }
    await finishToolCall({
      tenantId: current.tenant_id, toolCallId: call.id, status: result.status,
      errorCode: result.error_code || null,
      resultPreview: String(result.content || '').slice(0, 500),
      resultHash: result.result_hash || null,
      workerId, leaseEpoch, attemptId,
    });
    await emit(current, result.status === 'succeeded' ? 'tool.completed' : 'tool.failed', {
      tool_call_id: call.id, tool_name: call.tool_name,
      error_code: result.error_code || null, retryable: false,
    }, 'system');
    await appendToolResult(current, call.tool_name, result);
    usage.tool_calls += 1;
    current = await persistUsage(current, workerId, usage).catch(() => current);
  }

  await resumeApprovedToolCall();

  while (true){
    current = await getTask(current.tenant_id, current.id);
    if (!current) return { status: 'unknown' };
    if (current.lease_epoch !== leaseEpoch) return { status: 'lease_lost' };
    if (current.status === 'cancel_requested'){
      await finalizeCancel(current, workerId);
      return { status: 'cancelled' };
    }
    if (current.status !== 'running') return { status: current.status };
    if (signal?.aborted) return { status: 'aborted' };
    if (current.cancel_requested_at){
      await cancelByWorker(current, workerId);
      return { status: 'cancelled' };
    }
    if (usage.steps >= budget.max_steps){
      throw new TaskExecutionError('budget_exhausted', `Step 预算已用尽（${budget.max_steps}）`);
    }
    if (wallMs(current) >= budget.max_wall_ms){
      throw new TaskExecutionError('budget_exhausted', `墙钟预算已用尽（${budget.max_wall_ms}ms）`);
    }

    const { task: startedTask, step } = await startStep({
      tenantId: current.tenant_id, taskId: current.id, workerId, leaseEpoch,
      expectVersion: current.version, kind: 'model_turn',
    });
    current = startedTask;

    let raw;
    try {
      const plan = await listPlanItems(current.tenant_id, current.id);
      await retrieveForPrompt(current, plan);
      const executor = await ensureToolExecutor();
      executor?.setTask?.(current);
      const history = await listMessages(current.tenant_id, current.id, 20);
      const messages = buildMessages(current.goal, plan, history, {
        skill: skillInstructions, evidence: evidenceForPrompt,
        toolCatalog: toolCatalogText(executor),
        artifactCatalog: await artifactCatalogText(current),
      });
      const timeoutSignal = AbortSignal.timeout(budget.model_timeout_ms);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      raw = await completeModel(model, messages, { temperature: 0.2, signal: combined });
      usage.model_calls += 1;
      usage.steps += 1;
    } catch (e){
      await finishStep({
        tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch,
        status: 'failed', errorCode: e?.code || 'model_error',
      });
      throw classifyError(e);
    }

    if (!raw || !String(raw).trim()){
      await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'failed', errorCode: 'model_invalid_output' });
      throw new TaskExecutionError('model_invalid_output', '模型返回空内容', { retryable: true });
    }

    const message = await appendMessage({
      tenantId: current.tenant_id, taskId: current.id, role: 'assistant',
      content: String(raw).slice(0, 20000), actorId: workerId, leaseEpoch,
    });
    await emit(current, 'message.created', { role: 'assistant', seq: message.seq, content_preview: String(raw).slice(0, 200) }, 'model');

    let action;
    try {
      action = parseAgentAction(raw, {
        allowedTools: toolExecutor ? new Set(toolExecutor.names()) : null,
      });
    } catch (e){
      await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'failed', errorCode: 'model_invalid_output' });
      current = await persistUsage(current, workerId, usage).catch(() => current);
      saveCheckpointLater(current, step.seq);
      throw classifyError(e);
    }

    // 安全点：模型调用结束后再次检查取消。
    current = await getTask(current.tenant_id, current.id);
    if (!current) return { status: 'unknown' };
    if (current.lease_epoch !== leaseEpoch) return { status: 'lease_lost' };
    if (current.status === 'cancel_requested'){
      await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'failed', errorCode: 'cancelled' });
      await finalizeCancel(current, workerId);
      return { status: 'cancelled' };
    }
    if (current.status !== 'running') return { status: current.status };
    if (current.cancel_requested_at){
      await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'failed', errorCode: 'cancelled' });
      await cancelByWorker(current, workerId);
      return { status: 'cancelled' };
    }

    switch (action.type){
      case 'plan': {
        current = await recordPlan({
          tenantId: current.tenant_id, taskId: current.id, workerId, leaseEpoch,
          expectVersion: current.version, items: action.plan_items,
        });
        await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'completed' });
        current = await persistUsage(current, workerId, usage);
        await saveCheckpoint({
          tenantId: current.tenant_id, taskId: current.id, stepSeq: Number(step.seq), leaseEpoch,
          state: { plan_version: current.plan_version, usage },
        });
        log(`task ${current.id} plan v${current.plan_version}`);
        refreshPending = true; // 首次 plan 后允许再检索一次（goal + plan titles）
        continue;
      }
      case 'ask_user': {
        await createInputRequest({
          tenantId: current.tenant_id, taskId: current.id, stepId: step.id,
          question: action.question, inputSchema: action.input_schema,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'completed' });
        const updated = await withTransaction(client => transitionTask(client, {
          tenantId: current.tenant_id, taskId: current.id, workerId, leaseEpoch,
          expectStatus: 'running', expectVersion: current.version,
          to: 'waiting_input',
          patch: { lease_owner: null, lease_expires_at: null, usage_json: usage },
          eventType: 'task.waiting_input', eventPayload: { question: action.question },
          actorType: 'worker', actorId: workerId,
        }));
        await saveCheckpoint({
          tenantId: updated.tenant_id, taskId: updated.id, stepSeq: Number(step.seq), leaseEpoch,
          state: { waiting: 'input', usage },
        });
        return { status: 'waiting_input' };
      }
      case 'finish': {
        // ResultVerifier：有未终结工具调用/待审批时不得声明完成。
        const calls = await listToolCalls({ tenantId: current.tenant_id, taskId: current.id });
        const open = calls.filter(c => ['proposed', 'running', 'awaiting_approval'].includes(c.status));
        const pendingApproval = await getPendingApproval(current.tenant_id, current.id);
        if (open.length || pendingApproval){
          await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'failed', errorCode: 'tool_state_inconsistent' });
          throw new TaskExecutionError('tool_state_inconsistent', '存在未完成的工具调用或审批，不能结束任务', { retryable: false });
        }
        if (scanSecrets(action.summary, 'agent_output').length){
          await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'failed', errorCode: 'secret_detected' });
          throw new TaskExecutionError('secret_detected', '输出疑似包含密钥，已拒绝写入结果', { retryable: false });
        }
        const citationIds = [...new Set(action.citations || [])];
        if (citationIds.length){
          const invalid = citationIds.filter(id => !UUID_RE.test(id));
          if (invalid.length){
            await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'failed', errorCode: 'model_invalid_output' });
            throw new TaskExecutionError('model_invalid_output', 'citations 含非法的 evidence_id', { retryable: true });
          }
          let rows;
          try {
            rows = await getEvidenceByIds({
              tenantId: current.tenant_id, taskId: current.id, ids: citationIds, leaseEpoch,
            });
          } catch (e){
            await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'failed', errorCode: 'knowledge_unavailable' });
            throw new TaskExecutionError('knowledge_unavailable', `引用校验失败：${e.message}`, { retryable: true });
          }
          if (rows.length !== citationIds.length){
            await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'failed', errorCode: 'model_invalid_output' });
            throw new TaskExecutionError('model_invalid_output', 'citations 引用了不属于当前领取的证据', { retryable: true });
          }
        }
        const artifactIds = [...new Set(action.artifact_refs || [])];
        if (artifactIds.length){
          try {
            await getArtifactService().assertFinishRefs({
              tenantId: current.tenant_id, taskId: current.id, ids: artifactIds,
            });
          } catch (e){
            await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'failed', errorCode: 'model_invalid_output' });
            throw new TaskExecutionError('model_invalid_output', `artifact_refs 非法或不属于当前任务：${e.message}`, { retryable: true });
          }
        }
        try {
          await completeTask({
            tenantId: current.tenant_id, taskId: current.id, workerId, leaseEpoch,
            stepId: step.id, stepSeq: Number(step.seq),
            summary: action.summary, citations: citationIds,
            evidenceIds: [...evidenceIds], artifactIds,
            usage,
            checkpointState: { finished: true, summary: action.summary, citations: citationIds, artifact_ids: artifactIds, usage },
          });
        } catch (e){
          if (e.code === 'evidence_conflict'){
            throw new TaskExecutionError('model_invalid_output', 'citations 引用了不属于当前领取的证据', { retryable: true });
          }
          if (e.code === 'artifact_conflict'){
            throw new TaskExecutionError('model_invalid_output', 'artifact_refs 引用了不属于当前任务的成果', { retryable: true });
          }
          throw e;
        }
        return { status: 'completed' };
      }
      case 'fail': {
        await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'failed', errorCode: action.error_code });
        await failTask(current, workerId, action.error_code, action.message);
        return { status: 'failed' };
      }
      case 'call_tool': {
        const executor = await ensureToolExecutor();
        if (!executor){
          await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'failed', errorCode: 'tool_unavailable' });
          await failTask(current, workerId, 'tool_unavailable', '任务没有工具快照');
          return { status: 'failed' };
        }
        executor.setTask?.(current);
        let prepared;
        try {
          prepared = await executor.prepare(action.tool_name, action.arguments);
        } catch (e){
          const snapshot = executor.findSnapshot(action.tool_name);
          const hash = hashArgs(action.arguments || {});
          const call = await createToolCall({
            tenantId: current.tenant_id, taskId: current.id, stepId: step.id,
            toolName: action.tool_name, toolVersion: snapshot?.version || '',
            source: snapshot?.source || 'builtin', args: action.arguments || {}, argsHash: hash,
            sideEffect: snapshot?.side_effect || 'read', status: 'failed',
            codeHash: snapshot?.code_hash || '',
          });
          const errorCode = e.code || (e instanceof ToolSchemaError ? 'tool_schema_mismatch' : 'tool_failed');
          await finishToolCall({ tenantId: current.tenant_id, toolCallId: call.id, status: 'failed', errorCode, workerId, leaseEpoch });
          await emit(current, 'policy.denied', {
            tool_call_id: call.id, tool_name: action.tool_name, reason: errorCode,
            fatal: !!e.fatal, args_hash: hash,
          }, 'system');
          await emit(current, 'tool.failed', {
            tool_call_id: call.id, tool_name: action.tool_name, error_code: errorCode, retryable: false,
          }, 'system');
          await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'completed' });
          if (e.fatal){
            await failTask(current, workerId, 'budget_exhausted', `预算已用尽：${e.message}`);
            return { status: 'failed' };
          }
          await appendToolResult(current, action.tool_name, {
            status: 'failed', content: `工具调用被拒绝：${errorCode}`, untrusted: false, error_code: errorCode,
          });
          current = await persistUsage(current, workerId, usage).catch(() => current);
          continue;
        }

        const { current: descriptor, decision } = prepared;
        const hash = hashArgs(action.arguments || {});
        const approvalNeeded = decision.decision === 'approval';
        const callStatus = approvalNeeded ? 'awaiting_approval' : 'proposed';
        const idempotencyKey = descriptor.source === 'builtin' && descriptor.side_effect === 'write_workspace'
          ? `${action.tool_name}:${hash}:${step.id}:${Number(usage.tool_calls || 0)}`
          : null;
        const call = await createToolCall({
          tenantId: current.tenant_id, taskId: current.id, stepId: step.id,
          toolName: action.tool_name, toolVersion: descriptor.version, source: descriptor.source,
          args: action.arguments || {}, argsHash: hash, sideEffect: descriptor.side_effect,
          status: callStatus, codeHash: descriptor.code_hash || '', idempotencyKey,
        });
        await emit(current, 'tool.requested', {
          tool_call_id: call.id, tool_name: action.tool_name,
          tool_version: descriptor.version, args_hash: hash,
          side_effect: descriptor.side_effect, decision: decision.decision,
        }, 'model');

        if (approvalNeeded){
          const ttl = decision.riskLevel === 'high'
            ? config.tools.highRiskApprovalTtlMs : config.tools.approvalTtlMs;
          const approval = await createApproval({
            tenantId: current.tenant_id, taskId: current.id, toolCallId: call.id,
            kind: 'tool_call', riskLevel: decision.riskLevel,
            requestPayload: {
              tool_name: action.tool_name, tool_version: descriptor.version,
              side_effect: descriptor.side_effect, approval_mode: decision.approvalMode,
              args_hash: hash, input_schema: descriptor.input_schema,
            },
            argsHash: hash, requestedBy: `agent:${workerId}`,
            expiresAt: new Date(Date.now() + ttl),
          });
          await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'completed' });
          const updated = await withTransaction(client => transitionTask(client, {
            tenantId: current.tenant_id, taskId: current.id, workerId, leaseEpoch,
            expectStatus: 'running', expectVersion: current.version,
            to: 'waiting_approval',
            patch: { lease_owner: null, lease_expires_at: null, usage_json: usage },
            eventType: 'task.waiting_approval',
            eventPayload: { approval_id: approval.id, tool_call_id: call.id, risk_level: decision.riskLevel },
            actorType: 'worker', actorId: workerId,
          }));
          await saveCheckpoint({
            tenantId: updated.tenant_id, taskId: updated.id, stepSeq: Number(step.seq), leaseEpoch,
            state: { waiting: 'approval', approval_id: approval.id, tool_call_id: call.id, usage },
          });
          return { status: 'waiting_approval' };
        }

        const attempt = await startToolAttempt({
          tenantId: current.tenant_id, toolCallId: call.id, attemptNo: 1,
          workerId, leaseEpoch,
        });
        await emit(current, 'tool.started', {
          tool_call_id: call.id, tool_name: action.tool_name, tool_version: descriptor.version,
        }, 'worker', workerId);
        const result = await executor.execute(descriptor, action.arguments || {}, {
          toolCallId: call.id, stepId: step.id,
        });
        await finishToolAttempt({
          tenantId: current.tenant_id, attemptId: attempt.id,
          status: result.status === 'succeeded' ? 'succeeded' : 'failed',
          errorCode: result.error_code || null, resultHash: result.result_hash || null,
          workerId, leaseEpoch,
        });
        await finishToolCall({
          tenantId: current.tenant_id, toolCallId: call.id, status: result.status,
          errorCode: result.error_code || null,
          resultPreview: result.content.slice(0, 500),
          resultHash: result.result_hash || null,
          workerId, leaseEpoch, attemptId: attempt.id,
        });
        await emit(current, result.status === 'succeeded' ? 'tool.completed' : 'tool.failed', {
          tool_call_id: call.id, tool_name: action.tool_name,
          error_code: result.error_code || null, retryable: false,
          result_hash: result.result_hash || null, truncated: !!result.truncated,
        }, 'system');
        usage.tool_calls += 1;
        await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'completed' });
        if (result.error_code === 'sandbox_violation'){
          await failTask(current, workerId, 'sandbox_violation', '自定义工具触发沙箱违规');
          return { status: 'failed' };
        }
        await appendToolResult(current, action.tool_name, result);
        current = await persistUsage(current, workerId, usage).catch(() => current);
        await saveCheckpoint({
          tenantId: current.tenant_id, taskId: current.id, stepSeq: Number(step.seq), leaseEpoch,
          state: { tool_call_id: call.id, tool_name: action.tool_name, usage },
        });
        continue;
      }
      default:
        await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, leaseEpoch, status: 'failed', errorCode: 'model_invalid_output' });
        throw new TaskExecutionError('model_invalid_output', `未知动作类型：${action.type}`, { retryable: true });
    }
  }
}

function saveCheckpointLater(task, stepSeq){
  saveCheckpoint({
    tenantId: task.tenant_id, taskId: task.id, stepSeq: Number(stepSeq), leaseEpoch: task.lease_epoch,
    state: { error: task.last_error_code || null, step_seq: Number(stepSeq) },
  }).catch(() => {});
}
