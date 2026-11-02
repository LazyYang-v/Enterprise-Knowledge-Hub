import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from '../helpers/app.js';

// G2：会话不得绑定或加载其他用户的智能体。
test('G2：跨用户 agent_id 被拒绝', async t => {
  const app = await startApp();
  t.after(() => app.close());

  const alice = await app.register('alice@example.com', 'Alice');
  const bob = await app.register('bob@example.com', 'Bob');

  const created = await app.request('POST', '/api/agents', {
    token: alice.token,
    body: { name: 'Alice 的智能体', system_prompt: '你是 Alice 的助手' },
  });
  assert.equal(created.status, 200);
  const agentId = created.data.agent.id;

  // 1) 创建会话时校验归属
  const denied = await app.request('POST', '/api/sessions', {
    token: bob.token,
    body: { agent_id: agentId },
  });
  assert.equal(denied.status, 403);
  assert.match(denied.data.error, /无权使用该智能体/);

  const bobSessions = await app.request('GET', '/api/sessions', { token: bob.token });
  assert.equal(bobSessions.data.sessions.length, 0);

  // 2) 本人可以正常绑定并回显
  const allowed = await app.request('POST', '/api/sessions', {
    token: alice.token,
    body: { agent_id: agentId },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.session.agent.id, agentId);
  assert.equal(allowed.data.session.agent.name, 'Alice 的智能体');

  // 3) 模拟历史脏数据：Bob 的会话指向 Alice 的智能体，聊天必须 403
  const db = new DatabaseSync(path.join(app.dir, 'app.db'));
  try {
    const ts = Date.now();
    db.prepare('INSERT INTO chat_sessions(id, user_id, title, agent_id, kb_ids, model, mode, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('legacy-bob-session', bob.user.id, '旧会话', agentId, '[]', '', 'reasoning', ts, ts);
  } finally {
    db.close();
  }

  const chat = await app.postSse('/api/sessions/legacy-bob-session/chat', {
    token: bob.token,
    body: { message: '你好' },
  });
  assert.equal(chat.status, 403);
  assert.match(chat.text, /无权使用该智能体/);

  // 4) 会话列表/详情不回显他人智能体元数据
  const detail = await app.request('GET', '/api/sessions/legacy-bob-session', { token: bob.token });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.session.agent, null);
});

test('G2：智能体被删除后按旧行为回退到会话配置', async t => {
  const app = await startApp();
  t.after(() => app.close());

  const alice = await app.register('alice2@example.com', 'Alice');
  const created = await app.request('POST', '/api/agents', { token: alice.token, body: { name: '临时智能体' } });
  const agentId = created.data.agent.id;
  const session = await app.request('POST', '/api/sessions', {
    token: alice.token,
    body: { agent_id: agentId, kb_ids: [] },
  });
  assert.equal(session.status, 200);

  await app.request('DELETE', `/api/agents/${agentId}`, { token: alice.token });

  const chat = await app.postSse(`/api/sessions/${session.data.session.id}/chat`, {
    token: alice.token,
    body: { message: '你好' },
  });
  assert.equal(chat.status, 200);
  const done = chat.events.find(e => e.type === 'done');
  assert.ok(done, '应返回 done 事件（无模型时走回退回答）');
});
