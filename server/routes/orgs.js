import { Router } from 'express';
import { db } from '../db.js';
import { $uuid, now, err } from '../util.js';
import { authRequired } from '../auth.js';

const router = Router();
router.use(authRequired);

const ROLES = ['owner', 'admin', 'contributor', 'viewer'];
export const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', contributor: 'Contributor', viewer: 'Viewer' };

function orgRow(user, o){
  const members = db.prepare('SELECT u.id, u.name, u.email, m.role, m.joined_at FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.joined_at').all(o.id);
  const kbCount = db.prepare('SELECT COUNT(*) c FROM knowledge_bases WHERE org_id = ?').get(o.id).c;
  return {
    id: o.id, name: o.name, description: o.description, owner_id: o.owner_id,
    invite_code: o.invite_code, kb_count: kbCount,
    members: members.map(m => ({ ...m, role_label: ROLE_LABEL[m.role] || m.role })),
    my_role: (members.find(m => m.id === user.id) || {}).role || null,
    created_at: o.created_at,
  };
}

router.get('/orgs', (req, res) => {
  const rows = db.prepare(
    `SELECT o.* FROM orgs o WHERE o.owner_id = ? OR o.id IN (SELECT org_id FROM org_members WHERE user_id = ?)
     ORDER BY o.created_at`
  ).all(req.user.id, req.user.id);
  res.json({ orgs: rows.map(o => orgRow(req.user, o)) });
});

router.post('/orgs', (req, res) => {
  const { name, description = '' } = req.body || {};
  if (!name || !String(name).trim()) return err(res, 400, '请填写空间名称');
  const id = $uuid();
  const code = 'ORG-' + $uuid().slice(0, 6).toUpperCase();
  db.prepare('INSERT INTO orgs(id, name, description, owner_id, invite_code, created_at) VALUES(?,?,?,?,?,?)')
    .run(id, String(name).trim().slice(0, 60), String(description).slice(0, 300), req.user.id, code, now());
  db.prepare('INSERT INTO org_members(org_id, user_id, role, joined_at) VALUES(?,?,?,?)').run(id, req.user.id, 'owner', now());
  res.json({ org: orgRow(req.user, db.prepare('SELECT * FROM orgs WHERE id = ?').get(id)) });
});

router.post('/orgs/join', (req, res) => {
  const { code } = req.body || {};
  const org = db.prepare('SELECT * FROM orgs WHERE invite_code = ?').get(String(code || '').trim().toUpperCase());
  if (!org) return err(res, 404, '邀请码无效');
  const exists = db.prepare('SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?').get(org.id, req.user.id);
  if (!exists) db.prepare('INSERT INTO org_members(org_id, user_id, role, joined_at) VALUES(?,?,?,?)').run(org.id, req.user.id, 'contributor', now());
  res.json({ org: orgRow(req.user, org) });
});

router.put('/orgs/:id/members/:uid', (req, res) => {
  const o = db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.params.id);
  if (!o) return err(res, 404, '空间不存在');
  if (o.owner_id !== req.user.id) return err(res, 403, '只有空间创建者可以管理成员');
  const { role } = req.body || {};
  if (!ROLES.includes(role)) return err(res, 400, '角色不合法');
  if (req.params.uid === o.owner_id) return err(res, 400, '不能修改创建者的角色');
  db.prepare('UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?').run(role, o.id, req.params.uid);
  res.json({ org: orgRow(req.user, o) });
});

router.delete('/orgs/:id/members/:uid', (req, res) => {
  const o = db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.params.id);
  if (!o) return err(res, 404, '空间不存在');
  if (o.owner_id !== req.user.id && req.params.uid !== req.user.id) return err(res, 403, '没有权限');
  if (req.params.uid === o.owner_id) return err(res, 400, '创建者不能被移除');
  db.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?').run(o.id, req.params.uid);
  res.json({ ok: true });
});

router.post('/orgs/:id/leave', (req, res) => {
  const o = db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.params.id);
  if (!o) return err(res, 404, '空间不存在');
  if (o.owner_id === req.user.id) return err(res, 400, '创建者不能退出自己的空间，请直接删除空间');
  db.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?').run(o.id, req.user.id);
  res.json({ ok: true });
});

router.delete('/orgs/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.params.id);
  if (!o) return err(res, 404, '空间不存在');
  if (o.owner_id !== req.user.id) return err(res, 403, '只有创建者可以删除空间');
  db.prepare('UPDATE knowledge_bases SET org_id = NULL WHERE org_id = ?').run(o.id);
  db.prepare('DELETE FROM org_members WHERE org_id = ?').run(o.id);
  db.prepare('DELETE FROM orgs WHERE id = ?').run(o.id);
  res.json({ ok: true });
});

export default router;
