import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './db.js';
import { config } from './config.js';
import { findByToken, touchServicePrincipal } from './control/service-principal-repo.js';

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

function legacyPrincipal(){
  const configured = [...config.knowledge.serviceKbScope];
  return {
    id: 'legacy-service-token',
    name: 'legacy-service-token',
    tenantId: null,
    legacy: true,
    scopes: {
      all_kbs: configured.length === 0,
      kb_ids: configured,
      tools: ['search_knowledge', 'get_document'],
    },
  };
}

/**
 * 先按 token_hash 查 PG 服务主体；显式开启兼容时再回退旧 EKH_SERVICE_TOKEN。
 * 返回 { id, name, tenantId, scopes } 或 null；不返回 token/hash。
 */
export async function authenticateServiceToken(token){
  if (!token) return null;
  try {
    const row = await findByToken(token);
    if (row){
      await touchServicePrincipal(row.id);
      const scopes = row.scopes && typeof row.scopes === 'object' ? row.scopes : {};
      return {
        id: row.id,
        name: row.name,
        tenantId: row.tenant_id,
        legacy: false,
        scopes: {
          all_kbs: !!scopes.all_kbs,
          kb_ids: Array.isArray(scopes.kb_ids) ? scopes.kb_ids.map(String) : [],
          tools: Array.isArray(scopes.tools) ? scopes.tools.map(String) : [],
        },
      };
    }
  } catch (e){
    // 控制面不可用时保留旧令牌兼容路径，避免旧 MCP/检索完全中断。
    if (!config.service.legacyTokenEnabled) throw e;
  }
  if (config.service.legacyTokenEnabled && isServiceToken(token)) return legacyPrincipal();
  return null;
}

export function principalAllowsTool(principal, toolName){
  const tools = principal?.scopes?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return tools.includes(toolName);
}
