import { Router } from 'express';
import { db } from '../db.js';
import { $uuid, now, err } from '../util.js';
import { authRequired } from '../auth.js';
import { intersectVisibleKbIds } from '../knowledge/acl.js';
import { getCustomTool } from '../tools/custom-tools-repo.js';

const router = Router();
router.use(authRequired);

const BUILTIN_AGENT_TOOLS = new Set(['web-search', 'mcp', 'browser']);

function bindableTools(res, userId, value){
  if (value == null) return [];
  if (!Array.isArray(value)){ err(res, 400, 'tools 必须是数组'); return null; }
  if (value.length > 20){ err(res, 400, 'tools 最多 20 项'); return null; }
  const keys = [...new Set(value.map(String).filter(Boolean))];
  for (const key of keys){
    if (key.startsWith('custom:')){
      const tool = getCustomTool(key.slice(7), { ownerId: userId });
      if (!tool || !tool.enabled){
        err(res, 403, `无权使用或工具不可用: ${key}`);
        return null;
      }
      continue;
    }
    if (!BUILTIN_AGENT_TOOLS.has(key)){
      err(res, 400, `未知工具: ${key}`);
      return null;
    }
  }
  return keys;
}

function bindableKbIds(res, userId, value){
  if (value == null) return [];
  if (!Array.isArray(value)){ err(res, 400, 'kb_ids 必须是数组'); return null; }
  const ids = [...new Set(value.map(String).filter(Boolean))];
  const { denied } = intersectVisibleKbIds(userId, ids);
  if (denied.length){ err(res, 403, `无权访问知识库: ${denied.join(', ')}`); return null; }
  return ids;
}

function agentRow(a){
  const kbs = JSON.parse(a.kb_ids || '[]');
  const tools = JSON.parse(a.tools || '[]');
  return {
    id: a.id, name: a.name, description: a.description, color: a.color,
    system_prompt: a.system_prompt, model: a.model,
    kb_ids: kbs, tools,
    kb_count: kbs.length, tool_count: tools.length,
    model_name: a.model ? (db.prepare('SELECT name FROM models WHERE id = ?').get(a.model)?.name || '') : '',
    created_at: a.created_at, updated_at: a.updated_at,
  };
}

router.get('/agents', (req, res) => {
  const rows = db.prepare('SELECT * FROM agents WHERE owner_id = ? ORDER BY updated_at DESC').all(req.user.id);
  res.json({ agents: rows.map(agentRow) });
});

router.post('/agents', (req, res) => {
  const { name, description = '', color = '', system_prompt = '', model = '', tools = [] } = req.body || {};
  if (!name || !String(name).trim()) return err(res, 400, '请填写智能体名称');
  const kbIds = bindableKbIds(res, req.user.id, req.body?.kb_ids ?? []);
  if (!kbIds) return;
  const toolKeys = bindableTools(res, req.user.id, tools);
  if (!toolKeys) return;
  const id = $uuid();
  db.prepare('INSERT INTO agents(id, owner_id, name, description, color, system_prompt, model, kb_ids, tools, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, String(name).trim().slice(0, 60), String(description).slice(0, 300), color,
      String(system_prompt).slice(0, 4000), String(model), JSON.stringify(kbIds), JSON.stringify(toolKeys), now(), now());
  const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  res.json({ agent: agentRow(a) });
});

router.put('/agents/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM agents WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!a) return err(res, 404, '智能体不存在');
  const { name, description, color, system_prompt, model, kb_ids, tools } = req.body || {};
  if (name != null && String(name).trim()) db.prepare('UPDATE agents SET name = ? WHERE id = ?').run(String(name).trim().slice(0, 60), a.id);
  if (description != null) db.prepare('UPDATE agents SET description = ? WHERE id = ?').run(String(description).slice(0, 300), a.id);
  if (color != null) db.prepare('UPDATE agents SET color = ? WHERE id = ?').run(String(color), a.id);
  if (system_prompt != null) db.prepare('UPDATE agents SET system_prompt = ? WHERE id = ?').run(String(system_prompt).slice(0, 4000), a.id);
  if (model !== undefined) db.prepare('UPDATE agents SET model = ? WHERE id = ?').run(String(model || ''), a.id);
  if (kb_ids != null){
    const kbIds = bindableKbIds(res, req.user.id, kb_ids);
    if (!kbIds) return;
    db.prepare('UPDATE agents SET kb_ids = ? WHERE id = ?').run(JSON.stringify(kbIds), a.id);
  }
  if (tools != null){
    const toolKeys = bindableTools(res, req.user.id, tools);
    if (!toolKeys) return;
    db.prepare('UPDATE agents SET tools = ? WHERE id = ?').run(JSON.stringify(toolKeys), a.id);
  }
  db.prepare('UPDATE agents SET updated_at = ? WHERE id = ?').run(now(), a.id);
  res.json({ agent: agentRow(db.prepare('SELECT * FROM agents WHERE id = ?').get(a.id)) });
});

router.delete('/agents/:id', (req, res) => {
  db.prepare('DELETE FROM agents WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

export default router;
