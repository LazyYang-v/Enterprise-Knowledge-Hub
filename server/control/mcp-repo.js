// MCP 连接与工具缓存仓储。凭证只保存 credential_ref，任何查询都不回显密钥。
import { getPool } from './pg.js';
import { assertMcpEndpoint } from '../tools/egress-policy.js';

export class McpConnectionError extends Error {
  constructor(message, code = 'mcp_connection_invalid', status = 400){
    super(message);
    this.name = 'McpConnectionError';
    this.code = code;
    this.status = status;
  }
}

const CONNECTION_NAME_RE = /^[a-zA-Z0-9_-]{1,60}$/;

export function assertConnectionName(name){
  if (!CONNECTION_NAME_RE.test(String(name || ''))){
    throw new McpConnectionError('连接名只能包含字母、数字、下划线与连字符（最多 60）');
  }
}

export async function listConnections(tenantId){
  const r = await getPool().query(
    'SELECT * FROM mcp_connections WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId],
  );
  return r.rows;
}

export async function getConnection({ tenantId, id = null, name = null }){
  if (id){
    const r = await getPool().query(
      'SELECT * FROM mcp_connections WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return r.rows[0] || null;
  }
  if (name){
    const r = await getPool().query(
      'SELECT * FROM mcp_connections WHERE tenant_id = $1 AND name = $2',
      [tenantId, name],
    );
    return r.rows[0] || null;
  }
  return null;
}

export async function createConnection({
  tenantId, name, transport = 'streamable_http', endpoint, authType = 'none',
  credentialRef = '', allowedTools = [], deniedTools = [], egressAllowlist = [],
}){
  assertConnectionName(name);
  if (transport === 'stdio') throw new McpConnectionError('P0 不支持 stdio MCP 连接', 'mcp_stdio_disabled');
  if (!/^https?:\/\//i.test(String(endpoint || ''))) throw new McpConnectionError('endpoint 必须是 http/https URL');
  const allowlist = Array.isArray(egressAllowlist) ? egressAllowlist.map(String).filter(Boolean).slice(0, 50) : [];
  try {
    await assertMcpEndpoint({ endpoint, egress_allowlist: allowlist });
  } catch (e){
    throw new McpConnectionError(e.message, 'mcp_egress_denied', 400);
  }
  try {
    const r = await getPool().query(
      `INSERT INTO mcp_connections
         (tenant_id, name, transport, endpoint, auth_type, credential_ref, allowed_tools, denied_tools, egress_allowlist)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) RETURNING *`,
      [tenantId, name, transport, endpoint, authType, credentialRef,
        JSON.stringify(allowedTools || []), JSON.stringify(deniedTools || []), JSON.stringify(allowlist)],
    );
    return r.rows[0];
  } catch (e){
    if (e.code === '23505') throw new McpConnectionError('连接名已存在', 'mcp_connection_exists', 409);
    throw e;
  }
}

export async function updateConnection({ tenantId, id, patch = {} }){
  const allowed = ['endpoint', 'auth_type', 'credential_ref', 'allowed_tools', 'denied_tools', 'status', 'egress_allowlist'];
  const sets = [];
  const params = [tenantId, id];
  const current = await getConnection({ tenantId, id });
  if (!current) return null;
  const nextEndpoint = patch.endpoint ?? current.endpoint;
  const nextAllowlist = patch.egress_allowlist ?? current.egress_allowlist ?? [];
  if (patch.endpoint != null || patch.egress_allowlist != null){
    if (!/^https?:\/\//i.test(String(nextEndpoint || ''))){
      throw new McpConnectionError('endpoint 必须是 http/https URL');
    }
    try {
      await assertMcpEndpoint({ endpoint: nextEndpoint, egress_allowlist: nextAllowlist });
    } catch (e){
      throw new McpConnectionError(e.message, 'mcp_egress_denied', 400);
    }
  }
  for (const [key, value] of Object.entries(patch)){
    if (!allowed.includes(key)) throw new McpConnectionError(`不允许更新字段：${key}`);
    if (key === 'endpoint' && !/^https?:\/\//i.test(String(value || ''))){
      throw new McpConnectionError('endpoint 必须是 http/https URL');
    }
    params.push(Array.isArray(value) ? JSON.stringify(value) : value);
    const cast = Array.isArray(value) ? '::jsonb' : '';
    sets.push(`${key} = $${params.length}${cast}`);
  }
  if (!sets.length) return getConnection({ tenantId, id });
  const r = await getPool().query(
    `UPDATE mcp_connections SET ${sets.join(', ')}, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    params,
  );
  return r.rows[0] || null;
}

export async function deleteConnection({ tenantId, id }){
  const r = await getPool().query(
    'DELETE FROM mcp_connections WHERE tenant_id = $1 AND id = $2 RETURNING *',
    [tenantId, id],
  );
  return r.rows[0] || null;
}

export async function upsertCachedTools({ connectionId, tools = [] }){
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const seen = new Set();
    for (const tool of tools){
      seen.add(tool.name);
      await client.query(
        `INSERT INTO mcp_tool_cache
           (connection_id, tool_name, description, input_schema, schema_hash, discovered_at, enabled)
         VALUES ($1,$2,$3,$4::jsonb,$5,now(),true)
         ON CONFLICT (connection_id, tool_name) DO UPDATE SET
           description = EXCLUDED.description,
           input_schema = EXCLUDED.input_schema,
           schema_hash = EXCLUDED.schema_hash,
           discovered_at = now()`,
        [connectionId, tool.name, tool.description || '', JSON.stringify(tool.input_schema || {}), tool.schema_hash],
      );
    }
    // 未再发现但仍被允许的工具保留缓存，标记停用，避免运行中任务静默换 schema。
    const existing = await client.query('SELECT tool_name FROM mcp_tool_cache WHERE connection_id = $1', [connectionId]);
    for (const row of existing.rows){
      if (!seen.has(row.tool_name)){
        await client.query(
          'UPDATE mcp_tool_cache SET enabled = false WHERE connection_id = $1 AND tool_name = $2',
          [connectionId, row.tool_name],
        );
      }
    }
    await client.query('COMMIT');
  } catch (e){
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listCachedTools(connectionId){
  const r = await getPool().query(
    'SELECT * FROM mcp_tool_cache WHERE connection_id = $1 ORDER BY tool_name',
    [connectionId],
  );
  return r.rows;
}

export async function touchConnectionHealth({ connectionId, ok }){
  await getPool().query(
    `UPDATE mcp_connections SET last_health_at = now(), status = $2, updated_at = now()
      WHERE id = $1`,
    [connectionId, ok ? 'active' : 'error'],
  ).catch(() => {});
}

/** 从 mcp.<connection>.<tool> 解析连接。连接名在创建时已限制不含点。 */
export async function connectionForToolName({ tenantId, toolName }){
  const rest = String(toolName || '').slice('mcp.'.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const name = rest.slice(0, dot);
  const tool = rest.slice(dot + 1);
  const connection = await getConnection({ tenantId, name });
  if (!connection) return null;
  return { connection, tool };
}
