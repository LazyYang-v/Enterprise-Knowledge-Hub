// 跨任务成果库 API（P0-5 成果面）：只读元数据列表，供前端“产物”页使用。
// 与 /api/tasks/:id/artifacts 不同，这里不暴露 storage_key，也不返回文件内容。
import { Router } from 'express';
import crypto from 'node:crypto';
import { authRequired } from '../auth.js';
import { config } from '../config.js';
import { resolveTenantId } from '../control/tenants.js';
import { getArtifactService } from '../artifacts/service.js';
import { isAdminUser } from '../auth/admin.js';

const router = Router();
const KINDS = new Set(['input', 'output', 'intermediate']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestId(req){
  return req.get('X-Request-Id') || crypto.randomUUID();
}

function fail(res, status, code, message, req, details = null){
  return res.status(status).json({
    error: { code, message, details, request_id: requestId(req), retryable: false },
  });
}

router.use((req, res, next) => {
  if (!config.agentPlatformEnabled) return fail(res, 404, 'not_found', '接口不存在', req);
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return fail(res, 401, 'unauthorized', '需要 Bearer 令牌', req);
  next();
});
router.use(authRequired);

router.get('/', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const kind = req.query.kind ? String(req.query.kind) : null;
    if (kind && !KINDS.has(kind)) return fail(res, 400, 'validation_error', 'kind 不合法', req);
    const taskId = req.query.task_id ? String(req.query.task_id) : null;
    if (taskId && !UUID_RE.test(taskId)) return fail(res, 400, 'validation_error', 'task_id 不合法', req);
    const q = req.query.q == null ? null : String(req.query.q).trim().slice(0, 200) || null;
    let cursor = null;
    if (req.query.cursor){
      const [createdAt, id] = String(req.query.cursor).split('|');
      if (!createdAt || !UUID_RE.test(id || '') || Number.isNaN(Date.parse(createdAt))){
        return fail(res, 400, 'validation_error', 'cursor 不合法', req);
      }
      cursor = { createdAt, id };
    }
    const result = await getArtifactService().listForUser({
      tenantId,
      ownerId: req.user.id,
      isAdmin: isAdminUser(req.user),
      limit, cursor, kind, q, taskId,
    });
    res.json({
      artifacts: result.artifacts,
      next_cursor: result.next_cursor,
      request_id: requestId(req),
    });
  } catch (e){
    console.error('[task-artifacts]', e);
    fail(res, 500, 'internal_error', '服务器内部错误', req);
  }
});

export default router;
