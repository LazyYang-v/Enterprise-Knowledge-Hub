// 工具注册表管理 API：include_disabled、启停、内置保护与策略删除。
process.env.AGENT_PLATFORM_ENABLED = '1';
process.env.PLATFORM_ADMIN_EMAILS = 'registry-admin@example.com';

import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { ensureSchema, canUseTestDatabase, closeTestDb } = await import('../helpers/pg.js');
const { startApp } = await import('../helpers/app.js');
const { resolveTenantId } = await import('../../server/control/tenants.js');
const { createCustomTool } = await import('../../server/tools/custom-tools-repo.js');
const { customToolName } = await import('../../server/tools/contract.js');
const { upsertToolRegistry, upsertToolPolicy, listToolPolicies } = await import('../../server/control/tool-registry-repo.js');

const skip = !canUseTestDatabase();

const TOOL_CODE = `
export default {
  name: '注册表工具',
  description: '测试工具',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute() { return 'ok'; },
};
`;

test('管理员可启停 MCP/自定义工具、删除策略；内置工具只读', { skip }, async t => {
  await ensureSchema();
  const app = await startApp({
    AGENT_PLATFORM_ENABLED: '1',
    PLATFORM_ADMIN_EMAILS: 'registry-admin@example.com',
  });
  t.after(async () => { await app.close(); await closeTestDb(); });

  const admin = await app.register('registry-admin@example.com', '管理员');
  const normal = await app.register('registry-normal@example.com', '普通用户');
  const tenantId = await resolveTenantId(admin.user.id);

  const custom = createCustomTool({
    ownerId: admin.user.id, name: '注册表工具', description: '测试工具',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    code: TOOL_CODE,
  });
  const customName = customToolName(custom.id);

  await upsertToolRegistry({
    tenantId, name: 'mcp.crm.update', version: '1.0.0', source: 'mcp',
    description: 'CRM 更新', inputSchema: {}, sideEffect: 'external_send',
    approvalPolicy: 'always', timeoutMs: 15000, idempotency: 'provider_key',
    resourceScope: 'task', sandboxProfile: 'network_allowlist', schemaHash: 'b'.repeat(64),
    ownerId: admin.user.id, enabled: true,
  });

  const listed = await app.request('GET', '/api/tools/registry?include_disabled=1', { token: admin.token });
  assert.equal(listed.status, 200);
  assert.ok(listed.data.tools.some(x => x.name === 'mcp.crm.update' && x.enabled === true));
  assert.ok(listed.data.tools.some(x => x.name === customName && x.enabled === true));

  const disableMcp = await app.request('PATCH', '/api/tools/registry/mcp.crm.update/enabled', {
    token: admin.token, body: { enabled: false },
  });
  assert.equal(disableMcp.status, 200);
  const afterMcp = await app.request('GET', '/api/tools/registry?include_disabled=1', { token: admin.token });
  assert.equal(afterMcp.data.tools.find(x => x.name === 'mcp.crm.update').enabled, false);
  // 非管理员忽略 include_disabled，不应该看到已停用工具。
  const normalList = await app.request('GET', '/api/tools/registry?include_disabled=1', { token: normal.token });
  assert.ok(!normalList.data.tools.some(x => x.name === 'mcp.crm.update'));

  const disableCustom = await app.request(
    'PATCH', `/api/tools/registry/${encodeURIComponent(customName)}/enabled`,
    { token: admin.token, body: { enabled: false } },
  );
  assert.equal(disableCustom.status, 200);
  const afterCustom = await app.request('GET', '/api/tools/registry?include_disabled=1', { token: admin.token });
  assert.equal(afterCustom.data.tools.find(x => x.name === customName).enabled, false);

  const builtin = await app.request('PATCH', '/api/tools/registry/knowledge.search/enabled', {
    token: admin.token, body: { enabled: false },
  });
  assert.equal(builtin.status, 409);

  const forbidden = await app.request('PATCH', '/api/tools/registry/mcp.crm.update/enabled', {
    token: normal.token, body: { enabled: true },
  });
  assert.equal(forbidden.status, 403);

  const badBody = await app.request('PATCH', '/api/tools/registry/mcp.crm.update/enabled', {
    token: admin.token, body: { enabled: 'no' },
  });
  assert.equal(badBody.status, 400);

  await upsertToolPolicy({
    tenantId, toolName: 'mcp.crm.update', principalType: 'user',
    principalId: admin.user.id, approvalMode: 'always', maxCallsPerTask: 3,
  });
  assert.equal((await listToolPolicies({ tenantId, toolName: 'mcp.crm.update' })).length, 1);

  const noPrincipal = await app.request(
    'DELETE', '/api/tools/registry/mcp.crm.update/policy?principal_type=user',
    { token: admin.token },
  );
  assert.equal(noPrincipal.status, 400);

  const deleted = await app.request(
    'DELETE',
    `/api/tools/registry/mcp.crm.update/policy?principal_type=user&principal_id=${encodeURIComponent(admin.user.id)}`,
    { token: admin.token },
  );
  assert.equal(deleted.status, 200);
  assert.equal((await listToolPolicies({ tenantId, toolName: 'mcp.crm.update' })).length, 0);

  const missing = await app.request(
    'DELETE',
    `/api/tools/registry/mcp.crm.update/policy?principal_type=user&principal_id=${encodeURIComponent(admin.user.id)}`,
    { token: admin.token },
  );
  assert.equal(missing.status, 404);

  const forbiddenDelete = await app.request(
    'DELETE',
    `/api/tools/registry/mcp.crm.update/policy?principal_type=user&principal_id=${encodeURIComponent(admin.user.id)}`,
    { token: normal.token },
  );
  assert.equal(forbiddenDelete.status, 403);
});
