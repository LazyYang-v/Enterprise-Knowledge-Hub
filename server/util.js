import crypto from 'node:crypto';

export const $uuid = () => crypto.randomUUID();
export const now = () => Date.now();

export function hashPassword(password){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
export function verifyPassword(password, stored){
  try {
    const [salt, hash] = String(stored).split(':');
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch { return false; }
}
export const $token = () => crypto.randomBytes(32).toString('hex');

export function fmtTime(ts){
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fmtDate(ts){
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function fmtSize(bytes){
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function timeGroup(ts){
  const d = new Date(ts);
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  if (d >= startOfToday) return '今天';
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
  if (d >= startOfYesterday) return '昨天';
  const week = new Date(startOfToday.getTime() - 6 * 86400000);
  if (d >= week) return '7 天内';
  const month = new Date(startOfToday.getTime() - 29 * 86400000);
  if (d >= month) return '30 天内';
  return '更早';
}

export function trimTitle(s, n = 24){
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s || '未命名对话';
}

export function err(res, status, message){
  return res.status(status).json({ error: message });
}

export function sseInit(res){
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':\n\n');
}
export function sseSend(res, obj){
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
}

// busboy 默认按 latin1 解析 multipart 头部，还原 UTF-8 文件名
export function fixFileName(name){
  if (!/[\u0080-ÿ]/.test(name)) return name;
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    return fixed.includes('�') ? name : fixed;
  } catch { return name; }
}
