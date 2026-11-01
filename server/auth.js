import { Router } from 'express';
import { db } from './db.js';
import { $uuid, $token, hashPassword, verifyPassword, now, err } from './util.js';

export const authRequired = (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
  if (!token) return err(res, 401, '未登录');
  const row = db.prepare('SELECT * FROM auth_tokens WHERE token = ?').get(token);
  if (!row || row.expires_at < now()) return err(res, 401, '登录已过期，请重新登录');
  const user = db.prepare('SELECT id, email, name, theme, created_at FROM users WHERE id = ?').get(row.user_id);
  if (!user) return err(res, 401, '账户不存在');
  req.user = user;
  req.token = token;
  next();
};

export function issueToken(userId){
  const token = $token();
  db.prepare('INSERT INTO auth_tokens(token, user_id, created_at, expires_at) VALUES(?,?,?,?)')
    .run(token, userId, now(), now() + 30 * 86400000);
  return token;
}

export function userRole(user){
  const owned = db.prepare('SELECT COUNT(*) c FROM orgs WHERE owner_id = ?').get(user.id).c;
  return owned > 0 ? 'Owner' : 'Member';
}

const router = Router();

router.post('/register', (req, res) => {
  const { email, name, password } = req.body || {};
  if (!email || !password) return err(res, 400, '邮箱和密码不能为空');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(res, 400, '邮箱格式不正确');
  if (String(password).length < 6) return err(res, 400, '密码至少 6 位');
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (exists) return err(res, 400, '该邮箱已注册');
  const id = $uuid();
  db.prepare('INSERT INTO users(id, email, name, password_hash, theme, created_at) VALUES(?,?,?,?,?,?)')
    .run(id, String(email).toLowerCase(), (name || String(email).split('@')[0]).slice(0, 32), hashPassword(String(password)), 'light', now());
  const user = db.prepare('SELECT id, email, name, theme, created_at FROM users WHERE id = ?').get(id);
  res.json({ token: issueToken(id), user: { ...user, role: userRole(user) } });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!row || !verifyPassword(String(password || ''), row.password_hash)) return err(res, 401, '邮箱或密码错误');
  res.json({ token: issueToken(row.id), user: { id: row.id, email: row.email, name: row.name, theme: row.theme, created_at: row.created_at, role: userRole(row) } });
});

router.post('/logout', authRequired, (req, res) => {
  db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

router.get('/me', authRequired, (req, res) => {
  res.json({ user: { ...req.user, role: userRole(req.user) } });
});

router.put('/me', authRequired, (req, res) => {
  const { name, password, theme } = req.body || {};
  if (name != null) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(name).slice(0, 32), req.user.id);
  if (theme != null) db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme === 'dark' ? 'dark' : 'light', req.user.id);
  if (password != null){
    if (String(password).length < 6) return err(res, 400, '密码至少 6 位');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(password)), req.user.id);
  }
  const user = db.prepare('SELECT id, email, name, theme, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: { ...user, role: userRole(user) } });
});

export default router;
