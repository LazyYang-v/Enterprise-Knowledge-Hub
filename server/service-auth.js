import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './db.js';

// 机器对机器访问令牌（DSH MCP / 检索 API 用）。优先取 EKH_SERVICE_TOKEN；
// 未设置时在 data/service-token 生成并复用一份随机令牌。
const TOKEN_FILE = path.join(DATA_DIR, 'service-token');

function loadServiceToken(){
  if (process.env.EKH_SERVICE_TOKEN) return process.env.EKH_SERVICE_TOKEN;
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch { /* 首次运行 */ }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}

export const SERVICE_TOKEN = loadServiceToken();

export function isServiceToken(value){
  if (!value) return false;
  const a = Buffer.from(String(value));
  const b = Buffer.from(SERVICE_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function bearerToken(req){
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
