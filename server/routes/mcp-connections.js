// MCP 连接管理（PlatformAdmin / 管理员）。凭证只存 credential_ref，永不回显。
import { Router } from 'express';
import { authRequired } from '../auth.js';
import { config } from '../config.js';
import { err } from '../util.js';
import { isAdminUser } from '../auth/admin.js';
import { resolveTenantId } from '../control/tenants.js';
import { auditSafe } from '../control/audit-repo.js';
import {
  listConnections, getConnection, createConnection, updateConnection, deleteConnection,
  upsertCachedTools, listCachedTools, touchConnectionHealth, McpConnectionError,
} from '../control/mcp-repo.js';
import { listMcpTools } from '../tools/mcp-client.js';
import {
  upsertToolRegistry, getToolRegistryRow, listToolRegistry,
  deleteMcpToolsForConnection,
} from '../control/tool-registry-repo.js';

const router = Router();

router.use((req, res, next) => {
  if (!config.agentPlatformEnabled) return err(res, 404, '接口不存在');
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return err(res, 401, '需要 Bearer 令牌');
  next();
});
router.use(authRequired);
router.use((req, res, next) => {
  if (!isAdminUser(req.user)) return err(res, 403, '需要管理员权限');
  next();
});

function safeConnection(c){
  if (!c) return null;
  return {
    id: c.id, name: c.name, transport: c.transport, endpoint: c.endpoint,
    auth_type: c.auth_type, credential_configured: !!c.credential_ref,
    allowed_tools: c.allowed_tools || [], denied_tools: c.denied_tools || [],
    status: c.status, last_health_at: c.last_health_at,
    created_at: c.created_at, updated_at: c.updated_at,
  };
}

function fail(res, e, fallback = 'MCP 操作失败'){
  if (e instanceof McpConnectionError) return err(res, e.status, e.message);
  if (e?.code === 'mcp_unavailable') return err(res, 502, e.message);
  console.error('[mcp-connections]', e);
  return err(res, 500, fallback);
}

router.get('/', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    res.json({ connections: (await listConnections(tenantId)).map(safeConnection) });
  } catch (e){ fail(res, e); }
});

router.post('/', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const b = req.body || {};
    if (b.transport === 'stdio') return err(res, 400, 'P0 不支持 stdio MCP 连接');
    const connection = await createConnection({
      tenantId, name: b.name, transport: b.transport || 'streamable_http',
      endpoint: b.endpoint, authType: b.auth_type || 'none',
      credentialRef: b.credential_ref || '',
      allowedTools: b.allowed_tools || [], deniedTools: b.denied_tools || [],
    });
    await auditSafe({
      tenantId, actorType: 'user', actorId: req.user.id, action: 'mcp.connection.created',
      resourceType: 'mcp_connection', resourceId: connection.id, decision: 'allowed',
      detail: { name: connection.name, endpoint_host: new URL(connection.endpoint).host },
    });
    res.status(201).json({ connection: safeConnection(connection) });
  } catch (e){ fail(res, e); }
});

router.get('/:id', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const connection = await getConnection({ tenantId, id: req.params.id });
    if (!connection) return err(res, 404, 'MCP 连接不存在');
    res.json({ connection: safeConnection(connection) });
  } catch (e){ fail(res, e); }
});

router.patch('/:id', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const b = req.body || {};
    const patch = {};
    for (const key of ['endpoint', 'auth_type', 'credential_ref', 'allowed_tools', 'denied_tools', 'status']){
      if (b[key] !== undefined) patch[key] = b[key];
    }
    const connection = await updateConnection({ tenantId, id: req.params.id, patch });
    if (!connection) return err(res, 404, 'MCP 连接不存在');
    await auditSafe({
      tenantId, actorType: 'user', actorId: req.user.id, action: 'mcp.connection.updated',
      resourceType: 'mcp_connection', resourceId: connection.id, decision: 'allowed',
      detail: { fields: Object.keys(patch) },
    });
    res.json({ connection: safeConnection(connection) });
  } catch (e){ fail(res, e); }
});

router.delete('/:id', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const connection = await deleteConnection({ tenantId, id: req.params.id });
    if (!connection) return err(res, 404, 'MCP 连接不存在');
    await deleteMcpToolsForConnection({ tenantId, connectionName: connection.name });
    await auditSafe({
      tenantId, actorType: 'user', actorId: req.user.id, action: 'mcp.connection.deleted',
      resourceType: 'mcp_connection', resourceId: connection.id, decision: 'allowed',
    });
    res.json({ ok: true });
  } catch (e){ fail(res, e); }
});

