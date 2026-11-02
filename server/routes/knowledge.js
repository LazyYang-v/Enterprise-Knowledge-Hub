// 知识 API（Agent 平台）。Bearer only；只有 AGENT_PLATFORM_ENABLED=1 时挂载。
import { Router } from 'express';
import { authRequired } from '../auth.js';
import { err } from '../util.js';
import { config } from '../config.js';
import { resolveTenantId } from '../control/tenants.js';
import { TaskService, TERMINAL_STATUSES, TaskStateError, TaskForbiddenError, TaskValidationError } from '../control/task-service.js';
import { getKnowledgeService } from '../knowledge/index.js';
import { KnowledgeError, KnowledgeForbiddenError } from '../knowledge/errors.js';

const router = Router();
const tasks = new TaskService();

function requireBearer(req, res, next){
  if (!config.agentPlatformEnabled) return err(res, 404, '接口不存在');
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return err(res, 401, '需要 Bearer 令牌');
  next();
}

router.use(requireBearer);
router.use(authRequired);

function dedupe(values){
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function handle(res, e){
  if (e instanceof TaskValidationError) return err(res, 400, e.message);
  if (e instanceof TaskForbiddenError) return err(res, 403, e.message);
  if (e instanceof TaskStateError){
    const status = e.code === 'not_found' ? 404 : 409;
    return err(res, status, e.message);
  }
  if (e instanceof KnowledgeError){
    return res.status(e.status || 500).json({
      error: e.message, code: e.code || 'knowledge_error', retryable: !!e.retryable,
    });
  }
  console.error('[knowledge]', e);
  return err(res, 500, '服务器内部错误');
}

async function actorFor(req, tenantId = null){
  return {
    userId: req.user.id,
    tenantId: tenantId || null,
    principalType: 'user',
  };
}

async function taskScopeFor(req, taskId, requestedKbIds){
  if (!taskId) return null;
  const tenantId = await resolveTenantId(req.user.id);
  const task = await tasks.getTaskForUser({ tenantId, taskId: String(taskId), userId: req.user.id });
  if (TERMINAL_STATUSES.has(task.status)) throw new KnowledgeError('任务已结束', { code: 'conflict', status: 409 });
  const snapshot = task.input_json?.knowledge;
  if (!snapshot || typeof snapshot !== 'object'){
    throw new KnowledgeError('任务未配置知识范围', { code: 'validation_error', status: 400 });
  }
  const effective = dedupe(snapshot.effective_kb_ids);
  let kbIds = effective;
  if (requestedKbIds != null){
    if (!Array.isArray(requestedKbIds)) throw new KnowledgeError('kb_ids 必须是数组', { code: 'validation_error', status: 400 });
    const requested = dedupe(requestedKbIds);
    const outside = requested.filter(id => !effective.includes(id));
    if (outside.length) throw new KnowledgeForbiddenError('只能收窄任务创建时确定的知识范围');
    kbIds = requested;
  }
  const scope = {
    mode: snapshot.mode || 'explicit',
    kbIds,
    documentIds: dedupe(snapshot.input_doc_ids),
    sessionId: snapshot.session_id || null,
    versionPolicy: snapshot.version_policy === 'latest' ? 'latest' : 'pin_on_first_use',
    reducedCount: Number(snapshot.reduced_count) || 0,
    scopeHash: snapshot.scope_hash || '',
  };
  return { tenantId, task, scope, actor: await actorFor(req, tenantId) };
}

router.get('/bases', async (req, res) => {
  try {
    const actor = await actorFor(req);
    const bases = await getKnowledgeService().listBases(actor);
    res.json({ bases });
  } catch (e){ handle(res, e); }
});

router.post('/search', async (req, res) => {
  try {
    const body = req.body || {};
    const query = String(body.query || '').trim();
    if (!query) return err(res, 400, 'query 不能为空');

    const taskCtx = await taskScopeFor(req, body.task_id, body.kb_ids ?? null);
    let actor;
    let scope;
    if (taskCtx){
      ({ actor, scope } = taskCtx);
    } else {
      actor = await actorFor(req);
      const requested = body.kb_ids;
      if (requested != null && !Array.isArray(requested)) return err(res, 400, 'kb_ids 必须是数组');
      const mode = body.mode || (requested != null ? 'explicit' : 'visible');
      if (!['visible', 'explicit', 'none'].includes(mode)) return err(res, 400, 'mode 不合法');
      scope = await getKnowledgeService().resolveScope({
        actor,
        mode,
        kbIds: requested,
        onExplicitDenied: 'throw',
      });
    }

    const result = await getKnowledgeService().search({
      actor, scope, query,
      topK: body.top_k ?? body.topK,
      taskId: taskCtx ? taskCtx.task.id : null,
    });
    res.json({
      query,
      task_id: taskCtx ? taskCtx.task.id : null,
      effective_kb_ids: result.effectiveKbIds,
      reduced_count: result.reducedCount,
      degraded: result.degraded,
      candidate_count: result.candidateCount,
      candidate_capped: result.candidateCapped,
      evidence: result.evidence,
      citations: result.citations,
      version_changes: result.versionChanges,
    });
  } catch (e){ handle(res, e); }
});

router.get('/documents/:id', async (req, res) => {
  try {
    const actor = await actorFor(req);
    const range = {};
    if (req.query.offset != null) range.offset = Number(req.query.offset);
    if (req.query.limit != null) range.limit = Number(req.query.limit);
    const out = await getKnowledgeService().getDocument(actor, req.params.id, {
      version: req.query.version ?? null,
      range: Object.keys(range).length ? range : null,
    });
    res.json(out);
  } catch (e){ handle(res, e); }
});

router.get('/versions/:id', async (req, res) => {
  try {
    const actor = await actorFor(req);
    res.json(await getKnowledgeService().getVersion(actor, req.params.id));
  } catch (e){ handle(res, e); }
});

router.get('/citations/:id', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const actor = await actorFor(req, tenantId);
    res.json(await getKnowledgeService().getCitation(actor, req.params.id));
  } catch (e){ handle(res, e); }
});

export default router;
