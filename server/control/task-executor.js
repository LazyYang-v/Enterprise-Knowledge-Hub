// 任务执行器：每个 Step 一次模型调用，严格解析为 AgentAction。
// P0-2 只执行 plan / finish / fail / ask_user；工具调用在 P0-4 ToolRegistry 接入前一律拒绝。
import crypto from 'node:crypto';
import { completeModel } from '../agent/model-adapter.js';
import { parseAgentAction, ActionValidationError } from '../agent/actions.js';
import { buildAgentSystemPrompt } from '../agent/context-builder.js';
import {
  getTask,
  startStep,
  finishStep,
  recordPlan,
  appendMessage,
  listMessages,
  listPlanItems,
  saveCheckpoint,
  transitionTask,
  createInputRequest,
  createToolCall,
  finishToolCall,
  appendEvent,
} from './task-repo.js';
import { withTransaction } from './pg.js';
import { DEFAULT_BUDGET, RETRYABLE_ERRORS } from './task-service.js';
import { config } from '../config.js';
import { getEvidenceByIds } from './evidence-repo.js';

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
    tenantId: task.tenant_id, taskId: task.id, workerId,
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
    tenantId: task.tenant_id, taskId: task.id, workerId,
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
    tenantId: task.tenant_id, taskId: task.id, workerId,
    expectStatus: 'running', expectVersion: task.version,
    to: 'cancelled',
    patch: { cancelled_by: 'worker', lease_owner: null, lease_expires_at: null },
    eventType: 'task.cancelled', eventPayload: { reason: 'cancel_requested' },
    actorType: 'worker', actorId: workerId,
  }));
}

async function finalizeCancel(task, workerId){
  return withTransaction(client => transitionTask(client, {
    tenantId: task.tenant_id, taskId: task.id, workerId,
    expectStatus: 'cancel_requested', expectVersion: task.version,
    to: 'cancelled',
    patch: { cancelled_by: 'worker', lease_owner: null, lease_expires_at: null },
    eventType: 'task.cancelled', eventPayload: { reason: 'cancel_requested', confirmed_by: workerId },
    actorType: 'worker', actorId: workerId,
  }));
}