router.post('/:id/test', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const connection = await getConnection({ tenantId, id: req.params.id });
    if (!connection) return err(res, 404, 'MCP 连接不存在');
    try {
      const tools = await listMcpTools({
        endpoint: connection.endpoint, credentialRef: connection.credential_ref,
      });
      await touchConnectionHealth({ connectionId: connection.id, ok: true });
      res.json({ ok: true, tools_count: tools.length });
    } catch (e){
      await touchConnectionHealth({ connectionId: connection.id, ok: false });
      res.json({ ok: false, message: String(e.message || '连接失败').slice(0, 300) });
    }
  } catch (e){ fail(res, e); }
});

async function refreshConnection(tenantId, connection, actorId){
  const discovered = await listMcpTools({
    endpoint: connection.endpoint, credentialRef: connection.credential_ref,
  });
  const allowed = Array.isArray(connection.allowed_tools) ? connection.allowed_tools : [];
  const denied = Array.isArray(connection.denied_tools) ? connection.denied_tools : [];
  const filtered = discovered.filter(t =>
    !denied.includes(t.name) && (allowed.length === 0 || allowed.includes(t.name)));

  await upsertCachedTools({ connectionId: connection.id, tools: filtered });
  const names = [];
  for (const tool of filtered){
    const name = `mcp.${connection.name}.${tool.name}`;
    names.push(name);
    const existing = await getToolRegistryRow({ tenantId, name, version: '1.0.0' });
    if (existing && existing.schema_hash !== tool.schema_hash){
      await auditSafe({
        tenantId, actorType: 'user', actorId, action: 'mcp.tool_schema_changed',
        resourceType: 'mcp_tool', resourceId: name, decision: 'allowed',
        detail: { connection_id: connection.id, tool_name: tool.name },
      });
    }
    await upsertToolRegistry({
      tenantId, name, version: '1.0.0', source: 'mcp',
      description: tool.description, inputSchema: tool.input_schema,
      sideEffect: tool.read_only ? 'read' : 'external_send',
      approvalPolicy: 'risk_based', timeoutMs: config.mcp.clientTimeoutMs,
      idempotency: tool.read_only ? 'none' : 'provider_key',
      resourceScope: 'external', sandboxProfile: 'network_allowlist',
      schemaHash: tool.schema_hash, enabled: true,
    });
  }
  // 刷新后未再出现的工具停用，旧任务因 schema_hash/不存在而失败。
  const registered = await listToolRegistry({ tenantId, source: 'mcp', includeDisabled: true });
  for (const row of registered){
    if (row.name.startsWith(`mcp.${connection.name}.`) && !names.includes(row.name)){
      await upsertToolRegistry({
        tenantId, name: row.name, version: row.version, source: 'mcp',
        description: row.description, inputSchema: row.input_schema,
        sideEffect: row.side_effect, approvalPolicy: row.approval_policy,
        timeoutMs: row.timeout_ms, idempotency: row.idempotency,
        resourceScope: row.resource_scope, sandboxProfile: row.sandbox_profile,
        schemaHash: row.schema_hash, enabled: false,
      });
    }
  }
  await touchConnectionHealth({ connectionId: connection.id, ok: true });
  return filtered;
}

router.post('/:id/refresh', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const connection = await getConnection({ tenantId, id: req.params.id });
    if (!connection) return err(res, 404, 'MCP 连接不存在');
    const tools = await refreshConnection(tenantId, connection, req.user.id);
    await auditSafe({
      tenantId, actorType: 'user', actorId: req.user.id, action: 'mcp.tools.refreshed',
      resourceType: 'mcp_connection', resourceId: connection.id, decision: 'allowed',
      detail: { tool_count: tools.length },
    });
    res.json({ ok: true, tools: tools.map(t => ({ name: t.name, description: t.description })) });
  } catch (e){ fail(res, e); }
});

router.get('/:id/tools', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const connection = await getConnection({ tenantId, id: req.params.id });
    if (!connection) return err(res, 404, 'MCP 连接不存在');
    res.json({ tools: await listCachedTools(connection.id) });
  } catch (e){ fail(res, e); }
});

export default router;
