import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { db, UPLOAD_DIR } from '../db.js';
import { $uuid, now, err, fixFileName } from '../util.js';
import { authRequired } from '../auth.js';
import { normalizeBaseUrl } from '../llm.js';
import { parseToolCode } from '../custom-tools.js';
import { visibleKbs } from '../knowledge/acl.js';
import { isPlatformAdmin, isAdminUser } from '../auth/admin.js';
import { auditSafe } from '../control/audit-repo.js';
import { resolveTenantId } from '../control/tenants.js';
import {
  createCustomTool, getCustomTool, listCustomTools, updateCustomTool, deleteCustomTool,
} from '../tools/custom-tools-repo.js';
import { descriptorForCustom } from '../tools/registry.js';
import { upsertToolRegistry, deleteToolRegistryByOwner } from '../control/tool-registry-repo.js';

const router = Router();
router.use(authRequired);

// ============ 产物 ============
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { const dir = path.join(UPLOAD_DIR, $uuid()); fs.mkdirSync(dir, { recursive: true }); cb(null, dir); },
    filename: (req, file, cb) => cb(null, fixFileName(file.originalname)),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

function artifactRow(a){
  return { id: a.id, session_id: a.session_id, name: a.name, mime: a.mime, size: a.size, source: a.source, created_at: a.created_at };
}

router.get('/artifacts', (req, res) => {
  const rows = db.prepare(
    `SELECT a.* FROM artifacts a LEFT JOIN chat_sessions s ON s.id = a.session_id
     WHERE a.user_id = ? AND (a.session_id IS NULL OR s.id IS NOT NULL)
     ORDER BY a.created_at DESC LIMIT 200`
  ).all(req.user.id);
  res.json({ artifacts: rows.map(artifactRow) });
});

router.post('/artifacts', upload.single('file'), (req, res) => {
  if (!req.file) return err(res, 400, '未选择文件');
  const id = $uuid();
  const finalPath = path.join(path.dirname(req.file.path), 'source.bin');
  fs.renameSync(req.file.path, finalPath);
  db.prepare('INSERT INTO artifacts(id, user_id, session_id, name, mime, size, path, source, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, null, fixFileName(req.file.originalname).slice(0, 200), req.file.mimetype || '', req.file.size, finalPath, 'upload', now());
  res.json({ artifact: artifactRow(db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id)) });
});

