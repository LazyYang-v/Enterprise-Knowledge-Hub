// 控制面工具注册表仓储。内置/自定义/MCP 的描述统一落到 tool_registry；
// custom 工具的代码与版本仍以 SQLite 知识面为准，这里只存可审计描述。
import { getPool } from './pg.js';

export async function upsertToolRegistry({
  tenantId, name, version, source, description = '', inputSchema = {}, outputSchema = null,
  sideEffect = 'read', approvalPolicy = 'risk_based', timeoutMs = 30000,
  idempotency = 'none', resourceScope = 'task', sandboxProfile = 'read_only',
  dataClassification = 'internal', rateLimit = {}, schemaHash, ownerId = '', enabled = true,
} = {}){
  const r = await getPool().query(
    `INSERT INTO tool_registry
       (tenant_id, name, version, source, description, input_schema, output_schema,
        side_effect, approval_policy, timeout_ms, idempotency, resource_scope,
        sandbox_profile, data_classification, rate_limit, schema_hash, owner_id, enabled)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18)
     ON CONFLICT (tenant_id, name, version) DO UPDATE SET
       description = EXCLUDED.description,
       input_schema = EXCLUDED.input_schema,
       output_schema = EXCLUDED.output_schema,
       side_effect = EXCLUDED.side_effect,
       approval_policy = EXCLUDED.approval_policy,
       timeout_ms = EXCLUDED.timeout_ms,
       idempotency = EXCLUDED.idempotency,
       resource_scope = EXCLUDED.resource_scope,
       sandbox_profile = EXCLUDED.sandbox_profile,
       data_classification = EXCLUDED.data_classification,
       rate_limit = EXCLUDED.rate_limit,
       schema_hash = EXCLUDED.schema_hash,
       owner_id = EXCLUDED.owner_id,
       enabled = EXCLUDED.enabled,
       updated_at = now()
     RETURNING *`,
    [tenantId, name, version, source, description, JSON.stringify(inputSchema || {}),
      outputSchema == null ? null : JSON.stringify(outputSchema), sideEffect, approvalPolicy,
      timeoutMs, idempotency, resourceScope, sandboxProfile, dataClassification,
      JSON.stringify(rateLimit || {}), schemaHash, String(ownerId || ''), !!enabled],
  );
  return r.rows[0];
}

export async function getToolRegistryRow({ tenantId, name, version = null }){
  const params = [tenantId, name];
  let sql = 'SELECT * FROM tool_registry WHERE tenant_id = $1 AND name = $2';
  if (version != null){ params.push(version); sql += ' AND version = $3'; }
  sql += ' ORDER BY created_at DESC LIMIT 1';
  const r = await getPool().query(sql, params);
  return r.rows[0] || null;
}

export async function listToolRegistry({ tenantId, source = null, includeDisabled = false, ownerId = null } = {}){
  const params = [tenantId];
  const where = ['tenant_id = $1'];
  if (source){ params.push(source); where.push(`source = $${params.length}`); }
  if (!includeDisabled) where.push('enabled = true');
  if (ownerId != null){ params.push(String(ownerId)); where.push(`owner_id = $${params.length}`); }
  const r = await getPool().query(
    `SELECT * FROM tool_registry WHERE ${where.join(' AND ')}
      ORDER BY source, name, version DESC`,
    params,
  );
  return r.rows;
}

export async function setToolRegistryEnabled({ tenantId, name, enabled }){
  const r = await getPool().query(
    `UPDATE tool_registry SET enabled = $3, updated_at = now()
      WHERE tenant_id = $1 AND name = $2 RETURNING *`,
    [tenantId, name, !!enabled],
  );
  return r.rows;
}

export async function deleteToolRegistryByOwner({ tenantId, toolId }){
  await getPool().query(
    `DELETE FROM tool_registry WHERE tenant_id = $1 AND source = 'custom' AND owner_id = $2`,
    [tenantId, String(toolId)],
  );
}

export async function deleteMcpToolsForConnection({ tenantId, connectionName }){
  await getPool().query(
    `DELETE FROM tool_registry
      WHERE tenant_id = $1 AND source = 'mcp' AND name LIKE $2`,
    [tenantId, `mcp.${connectionName}.%`],
  );
}

export async function listToolPolicies({ tenantId, toolName = null }){
  const params = [tenantId];
  let where = 'tenant_id = $1';
  if (toolName){ params.push(toolName); where += ' AND tool_name = $2'; }
  const r = await getPool().query(
    `SELECT * FROM tool_policies WHERE ${where} ORDER BY tool_name, principal_type, principal_id`,
    params,
  );
  return r.rows;
}

export async function getToolPolicy({ tenantId, toolName, principalType, principalId }){
  const r = await getPool().query(
    `SELECT * FROM tool_policies
      WHERE tenant_id = $1 AND tool_name = $2 AND principal_type = $3 AND principal_id = $4`,
    [tenantId, toolName, principalType, String(principalId)],
  );
  return r.rows[0] || null;
}

export async function upsertToolPolicy({
  tenantId, toolName, principalType, principalId, approvalMode = 'risk_based',
  maxCallsPerTask = null, allowedScopes = [], enabled = true,
}){
  const r = await getPool().query(
    `INSERT INTO tool_policies
       (tenant_id, tool_name, principal_type, principal_id, approval_mode,
        max_calls_per_task, allowed_scopes, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     ON CONFLICT (tenant_id, tool_name, principal_type, principal_id) DO UPDATE SET
       approval_mode = EXCLUDED.approval_mode,
       max_calls_per_task = EXCLUDED.max_calls_per_task,
       allowed_scopes = EXCLUDED.allowed_scopes,
       enabled = EXCLUDED.enabled
     RETURNING *`,
    [tenantId, toolName, principalType, String(principalId), approvalMode,
      maxCallsPerTask == null ? null : Number(maxCallsPerTask),
      JSON.stringify(allowedScopes || []), !!enabled],
  );
  return r.rows[0];
}

export async function deleteToolPolicy({ tenantId, toolName, principalType, principalId }){
  const r = await getPool().query(
    `DELETE FROM tool_policies
      WHERE tenant_id = $1 AND tool_name = $2 AND principal_type = $3 AND principal_id = $4`,
    [tenantId, toolName, principalType, String(principalId)],
  );
  return r.rowCount > 0;
}
