// 入站服务身份：只保存 token 的 SHA-256；明文 token 仅在创建/轮换时返回一次。
import crypto from 'node:crypto';
import { getPool } from './pg.js';

export function hashToken(token){
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function newToken(){
  return 'ekh_' + crypto.randomBytes(32).toString('base64url');
}

function safeRow(row){
  if (!row) return null;
  return {
    id: row.id, name: row.name, scopes: row.scopes || {},
    expires_at: row.expires_at, last_used_at: row.last_used_at,
    created_by: row.created_by, created_at: row.created_at,
    revoked_at: row.revoked_at || null,
  };
}

export async function createServicePrincipal({
  tenantId, name, scopes = {}, expiresAt = null, createdBy = '',
}){
  const token = newToken();
  const r = await getPool().query(
    `INSERT INTO service_principals (tenant_id, name, token_hash, scopes, expires_at, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING *`,
    [tenantId, String(name).slice(0, 120), hashToken(token), JSON.stringify(scopes || {}), expiresAt, createdBy],
  );
  return { principal: safeRow(r.rows[0]), token };
}

export async function listServicePrincipals(tenantId){
  const r = await getPool().query(
    'SELECT * FROM service_principals WHERE tenant_id = $1 ORDER BY created_at DESC',
    [tenantId],
  );
  return r.rows.map(safeRow);
}

export async function getServicePrincipal({ tenantId, id }){
  const r = await getPool().query(
    'SELECT * FROM service_principals WHERE tenant_id = $1 AND id = $2',
    [tenantId, id],
  );
  return safeRow(r.rows[0]);
}

export async function revokeServicePrincipal({ tenantId, id }){
  const r = await getPool().query(
    `UPDATE service_principals SET revoked_at = now()
      WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING *`,
    [tenantId, id],
  );
  return safeRow(r.rows[0]);
}

export async function rotateServicePrincipal({ tenantId, id }){
  const token = newToken();
  const r = await getPool().query(
    `UPDATE service_principals SET token_hash = $3, revoked_at = NULL
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId, id, hashToken(token)],
  );
  if (!r.rowCount) return null;
  return { principal: safeRow(r.rows[0]), token };
}

export async function findByToken(token){
  const hash = hashToken(token);
  const r = await getPool().query(
    `SELECT * FROM service_principals
      WHERE token_hash = $1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())`,
    [hash],
  );
  return r.rows[0] || null;
}

export async function touchServicePrincipal(id){
  await getPool().query(
    'UPDATE service_principals SET last_used_at = now() WHERE id = $1',
    [id],
  ).catch(() => {});
}