router.get('/artifacts/:id/download', (req, res) => {
  const a = db.prepare('SELECT * FROM artifacts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!a) return err(res, 404, '产物不存在');
  if (!fs.existsSync(a.path)) return err(res, 404, '文件已丢失');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`);
  res.sendFile(a.path);
});

router.delete('/artifacts/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM artifacts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!a) return err(res, 404, '产物不存在');
  try { fs.rmSync(path.dirname(a.path), { recursive: true, force: true }); } catch {}
  db.prepare('DELETE FROM artifacts WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

// ============ 工具箱 ============
const TOOL_META = {
  'web-search': { name: '网络搜索', description: '回答时自动检索互联网，补充知识库之外的信息（需配置 Tavily API Key）。' },
  'mcp': { name: 'MCP 服务', description: '接入 Model Context Protocol 服务，为智能体挂载外部工具与数据源。' },
  'browser': { name: '浏览器自动化', description: '让智能体操作真实浏览器完成网页信息获取与表单填写。' },
};

function publicBuiltinConfig(key, config, admin){
  if (admin) return config;
  // 普通用户只能知道是否已配置，不能读取内置工具的 API Key/内部配置。
  return { configured: Object.keys(config || {}).some(k => !!config[k]) };
}

function customToolRow(key, t){
  return {
    key, name: t.name, description: t.description, enabled: !!t.enabled,
    config: {}, custom: true, version: `1.${t.current_version || 1}.0`,
    current_version: t.current_version || 1,
  };
}

async function syncCustomRegistry(tool){
  try {
    const tenantId = await resolveTenantId(tool.owner_id);
    const d = descriptorForCustom(tool);
    await upsertToolRegistry({
      tenantId, name: d.name, version: d.version, source: 'custom',
      description: d.description, inputSchema: d.input_schema, sideEffect: d.side_effect,
      approvalPolicy: d.approval_policy, timeoutMs: d.timeout_ms, idempotency: d.idempotency,
      resourceScope: d.resource_scope, sandboxProfile: d.sandbox_profile,
      schemaHash: d.schema_hash, ownerId: tool.owner_id, enabled: !!tool.enabled,
    });
  } catch (e){
    // 控制面不可用不应阻断知识面工具上传；执行时仍会校验当前注册表。
    console.error('[tools] registry sync failed:', e?.message || e);
  }
}

async function auditTool(action, req, tool, decision = 'allowed'){
  try {
    const tenantId = await resolveTenantId(tool.owner_id);
    await auditSafe({
      tenantId, actorType: 'user', actorId: req.user.id, action,
      resourceType: 'custom_tool', resourceId: tool.id, decision,
      detail: { tool_id: tool.id, version: tool.current_version, code_hash: tool.code_hash },
    });
  } catch { /* 审计失败不影响主流程 */ }
}

router.get('/tools', (req, res) => {
  const admin = isAdminUser(req.user);
  const rows = db.prepare('SELECT * FROM tools').all();
  const have = new Set(rows.map(r => r.key));
  for (const key of Object.keys(TOOL_META)){
    if (!have.has(key)) db.prepare('INSERT INTO tools(key, enabled, config) VALUES(?,0,?)').run(key, '{}');
  }
  const all = db.prepare('SELECT * FROM tools').all();
  const customs = listCustomTools({
    ownerId: req.user.id, includeAll: admin, includeDeleted: false,
  });
  res.json({ tools: [
    ...all.map(t => {
      const config = JSON.parse(t.config || '{}');
      return {
        key: t.key, ...TOOL_META[t.key], enabled: !!t.enabled,
        config: publicBuiltinConfig(t.key, config, admin),
      };
    }),
    ...customs.map(t => customToolRow('custom:' + t.id, t)),
  ] });
});

router.post('/tools/upload', async (req, res) => {
  const { code } = req.body || {};
  if (!code || !String(code).trim()) return err(res, 400, '未提供工具文件内容');
  let meta;
  try { meta = await parseToolCode(code); } catch (e){ return err(res, 400, e.message); }
  const tool = createCustomTool({
    ownerId: req.user.id, name: meta.name, description: meta.description,
    parameters: meta.parameters, code: String(code), createdBy: req.user.id,
  });
  await syncCustomRegistry(tool);
  await auditTool('tool.custom.created', req, tool);
  res.json({ tool: customToolRow('custom:' + tool.id, tool) });
});

router.delete('/tools/custom/:id', async (req, res) => {
  let tool;
  try {
    tool = deleteCustomTool(req.params.id, {
      ownerId: req.user.id,
      isAdmin: isPlatformAdmin(req.user),
    });
  } catch (e){
    if (e.code === 'tool_forbidden') return err(res, 403, e.message);
    throw e;
  }
  if (!tool) return err(res, 404, '工具不存在');
  // 从引用了该工具的智能体中同步移除
  for (const a of db.prepare('SELECT id, tools FROM agents').all()){
    const arr = JSON.parse(a.tools || '[]');
    if (arr.includes('custom:' + tool.id)){
      db.prepare('UPDATE agents SET tools = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(arr.filter(k => k !== 'custom:' + tool.id)), now(), a.id);
    }
  }
  try {
    const tenantId = await resolveTenantId(tool.owner_id);
    await deleteToolRegistryByOwner({ tenantId, toolId: tool.id });
  } catch {}
  await auditTool('tool.custom.deleted', req, tool);
  res.json({ ok: true });
});

router.put('/tools/:key', async (req, res) => {
  const { key } = req.params;
  if (key.startsWith('custom:')){
    const id = key.slice(7);
    const existing = getCustomTool(id, { includeDeleted: true });
    if (!existing) return err(res, 404, '工具不存在');
    if (!isPlatformAdmin(req.user) && String(existing.owner_id) !== String(req.user.id)){
      return err(res, 403, '无权修改该工具');
    }
    const body = req.body || {};
    const patch = {};
    if (body.enabled != null) patch.enabled = !!body.enabled;
    if (body.code != null){
      let meta;
      try { meta = await parseToolCode(body.code); } catch (e){ return err(res, 400, e.message); }
      patch.code = String(body.code);
      patch.name = meta.name;
      patch.description = meta.description;
      patch.parameters = meta.parameters;
    }
    let result;
    try {
      result = updateCustomTool(id, patch, {
        ownerId: req.user.id, isAdmin: isPlatformAdmin(req.user), updatedBy: req.user.id,
      });
    } catch (e){
      if (e.code === 'tool_forbidden') return err(res, 403, e.message);
      throw e;
    }
    if (!result) return err(res, 404, '工具不存在');
    await syncCustomRegistry(result.tool);
    await auditTool(result.versionCreated ? 'tool.custom.version_created' : 'tool.custom.updated', req, result.tool);
    return res.json({ tool: customToolRow(key, result.tool) });
  }
  if (!isPlatformAdmin(req.user)) return err(res, 403, '需要平台管理员权限');
  const t = db.prepare('SELECT * FROM tools WHERE key = ?').get(key);
  if (!t) return err(res, 404, '工具不存在');
  const { enabled, config } = req.body || {};
  if (enabled != null) db.prepare('UPDATE tools SET enabled = ? WHERE key = ?').run(enabled ? 1 : 0, t.key);
  if (config != null) db.prepare('UPDATE tools SET config = ? WHERE key = ?').run(JSON.stringify(config), t.key);
  const fresh = db.prepare('SELECT * FROM tools WHERE key = ?').get(t.key);
  await auditSafe({
    actorType: 'user', actorId: req.user.id, action: 'tool.builtin.updated',
    resourceType: 'builtin_tool', resourceId: t.key, decision: 'allowed',
    detail: { enabled: !!fresh.enabled, config_keys: Object.keys(JSON.parse(fresh.config || '{}')) },
  });
  res.json({ tool: { key: fresh.key, ...TOOL_META[fresh.key], enabled: !!fresh.enabled, config: JSON.parse(fresh.config || '{}') } });
});

// ============ 模型管理 ============
const MODEL_KINDS = ['chat', 'embedding', 'rerank'];

function modelRow(m){
  return { id: m.id, kind: m.kind, name: m.name, provider: m.provider, base_url: m.base_url, api_key: m.api_key ? '••••••••' : '', model_name: m.model_name, is_default: !!m.is_default, created_at: m.created_at };
}

router.get('/models', (req, res) => {
  const rows = db.prepare('SELECT * FROM models ORDER BY created_at').all();
  res.json({ models: rows.map(modelRow) });
});

router.post('/models', (req, res) => {
  if (!isPlatformAdmin(req.user)) return err(res, 403, '需要平台管理员权限');
  const { kind, name, provider = '', base_url, api_key = '', model_name, is_default = 0 } = req.body || {};
  if (!MODEL_KINDS.includes(kind)) return err(res, 400, '模型类型不合法');
  if (!name || !base_url || !model_name) return err(res, 400, '名称、接口地址与模型 ID 不能为空');
  const id = $uuid();
  db.prepare('INSERT INTO models(id, kind, name, provider, base_url, api_key, model_name, is_default, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, kind, String(name).slice(0, 80), String(provider).slice(0, 80), normalizeBaseUrl(base_url), String(api_key), String(model_name).slice(0, 120), is_default ? 1 : 0, now());
  if (is_default) db.prepare('UPDATE models SET is_default = 0 WHERE kind = ? AND id != ?').run(kind, id);
  res.json({ model: modelRow(db.prepare('SELECT * FROM models WHERE id = ?').get(id)) });
});

router.put('/models/:id', (req, res) => {
  if (!isPlatformAdmin(req.user)) return err(res, 403, '需要平台管理员权限');
  const m = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
  if (!m) return err(res, 404, '模型不存在');
  const { name, provider, base_url, api_key, model_name, is_default } = req.body || {};
  if (name != null) db.prepare('UPDATE models SET name = ? WHERE id = ?').run(String(name).slice(0, 80), m.id);
  if (provider != null) db.prepare('UPDATE models SET provider = ? WHERE id = ?').run(String(provider).slice(0, 80), m.id);
  if (base_url != null) db.prepare('UPDATE models SET base_url = ? WHERE id = ?').run(normalizeBaseUrl(base_url), m.id);
  if (api_key != null && api_key !== '••••••••') db.prepare('UPDATE models SET api_key = ? WHERE id = ?').run(String(api_key), m.id);
  if (model_name != null) db.prepare('UPDATE models SET model_name = ? WHERE id = ?').run(String(model_name).slice(0, 120), m.id);
  if (is_default != null){
    if (is_default) db.prepare('UPDATE models SET is_default = 0 WHERE kind = ? AND id != ?').run(m.kind, m.id);
    db.prepare('UPDATE models SET is_default = ? WHERE id = ?').run(is_default ? 1 : 0, m.id);
  }
  res.json({ model: modelRow(db.prepare('SELECT * FROM models WHERE id = ?').get(m.id)) });
});

router.delete('/models/:id', (req, res) => {
  if (!isPlatformAdmin(req.user)) return err(res, 403, '需要平台管理员权限');
  db.prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/models/test', async (req, res) => {
  if (!isPlatformAdmin(req.user)) return err(res, 403, '需要平台管理员权限');
  const { kind = 'chat', base_url, api_key = '', model_name } = req.body || {};
  if (!base_url || !model_name) return err(res, 400, '接口地址与模型 ID 不能为空');
  const base = normalizeBaseUrl(base_url);
  const headers = { 'Content-Type': 'application/json', ...(api_key && api_key !== '••••••••' ? { Authorization: `Bearer ${api_key}` } : {}) };
  const isEmbedding = kind === 'embedding';
  const isRerank = kind === 'rerank';
  try {
    const url = base + (isEmbedding ? '/embeddings' : isRerank ? '/rerank' : '/chat/completions');
    const body = isEmbedding
      ? { model: model_name, input: '测试企业知识库向量模型' }
      : isRerank
        ? { model: model_name, query: '企业知识库', documents: ['企业知识库第一段测试文档', '企业知识库第二段测试文档'] }
      : { model: model_name, messages: [{ role: 'user', content: '你好' }], max_tokens: 8 };
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok){
      const detail = await r.text().catch(() => '');
      return res.json({ ok: false, message: `接口返回 ${r.status}${detail ? '：' + detail.replace(/\s+/g, ' ').slice(0, 200) : ''}` });
    }
    const j = await r.json();
    if (isRerank){
      const n = j.results?.length;
      if (!n) return res.json({ ok: false, message: '接口可达，但未返回重排结果，请确认模型 ID 是否为 Rerank 模型' });
      return res.json({ ok: true, message: `连接成功，返回 ${n} 条重排结果` });
    }
    if (isEmbedding){
      const dim = j.data?.[0]?.embedding?.length;
      if (!dim) return res.json({ ok: false, message: '接口可达，但未返回向量数据，请确认模型 ID 是否为 Embedding 模型' });
      return res.json({ ok: true, message: `连接成功，返回 ${dim} 维向量` });
    }
    const reply = j.choices?.[0]?.message?.content || '';
    res.json({ ok: true, message: `连接成功${reply ? '，模型已回复：' + reply.slice(0, 30) : ''}` });
  } catch (e){
    const code = e?.cause?.code || '';
    let hint = e.message;
    if (code === 'ENOTFOUND') hint = `域名无法解析：${base}（Docker 内部地址 host.docker.internal 在宿主机上不可用，请改用 127.0.0.1 或实际 IP）`;
    else if (code === 'ECONNREFUSED') hint = `无法连接到 ${base}，请确认服务已启动且端口正确`;
    else if (e.name === 'TimeoutError') hint = '连接超时（20 秒）';
    res.json({ ok: false, message: '连接失败：' + hint });
  }
});

// ============ 我的记忆 ============
router.get('/memories', (req, res) => {
  const rows = db.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ memories: rows });
});
router.post('/memories', (req, res) => {
  const { content } = req.body || {};
  if (!content || !String(content).trim()) return err(res, 400, '内容不能为空');
  const id = $uuid();
  db.prepare('INSERT INTO memories(id, user_id, content, created_at) VALUES(?,?,?,?)').run(id, req.user.id, String(content).trim().slice(0, 500), now());
  res.json({ memory: db.prepare('SELECT * FROM memories WHERE id = ?').get(id) });
});
router.delete('/memories/:id', (req, res) => {
  db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ============ ⌘K 全局搜索 ============
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ kbs: [], agents: [], sessions: [] });
  const kbs = visibleKbs(req.user.id)
    .filter(kb => (kb.name + kb.description).toLowerCase().includes(q)).slice(0, 6)
    .map(kb => ({ id: kb.id, name: kb.name }));
  const agents = db.prepare('SELECT * FROM agents WHERE owner_id = ?').all(req.user.id)
    .filter(a => (a.name + a.description).toLowerCase().includes(q)).slice(0, 6)
    .map(a => ({ id: a.id, name: a.name }));
  const sessions = db.prepare('SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC').all(req.user.id)
    .filter(s => s.title.toLowerCase().includes(q)).slice(0, 6)
    .map(s => ({ id: s.id, title: s.title }));
  res.json({ kbs, agents, sessions });
});

export default router;