function buildMessages(goal, plan, history, { skill = '', evidence = [] } = {}){
  const planLines = plan.map(p => ({ title: p.title, status: p.status }));
  const system = [
    buildAgentSystemPrompt({ goal, plan: planLines, evidence }),
    ACTION_INSTRUCTION,
  ].join('\n\n');
  const messages = [{ role: 'system', content: skill ? `${system}\n\n=== SKILL ===\n${skill}` : system }, { role: 'user', content: goal }];
  for (const m of history){
    if (!m.content) continue;
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  return messages;
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
  workerId, model, signal, log = () => {}, knowledgeFactory = null, skillLoader = null,
} = {}){
  if (!model) throw new TaskExecutionError('model_unavailable', 'Worker 未配置任务模型', { retryable: false });
  let current = task;
  const budget = budgetOf(current);
  const evidenceMax = config.knowledge.evidenceMax;
  const skillInstructions = await loadSkillInstructions(current, skillLoader);
  const knowledge = await createKnowledgeContext(current, knowledgeFactory);
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

  while (true){
    current = await getTask(current.tenant_id, current.id);
    if (!current) return { status: 'unknown' };
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
      tenantId: current.tenant_id, taskId: current.id, workerId,
      expectVersion: current.version, kind: 'model_turn',
    });
    current = startedTask;

    let raw;
    try {
      const plan = await listPlanItems(current.tenant_id, current.id);
      await retrieveForPrompt(current, plan);
      const history = await listMessages(current.tenant_id, current.id, 20);
      const messages = buildMessages(current.goal, plan, history, {
        skill: skillInstructions, evidence: evidenceForPrompt,
      });
      const timeoutSignal = AbortSignal.timeout(budget.model_timeout_ms);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      raw = await completeModel(model, messages, { temperature: 0.2, signal: combined });
      usage.model_calls += 1;
      usage.steps += 1;
    } catch (e){
      await finishStep({
        tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId,
        status: 'failed', errorCode: e?.code || 'model_error',
      });
      throw classifyError(e);
    }

    if (!raw || !String(raw).trim()){
      await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, status: 'failed', errorCode: 'model_invalid_output' });
      throw new TaskExecutionError('model_invalid_output', '模型返回空内容', { retryable: true });
    }

    const message = await appendMessage({
      tenantId: current.tenant_id, taskId: current.id, role: 'assistant',
      content: String(raw).slice(0, 20000), actorId: workerId,
    });
    await emit(current, 'message.created', { role: 'assistant', seq: message.seq, content_preview: String(raw).slice(0, 200) }, 'model');

    let action;
    try {
      action = parseAgentAction(raw);
    } catch (e){
      await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, status: 'failed', errorCode: 'model_invalid_output' });
      current = await persistUsage(current, workerId, usage).catch(() => current);
      saveCheckpointLater(current, step.seq);
      throw classifyError(e);
    }

    // 安全点：模型调用结束后再次检查取消。
    current = await getTask(current.tenant_id, current.id);
    if (!current) return { status: 'unknown' };
    if (current.status === 'cancel_requested'){
      await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, status: 'failed', errorCode: 'cancelled' });
      await finalizeCancel(current, workerId);
      return { status: 'cancelled' };
    }
    if (current.status !== 'running') return { status: current.status };
    if (current.cancel_requested_at){
      await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, status: 'failed', errorCode: 'cancelled' });
      await cancelByWorker(current, workerId);
      return { status: 'cancelled' };
    }

    switch (action.type){
      case 'plan': {
        current = await recordPlan({
          tenantId: current.tenant_id, taskId: current.id, workerId,
          expectVersion: current.version, items: action.plan_items,
        });
        await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, status: 'completed' });
        current = await persistUsage(current, workerId, usage);
        await saveCheckpoint({
          tenantId: current.tenant_id, taskId: current.id, stepSeq: Number(step.seq),
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
        await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, status: 'completed' });
        const updated = await withTransaction(client => transitionTask(client, {
          tenantId: current.tenant_id, taskId: current.id, workerId,
          expectStatus: 'running', expectVersion: current.version,
          to: 'waiting_input',
          patch: { lease_owner: null, lease_expires_at: null, usage_json: usage },
          eventType: 'task.waiting_input', eventPayload: { question: action.question },
          actorType: 'worker', actorId: workerId,
        }));
        await saveCheckpoint({
          tenantId: updated.tenant_id, taskId: updated.id, stepSeq: Number(step.seq),
          state: { waiting: 'input', usage },
        });
        return { status: 'waiting_input' };
      }
      case 'finish': {
        const citationIds = [...new Set(action.citations || [])];
        if (citationIds.length){
          const invalid = citationIds.filter(id => !UUID_RE.test(id));
          if (invalid.length){
            await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, status: 'failed', errorCode: 'model_invalid_output' });
            throw new TaskExecutionError('model_invalid_output', 'citations 含非法的 evidence_id', { retryable: true });
          }
          let rows;
          try {
            rows = await getEvidenceByIds({
              tenantId: current.tenant_id, taskId: current.id, ids: citationIds,
            });
          } catch (e){
            await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, status: 'failed', errorCode: 'knowledge_unavailable' });
            throw new TaskExecutionError('knowledge_unavailable', `引用校验失败：${e.message}`, { retryable: true });
          }
          if (rows.length !== citationIds.length){
            await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, status: 'failed', errorCode: 'model_invalid_output' });
            throw new TaskExecutionError('model_invalid_output', 'citations 引用了不属于本任务的证据', { retryable: true });
          }
        }
        await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, status: 'completed' });
        await saveCheckpoint({
          tenantId: current.tenant_id, taskId: current.id, stepSeq: Number(step.seq),
          state: { finished: true, summary: action.summary, citations: citationIds, usage },
        });
        await withTransaction(client => transitionTask(client, {
          tenantId: current.tenant_id, taskId: current.id, workerId,
          expectStatus: 'running', expectVersion: current.version,
          to: 'completed',
          patch: {
            result_summary: action.summary, usage_json: usage,
            lease_owner: null, lease_expires_at: null,
          },
          eventType: 'task.completed',
          eventPayload: {
            summary: action.summary, artifact_ids: action.artifact_refs,
            citations: citationIds, evidence_ids: [...evidenceIds],
          },
          actorType: 'model',
        }));
        return { status: 'completed' };
      }
      case 'fail': {
        await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, status: 'failed', errorCode: action.error_code });
        await failTask(current, workerId, action.error_code, action.message);
        return { status: 'failed' };
      }
      case 'call_tool': {
        const argsHash = crypto.createHash('sha256').update(JSON.stringify(action.arguments)).digest('hex');
        const call = await createToolCall({
          tenantId: current.tenant_id, taskId: current.id, stepId: step.id,
          toolName: action.tool_name, args: action.arguments, argsHash,
          sideEffect: 'read', status: 'failed',
        });
        await finishToolCall({ tenantId: current.tenant_id, toolCallId: call.id, status: 'failed', errorCode: 'tool_unavailable', resultPreview: null });
        await emit(current, 'tool.failed', { tool_call_id: call.id, tool_name: action.tool_name, error_code: 'tool_unavailable', retryable: false }, 'system');
        await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, status: 'failed', errorCode: 'tool_unavailable' });
        await failTask(current, workerId, 'tool_unavailable', `工具尚未接入：${action.tool_name}`);
        return { status: 'failed' };
      }
      default:
        await finishStep({ tenantId: current.tenant_id, taskId: current.id, stepId: step.id, workerId, status: 'failed', errorCode: 'model_invalid_output' });
        throw new TaskExecutionError('model_invalid_output', `未知动作类型：${action.type}`, { retryable: true });
    }
  }
}

function saveCheckpointLater(task, stepSeq){
  saveCheckpoint({
    tenantId: task.tenant_id, taskId: task.id, stepSeq: Number(stepSeq),
    state: { error: task.last_error_code || null, step_seq: Number(stepSeq) },
  }).catch(() => {});
}
