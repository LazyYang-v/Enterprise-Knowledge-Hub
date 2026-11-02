import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers/app.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.close(); });

test('智能体 CRUD 回归', async () => {
  const user = await app.register('agent@example.com', 'Agent');
  const created = await app.request('POST', '/api/agents', {
    token: user.token,
    body: { name: '制度审查助手', description: '检查采购制度', system_prompt: '你是审查助手', kb_ids: [], tools: [] },
  });
  assert.equal(created.status, 200);
  const id = created.data.agent.id;

  const list = await app.request('GET', '/api/agents', { token: user.token });
  assert.ok(list.data.agents.some(a => a.id === id));

  const updated = await app.request('PUT', `/api/agents/${id}`, {
    token: user.token,
    body: { name: '制度审查助手 v2' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.agent.name, '制度审查助手 v2');

  const removed = await app.request('DELETE', `/api/agents/${id}`, { token: user.token });
  assert.equal(removed.status, 200);
});

test('会话 CRUD 与搜索回归', async () => {
  const user = await app.register('session@example.com', 'Session');
  const created = await app.request('POST', '/api/sessions', {
    token: user.token,
    body: { title: '采购制度审查' },
  });
  assert.equal(created.status, 200);
  const id = created.data.session.id;

  const updated = await app.request('PUT', `/api/sessions/${id}`, {
    token: user.token,
    body: { title: '采购制度审查 2' },
  });
  assert.equal(updated.data.session.title, '采购制度审查 2');

  const search = await app.request('GET', '/api/search?q=采购', { token: user.token });
  assert.equal(search.status, 200);
  assert.ok(search.data.sessions.some(s => s.id === id));

  const removed = await app.request('DELETE', `/api/sessions/${id}`, { token: user.token });
  assert.equal(removed.status, 200);
  const detail = await app.request('GET', `/api/sessions/${id}`, { token: user.token });
  assert.equal(detail.status, 404);
});

test('我的记忆 CRUD 回归', async () => {
  const user = await app.register('memory@example.com', 'Memory');
  const created = await app.request('POST', '/api/memories', {
    token: user.token,
    body: { content: '我负责采购审批' },
  });
  assert.equal(created.status, 200);
  const id = created.data.memory.id;

  const list = await app.request('GET', '/api/memories', { token: user.token });
  assert.ok(list.data.memories.some(m => m.id === id));

  await app.request('DELETE', `/api/memories/${id}`, { token: user.token });
  const after = await app.request('GET', '/api/memories', { token: user.token });
  assert.ok(!after.data.memories.some(m => m.id === id));
});

test('工具箱：内置元数据与自定义工具上传/启停/删除', async () => {
  const user = await app.register('tools@example.com', 'Tools');

  const tools = await app.request('GET', '/api/tools', { token: user.token });
  assert.equal(tools.status, 200);
  assert.ok(tools.data.tools.some(t => t.key === 'web-search'));

  const code = `export default {
    name: 'echo_tool',
    description: '回声工具',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute(args){ return 'echo:' + (args.text || ''); }
  };`;
  const uploaded = await app.request('POST', '/api/tools/upload', {
    token: user.token,
    body: { code },
  });
  assert.equal(uploaded.status, 200);
  const key = uploaded.data.tool.key;
  assert.match(key, /^custom:/);

  const toggled = await app.request('PUT', `/api/tools/${key}`, {
    token: user.token,
    body: { enabled: false },
  });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.data.tool.enabled, false);

  const removed = await app.request('DELETE', `/api/tools/custom/${key.slice(7)}`, { token: user.token });
  assert.equal(removed.status, 200);
});

test('产物与模型列表空态回归', async () => {
  const user = await app.register('empty@example.com', 'Empty');
  const artifacts = await app.request('GET', '/api/artifacts', { token: user.token });
  assert.equal(artifacts.status, 200);
  assert.deepEqual(artifacts.data.artifacts, []);

  const models = await app.request('GET', '/api/models', { token: user.token });
  assert.equal(models.status, 200);
  assert.deepEqual(models.data.models, []);
});

test('健康检查保持原有响应形状', async () => {
  const health = await app.request('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.name, 'Enterprise Knowledge Hub');
});
