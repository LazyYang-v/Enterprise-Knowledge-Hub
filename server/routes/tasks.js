// 任务 API（设计文档 §13.2–§13.6）。仅当 AGENT_PLATFORM_ENABLED=1 时启用；只接受 Bearer 头。
import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { authRequired } from '../auth.js';
import { config } from '../config.js';
import { fixFileName } from '../util.js';
import { resolveTenantId } from '../control/tenants.js';
import {
  TaskService, TaskValidationError, TaskForbiddenError, TaskStateError, TERMINAL_STATUSES,
} from '../control/task-service.js';
import {
  getEventsAfter, getTaskStatus, appendMessage, appendEvent, listMessages,
} from '../control/task-repo.js';
import { getPreset } from '../control/preset-repo.js';
import { listEvidence, countEvidence } from '../control/evidence-repo.js';
import { taskKnowledge } from '../knowledge/task-context.js';
import { selectTaskSkill } from '../skills/index.js';
import { getPool, withTransaction } from '../control/pg.js';
import { resolveTools } from '../tools/registry.js';
import { isAdminUser } from '../auth/admin.js';
import { getArtifactService } from '../artifacts/service.js';
import { contentDisposition } from '../artifacts/paths.js';

const router = Router();
export const approvalsRouter = Router();
const service = new TaskService({
  getPreset,
  resolveKnowledgeScope: taskKnowledge.resolveTaskKnowledge,
  assertInputDocs: taskKnowledge.assertInputDocs,
  selectSkill: selectTaskSkill,
  resolveTools,
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 附件先进内存：上限 25 MiB，随后由成果服务做扩展名/magic bytes/名称校验。
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.artifacts.uploadMaxBytes, files: 1, fields: 8 },
}).single('file');

function requestId(req){
  return req.get('X-Request-Id') || crypto.randomUUID();
}

function fail(res, status, code, message, req, details = null, retryable = false){
  return res.status(status).json({
    error: { code, message, details, request_id: requestId(req), retryable },
  });
}

function mapError(res, e, req){
  if (e instanceof TaskValidationError) return fail(res, 400, 'validation_error', e.message, req);
  if (e instanceof TaskForbiddenError) return fail(res, 403, 'forbidden', e.message, req);
  if (e instanceof TaskStateError){
    const map = { not_found: [404, 'not_found'], conflict: [409, 'conflict'], expired: [410, 'approval_expired'],
      approval_args_mismatch: [409, 'approval_args_mismatch'] };
    const [status, code] = map[e.code] || [409, 'conflict'];
    return fail(res, status, code, e.message, req);
  }
  if (e?.code === 'lease_lost') return fail(res, 409, 'conflict', e.message, req);
  if (typeof e?.status === 'number' && e.status >= 400 && e.status < 600){
    return fail(res, e.status, e.code || 'request_error', e.message, req, null, !!e.retryable);
  }
  console.error('[tasks]', e);
  return fail(res, 500, 'internal_error', '服务器内部错误', req, null, true);
}

function requireBearer(req, res, next){
  if (!config.agentPlatformEnabled){
    return fail(res, 404, 'not_found', '接口不存在', req);
  }
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return fail(res, 401, 'unauthorized', '需要 Bearer 令牌', req);
  next();
}

router.use(requireBearer);
router.use(authRequired);
approvalsRouter.use(requireBearer);
approvalsRouter.use(authRequired);

function taskInputFromBody(body = {}){
  const input = {};
  if (body.preset_id != null) input.preset_id = body.preset_id;
  if (body.input_ids != null) input.input_ids = body.input_ids;
  if (body.kb_scope != null) input.kb_scope = body.kb_scope;
  if (body.skill != null) input.skill = body.skill;
  if (body.approval_mode != null) input.approval_mode = body.approval_mode;
  if (body.tools != null) input.tools = body.tools;
  if (body.metadata != null) input.metadata = body.metadata;
  return input;
}

async function createIdempotentRecord({ tenantId, principalId, endpoint, key, requestHash }){
  const r = await getPool().query(
    `INSERT INTO idempotency_keys (tenant_id, principal_id, endpoint, idempotency_key, request_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours')
     ON CONFLICT (tenant_id, principal_id, endpoint, idempotency_key) DO NOTHING
     RETURNING *`,
    [tenantId, principalId, endpoint, key, requestHash],
  );
  if (r.rowCount) return { fresh: true };
  const existing = await getPool().query(
    `SELECT * FROM idempotency_keys WHERE tenant_id = $1 AND principal_id = $2 AND endpoint = $3 AND idempotency_key = $4`,
    [tenantId, principalId, endpoint, key],
  );
  const row = existing.rows[0];
  if (!row) throw new TaskStateError('幂等记录读取失败', 'conflict');
  if (row.request_hash !== requestHash) throw new TaskStateError('相同 Idempotency-Key 对应不同请求', 'conflict');
  if (row.status === 'completed') return { fresh: false, response: row.response_json };
  throw new TaskStateError('相同请求正在处理中', 'conflict');
}

