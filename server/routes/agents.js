import { Router } from 'express';
import { db } from '../db.js';
import { $uuid, now, err } from '../util.js';
import { authRequired } from '../auth.js';

const router = Router();
router.use(authRequired);

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
  const { name, description = '', color = '', system_prompt = '', model = '', kb_ids = [], tools = [] } = req.body || {};
  if (!name || !String(name).trim()) return err(res, 400, '请填写智能体名称');
  const id = $uuid();
  db.prepare('INSERT INTO agents(id, owner_id, name, description, color, system_prompt, model, kb_ids, tools, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, String(name).trim().slice(0, 60), String(description).slice(0, 300), color,
      String(system_prompt).slice(0, 4000), String(model), JSON.stringify(kb_ids || []), JSON.stringify(tools || []), now(), now());
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
  if (kb_ids != null) db.prepare('UPDATE agents SET kb_ids = ? WHERE id = ?').run(JSON.stringify(kb_ids || []), a.id);
  if (tools != null) db.prepare('UPDATE agents SET tools = ? WHERE id = ?').run(JSON.stringify(tools || []), a.id);
  db.prepare('UPDATE agents SET updated_at = ? WHERE id = ?').run(now(), a.id);
  res.json({ agent: agentRow(db.prepare('SELECT * FROM agents WHERE id = ?').get(a.id)) });
});

router.delete('/agents/:id', (req, res) => {
  db.prepare('DELETE FROM agents WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

export default router;
