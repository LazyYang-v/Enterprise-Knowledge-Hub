// 模型 profile 仓储：凭证只保存 credential_ref，API 只返回 credential_configured。
import { getPool } from './pg.js';
import { credentialConfigured } from './credentials.js';

function safe(row){
  if (!row) return null;
  return {
    id: row.id, tenant_id: row.tenant_id, name: row.name, provider: row.provider,
    base_url: row.base_url, model_name: row.model_name,
    credential_ref: row.credential_ref ? 'configured' : '',
    credential_configured: credentialConfigured(row.credential_ref),
    capabilities: row.capabilities || {}, context_window: row.context_window,
    enabled: !!row.enabled, created_at: row.created_at, updated_at: row.updated_at,
  };
}

export function isPrivateHost(hostname){
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (['localhost', '0.0.0.0', '::1', 'metadata.google.internal'].includes(h)) return true;
  if (h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

export function assertModelBaseUrl(value){
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new ModelProfileError('base_url 不是合法 URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ModelProfileError('base_url 只支持 http/https');
  if (isPrivateHost(url.hostname)) throw new ModelProfileError('base_url 不能指向本机、私网或元数据地址');
  return url.toString().replace(/\/+$/, '');
}

export class ModelProfileError extends Error {
  constructor(message, code = 'model_profile_invalid', status = 400){
    super(message);
    this.name = 'ModelProfileError';
    this.code = code;
    this.status = status;
  }
}

export async function listModelProfiles(tenantId){
  const r = await getPool().query(
    'SELECT * FROM model_profiles WHERE tenant_id = $1 ORDER BY name',
    [tenantId],
  );
  return r.rows.map(safe);
}

export async function getModelProfile({ tenantId, id }){
  const r = await getPool().query(
    'SELECT * FROM model_profiles WHERE tenant_id = $1 AND id = $2',
    [tenantId, id],
  );
  return r.rows[0] || null;
}

export async function getModelProfileSafe({ tenantId, id }){
  return safe(await getModelProfile({ tenantId, id }));
}

export async function createModelProfile({
  tenantId, name, provider = '', baseUrl, modelName, credentialRef = '',
  capabilities = {}, contextWindow = null, enabled = true,
}){
  if (!name || !modelName) throw new ModelProfileError('name 与 model_name 不能为空');
  const base = assertModelBaseUrl(baseUrl);
  try {
    const r = await getPool().query(
      `INSERT INTO model_profiles
         (tenant_id, name, provider, base_url, model_name, credential_ref, capabilities, context_window, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
      [tenantId, String(name).slice(0, 120), String(provider).slice(0, 80), base,
        String(modelName).slice(0, 160), credentialRef,
        JSON.stringify(capabilities || {}), contextWindow, !!enabled],
    );
    return safe(r.rows[0]);
  } catch (e){
    if (e.code === '23505') throw new ModelProfileError('模型 profile 名称已存在', 'model_profile_exists', 409);
    throw e;
  }
}

export async function updateModelProfile({ tenantId, id, patch = {} }){
  const row = await getModelProfile({ tenantId, id });
  if (!row) return null;
  const allowed = ['name', 'provider', 'base_url', 'model_name', 'credential_ref', 'capabilities', 'context_window', 'enabled'];
  const sets = [];
  const params = [tenantId, id];
  for (const [key, value] of Object.entries(patch)){
    if (!allowed.includes(key)) continue;
    if (key === 'base_url') value = assertModelBaseUrl(value);
    if (key === 'capabilities'){ params.push(JSON.stringify(value || {})); sets.push(`capabilities = $${params.length}::jsonb`); continue; }
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  if (!sets.length) return safe(row);
  const r = await getPool().query(
    `UPDATE model_profiles SET ${sets.join(', ')}, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    params,
  );
  return safe(r.rows[0]);
}

export async function deleteModelProfile({ tenantId, id }){
  const r = await getPool().query(
    'DELETE FROM model_profiles WHERE tenant_id = $1 AND id = $2 RETURNING id',
    [tenantId, id],
  );
  return r.rowCount > 0;
}

export function modelFromProfile(profile, credential){
  return {
    base_url: profile.base_url,
    model_name: profile.model_name,
    api_key: credential || '',
    provider: profile.provider || '',
  };
}

export function toSafeModelProfile(row){
  return safe(row);
}
