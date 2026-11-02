import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers/app.js';

// 特性开关默认关闭：任务 API 不应存在，也不应触发 PostgreSQL 连接。
test('AGENT_PLATFORM_ENABLED 关闭时任务 API 返回 404', async t => {
  const app = await startApp();
  t.after(() => app.close());

  const user = await app.register('disabled@example.com', '关闭开关用户');
  const list = await app.request('GET', '/api/tasks', { token: user.token });
  assert.equal(list.status, 404);

  const create = await app.request('POST', '/api/tasks', { token: user.token, body: { goal: '不应创建' } });
  assert.equal(create.status, 404);

  const approvals = await app.request('GET', '/api/approvals', { token: user.token });
  assert.equal(approvals.status, 404);

  // 旧聊天路径不受开关影响。
  const session = await app.request('POST', '/api/sessions', { token: user.token, body: {} });
  assert.equal(session.status, 200);
});