async function completeIdempotentRecord({ tenantId, principalId, endpoint, key, response }){
  await getPool().query(
    `UPDATE idempotency_keys SET status = 'completed', response_json = $5::jsonb
      WHERE tenant_id = $1 AND principal_id = $2 AND endpoint = $3 AND idempotency_key = $4`,
    [tenantId, principalId, endpoint, key, JSON.stringify(response)],
  );
}

router.post('/', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const body = req.body || {};
    const requestHash = crypto.createHash('sha256').update(JSON.stringify({
      goal: body.goal, title: body.title, input: taskInputFromBody(body), budget: body.budget, priority: body.priority,
    })).digest('hex');
    const idemKey = req.get('Idempotency-Key');
    if (idemKey){
      const existing = await createIdempotentRecord({
        tenantId, principalId: req.user.id, endpoint: 'POST /api/tasks', key: idemKey, requestHash,
      });
      if (!existing.fresh) return res.json(existing.response);
    }

    const task = await service.createTask({
      tenantId, ownerId: req.user.id,
      goal: body.goal, title: body.title,
      input: taskInputFromBody(body), budget: body.budget || {},
      priority: body.priority ?? 100,
    });
    const snapshot = await service.snapshot({ tenantId, taskId: task.id, userId: req.user.id });
    const response = {
      task: snapshot,
      events_url: `/api/tasks/${task.id}/events`,
      request_id: requestId(req),
    };
    if (idemKey){
      await completeIdempotentRecord({ tenantId, principalId: req.user.id, endpoint: 'POST /api/tasks', key: idemKey, response });
    }
    res.status(201).json(response);
  } catch (e){ mapError(res, e, req); }
});

router.get('/', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const cursor = service.parseCursor(req.query.cursor);
    const result = await service.listTasks({
      tenantId, ownerId: req.user.id,
      limit: Number(req.query.limit) || 20, cursor,
    });
    res.json({
      tasks: result.tasks.map(t => ({
        id: t.id, title: t.title, status: t.status, priority: t.priority,
        usage: t.usage_json, created_at: t.created_at, updated_at: t.updated_at,
        last_event_seq: t.event_seq,
      })),
      next_cursor: result.next_cursor,
      request_id: requestId(req),
    });
  } catch (e){ mapError(res, e, req); }
});

router.get('/:id', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const snapshot = await service.snapshot({ tenantId, taskId: req.params.id, userId: req.user.id, isAdmin: isAdminUser(req.user) });
    res.json({ task: snapshot, request_id: requestId(req) });
  } catch (e){ mapError(res, e, req); }
});

router.get('/:id/messages', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const task = await service.getTaskForUser({ tenantId, taskId: req.params.id, userId: req.user.id, isAdmin: isAdminUser(req.user) });
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    res.json({ messages: await listMessages(tenantId, task.id, limit), request_id: requestId(req) });
  } catch (e){ mapError(res, e, req); }
});

router.get('/:id/events/history', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const task = await service.getTaskForUser({ tenantId, taskId: req.params.id, userId: req.user.id, isAdmin: isAdminUser(req.user) });
    const after = Number(req.query.after || 0);
    if (!Number.isFinite(after) || after < 0) return fail(res, 400, 'validation_error', 'after 不合法', req);
    const events = await getEventsAfter(tenantId, task.id, after, Number(req.query.limit) || 200);
    res.json({
      events,
      last_seq: events.length ? events[events.length - 1].seq : after,
      latest_seq: task.event_seq,
      gap: events.length && after > 0 && events[0].seq > after + 1
        ? { expected: after + 1, next: events[0].seq }
        : null,
      request_id: requestId(req),
    });
  } catch (e){ mapError(res, e, req); }
});

