import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers/app.js';

const TOOL_CODE = `
export default {
  name: '私有加法',
  description: '仅所有者可用',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  execute({ a, b }) { return String(a + b); },
};
`;

test('S-03/S-04：自定义工具归属、管理员可见性与模型管理权限', async t => {
  const app = await startApp({ PLATFORM_ADMIN_EMAILS: 'admin@example.com' });
  t.after(() => app.close());

  const admin = await app.register('admin@example.com', '管理员');
  const alice = await app.register('alice@example.com', 'Alice');
  const bob = await app.register('bob@example.com', 'Bob');

  // 上传与归属
  const uploaded = await app.request('POST', '/api/tools/upload', {
    token: alice.token, body: { code: TOOL_CODE },
  });
  assert.equal(uploaded.status, 200);
  const key = uploaded.data.tool.key;
  const toolId = key.slice('custom:'.length);
  assert.match(key, /^custom:/);
  assert.equal(uploaded.data.tool.version, '1.1.0');

  const aliceTools = await app.request('GET', '/api/tools', { token: alice.token });
  assert.ok(aliceTools.data.tools.some(t => t.key === key));
  const bobTools = await app.request('GET', '/api/tools', { token: bob.token });
  assert.equal(bobTools.data.tools.some(t => t.key === key), false, '他人不可见');
  const adminTools = await app.request('GET', '/api/tools', { token: admin.token });
  assert.ok(adminTools.data.tools.some(t => t.key === key), '平台管理员可见全部');

  // 内置工具配置对普通用户脱敏
  const builtin = aliceTools.data.tools.find(t => t.key === 'web-search');
  assert.ok(builtin);
  assert.equal(typeof builtin.config.configured, 'boolean');
  assert.equal('api_key' in builtin.config, false);

  // 跨用户修改/删除拒绝
  const hijack = await app.request('PUT', `/api/tools/${encodeURIComponent(key)}`, {
    token: bob.token, body: { enabled: false },
  });
  assert.equal(hijack.status, 403);
  const del = await app.request('DELETE', `/api/tools/custom/${toolId}`, { token: bob.token });
  assert.equal(del.status, 403);

  // 跨用户绑定到智能体拒绝
  const bind = await app.request('POST', '/api/agents', {
    token: bob.token, body: { name: '偷工具', tools: [key] },
  });
  assert.equal(bind.status, 403);
  const okBind = await app.request('POST', '/api/agents', {
    token: alice.token, body: { name: '自己的工具', tools: [key] },
  });
  assert.equal(okBind.status, 200);
  assert.deepEqual(okBind.data.agent.tools, [key]);

  // 停用后不可再绑定
  const disabled = await app.request('PUT', `/api/tools/${encodeURIComponent(key)}`, {
    token: alice.token, body: { enabled: false },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.tool.enabled, false);
  const bindDisabled = await app.request('POST', '/api/agents', {
    token: alice.token, body: { name: '停用工具', tools: [key] },
  });
  assert.equal(bindDisabled.status, 403);

  // 内置工具配置只有平台管理员可改
  const userBuiltin = await app.request('PUT', '/api/tools/web-search', {
    token: alice.token, body: { enabled: true },
  });
  assert.equal(userBuiltin.status, 403);
  const adminBuiltin = await app.request('PUT', '/api/tools/web-search', {
    token: admin.token, body: { enabled: true, config: { tavily_key: 'secret-key' } },
  });
  assert.equal(adminBuiltin.status, 200);
  const adminView = await app.request('GET', '/api/tools', { token: admin.token });
  assert.equal(adminView.data.tools.find(t => t.key === 'web-search').config.tavily_key, 'secret-key');

  // 模型写操作只有平台管理员
  const modelBody = {
    kind: 'chat', name: '测试模型', base_url: 'http://127.0.0.1:9/v1', model_name: 'm', api_key: 'sk-secret',
  };
  assert.equal((await app.request('POST', '/api/models', { token: alice.token, body: modelBody })).status, 403);
  const created = await app.request('POST', '/api/models', { token: admin.token, body: modelBody });
  assert.equal(created.status, 200);
  const listed = await app.request('GET', '/api/models', { token: alice.token });
  const row = listed.data.models.find(m => m.id === created.data.model.id);
  assert.equal(row.api_key, '••••••••', '密钥永不回显');
  assert.equal(JSON.stringify(listed.data).includes('sk-secret'), false);
});