router.get('/:id/events', async (req, res) => {
  let task;
  try {
    const tenantId = await resolveTenantId(req.user.id);
    task = await service.getTaskForUser({ tenantId, taskId: req.params.id, userId: req.user.id });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const lastId = Number(req.get('Last-Event-ID') || req.query.after || 0) || 0;
    let cursor = lastId;
    let closed = false;
    let lastWrite = Date.now();
    req.on('close', () => { closed = true; });
    res.write(': connected\n\n');

    while (!closed){
      const events = await getEventsAfter(tenantId, task.id, cursor, 200);
      for (const ev of events){
        if (cursor > 0 && ev.seq > cursor + 1){
          res.write(`event: gap\ndata: ${JSON.stringify({ expected: cursor + 1, next: ev.seq })}\n\n`);
        }
        cursor = ev.seq;
        res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        lastWrite = Date.now();
      }
      const status = await getTaskStatus(tenantId, task.id);
      if (!status){ res.write('event: error\ndata: {"code":"not_found"}\n\n'); break; }
      if (!events.length && TERMINAL_STATUSES.has(status.status)){
        res.write(`event: end\ndata: ${JSON.stringify({ status: status.status, last_seq: cursor })}\n\n`);
        break;
      }
      if (!events.length && Date.now() - lastWrite > 15000){
        res.write(': ping\n\n');
        lastWrite = Date.now();
      }
      await sleep(Number(process.env.EKH_SSE_POLL_MS) || 500);
    }
    res.end();
  } catch (e){
    if (res.headersSent){
      try { res.write(`event: error\ndata: ${JSON.stringify({ code: e.code || 'internal_error', message: e.message })}\n\n`); } catch {}
      try { res.end(); } catch {}
    } else {
      mapError(res, e, req);
    }
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    await service.cancelTask({
      tenantId, taskId: req.params.id, userId: req.user.id, isAdmin: isAdminUser(req.user),
      reason: String(req.body?.reason || 'user_cancelled').slice(0, 200),
    });
    const snapshot = await service.snapshot({ tenantId, taskId: req.params.id, userId: req.user.id, isAdmin: isAdminUser(req.user) });
    res.json({ task: snapshot, request_id: requestId(req) });
  } catch (e){ mapError(res, e, req); }
});

router.post('/:id/resume', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    await service.resumeTask({
      tenantId, taskId: req.params.id, userId: req.user.id, isAdmin: isAdminUser(req.user),
      reason: String(req.body?.reason || 'manual_resume').slice(0, 200),
    });
    const snapshot = await service.snapshot({ tenantId, taskId: req.params.id, userId: req.user.id, isAdmin: isAdminUser(req.user) });
    res.json({ task: snapshot, request_id: requestId(req) });
  } catch (e){ mapError(res, e, req); }
});

router.post('/:id/input', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    await service.submitInput({
      tenantId, taskId: req.params.id, userId: req.user.id, isAdmin: isAdminUser(req.user),
      requestId: req.body?.request_id || null, values: req.body?.values || {},
    });
    const snapshot = await service.snapshot({ tenantId, taskId: req.params.id, userId: req.user.id, isAdmin: isAdminUser(req.user) });
    res.json({ task: snapshot, request_id: requestId(req) });
  } catch (e){ mapError(res, e, req); }
});

router.post('/:id/messages', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const task = await service.getTaskForUser({ tenantId, taskId: req.params.id, userId: req.user.id, isAdmin: isAdminUser(req.user) });
    const content = String(req.body?.content || '').trim();
    if (!content) return fail(res, 400, 'validation_error', '消息不能为空', req);
    if (content.length > 8000) return fail(res, 400, 'validation_error', '消息不能超过 8000 字符', req);
    if (TERMINAL_STATUSES.has(task.status)) return fail(res, 409, 'conflict', '任务已结束', req);
    const message = await appendMessage({
      tenantId, taskId: task.id, role: 'user', content, actorId: req.user.id,
    });
    await withTransaction(client => appendEvent(client, {
      tenantId, taskId: task.id, type: 'instruction.received', actorType: 'user', actorId: req.user.id,
      payload: { message_id: message.id, content_preview: content.slice(0, 200) },
    }));
    res.json({ ok: true, message_id: message.id, request_id: requestId(req) });
  } catch (e){ mapError(res, e, req); }
});

/** 成果面 ACL：不区分“无任务/无权限”，统一 404，避免泄露任务存在性。 */
async function taskForArtifactRequest(req){
  const tenantId = await resolveTenantId(req.user.id);
  const isAdmin = isAdminUser(req.user);
  try {
    const task = await service.getTaskForUser({
      tenantId, taskId: req.params.id, userId: req.user.id, isAdmin,
    });
    return { tenantId, task, isAdmin };
  } catch (e){
    if (e instanceof TaskForbiddenError) throw new TaskStateError('任务不存在', 'not_found');
    throw e;
  }
}

router.get('/:id/artifacts', async (req, res) => {
  try {
    const { tenantId, task } = await taskForArtifactRequest(req);
    const artifacts = await getArtifactService().list({
      tenantId, taskId: task.id,
      kind: req.query.kind ? String(req.query.kind) : null,
      limit: Number(req.query.limit) || 200,
    });
    res.json({ artifacts, request_id: requestId(req) });
  } catch (e){ mapError(res, e, req); }
});

router.get('/:id/artifacts/:artifactId/download', async (req, res) => {
  try {
    const { tenantId, task } = await taskForArtifactRequest(req);
    const file = await getArtifactService().download({
      tenantId, taskId: task.id, artifactId: req.params.artifactId,
      userId: req.user.id, ip: req.ip, userAgent: req.get('user-agent') || null,
    });
    res.writeHead(200, {
      'Content-Type': file.mime,
      'Content-Length': String(file.size),
      'Content-Disposition': contentDisposition(file.filename),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    file.stream.on('error', () => { try { res.destroy(); } catch {} });
    file.stream.pipe(res);
  } catch (e){ mapError(res, e, req); }
});

router.post('/:id/attachments', (req, res) => {
  attachmentUpload(req, res, async err => {
    if (err){
      if (err.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'file_too_large', '附件超过大小上限', req);
      if (err.code === 'LIMIT_UNEXPECTED_FILE') return fail(res, 400, 'validation_error', '只允许上传一个 file 字段', req);
      return fail(res, 400, 'validation_error', '附件上传失败', req);
    }
    try {
      const { tenantId, task, isAdmin } = await taskForArtifactRequest(req);
      if (TERMINAL_STATUSES.has(task.status)) return fail(res, 409, 'conflict', '任务已结束，不能上传附件', req);
      if (!req.file) return fail(res, 400, 'validation_error', '未选择文件', req);
      const artifact = await getArtifactService().attachUpload({
        tenantId, taskId: task.id, userId: req.user.id,
        buffer: req.file.buffer,
        originalName: fixFileName(req.file.originalname || ''),
        sourceRef: String(req.body?.source_ref || '').slice(0, 200),
        ip: req.ip, userAgent: req.get('user-agent') || null,
      });
      const snapshot = await service.snapshot({ tenantId, taskId: task.id, userId: req.user.id, isAdmin });
      res.status(201).json({ artifact, task: snapshot, request_id: requestId(req) });
    } catch (e){ mapError(res, e, req); }
  });
});

router.delete('/:id/artifacts/:artifactId', async (req, res) => {
  try {
    const { tenantId, task } = await taskForArtifactRequest(req);
    await getArtifactService().softDelete({
      tenantId, taskId: task.id, artifactId: req.params.artifactId,
      userId: req.user.id, ip: req.ip, userAgent: req.get('user-agent') || null,
    });
    res.json({ ok: true, request_id: requestId(req) });
  } catch (e){ mapError(res, e, req); }
});

router.get('/:id/evidence', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const task = await service.getTaskForUser({ tenantId, taskId: req.params.id, userId: req.user.id, isAdmin: isAdminUser(req.user) });
    const [rows, count] = await Promise.all([
      listEvidence({ tenantId, taskId: task.id, limit: req.query.limit }),
      countEvidence({ tenantId, taskId: task.id }),
    ]);
    res.json({ evidence: rows, count, request_id: requestId(req) });
  } catch (e){ mapError(res, e, req); }
});

// —— 审批（P0-2 骨架；完整策略在 P0-4） ——
approvalsRouter.get('/', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const rows = await service.listApprovals({
      tenantId, status: String(req.query.status || 'pending'), ownerId: req.user.id,
    });
    res.json({ approvals: rows, request_id: requestId(req) });
  } catch (e){ mapError(res, e, req); }
});

approvalsRouter.get('/:id', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const r = await getPool().query('SELECT * FROM agent_approvals WHERE tenant_id = $1 AND id = $2', [tenantId, req.params.id]);
    if (!r.rowCount) return fail(res, 404, 'not_found', '审批不存在', req);
    await service.getTaskForUser({ tenantId, taskId: r.rows[0].task_id, userId: req.user.id, isAdmin: isAdminUser(req.user) });
    res.json({ approval: r.rows[0], request_id: requestId(req) });
  } catch (e){ mapError(res, e, req); }
});

approvalsRouter.post('/:id/decision', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const { decision, args_hash: argsHash, comment = '' } = req.body || {};
    const task = await service.decideApproval({
      tenantId, approvalId: req.params.id, userId: req.user.id,
      decision, argsHash, comment: String(comment).slice(0, 500),
      isAdmin: isAdminUser(req.user),
    });
    const snapshot = await service.snapshot({ tenantId, taskId: task.id, userId: req.user.id });
    res.json({ task: snapshot, request_id: requestId(req) });
  } catch (e){ mapError(res, e, req); }
});

export default router;
