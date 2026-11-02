import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers/app.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.close(); });

test('未配置模型时聊天回退为检索片段，SSE 事件序列保持 meta → delta → done', async () => {
  const user = await app.register('chat@example.com', 'Chat');
  const created = await app.request('POST', '/api/sessions', {
    token: user.token,
    body: { title: '回归测试会话' },
  });
  assert.equal(created.status, 200);
  const sessionId = created.data.session.id;

  const sse = await app.postSse(`/api/sessions/${sessionId}/chat`, {
    token: user.token,
    body: { message: '你好' },
  });
  assert.equal(sse.status, 200);

  const types = sse.events.map(e => e.type);
  assert.ok(types.includes('meta'), '应发出 meta 事件');
  assert.ok(types.includes('delta'), '应发出 delta 事件');
  assert.ok(types.includes('done'), '应发出 done 事件');

  const done = sse.events.find(e => e.type === 'done');
  assert.match(done.message.content, /尚未配置对话模型/);

  const detail = await app.request('GET', `/api/sessions/${sessionId}`, { token: user.token });
  assert.equal(detail.status, 200);
  const assistant = detail.data.messages.find(m => m.role === 'assistant');
  assert.ok(assistant);
  assert.match(assistant.content, /尚未配置对话模型/);
});

test('空消息被拒绝', async () => {
  const user = await app.register('chat-empty@example.com', 'Chat');
  const created = await app.request('POST', '/api/sessions', { token: user.token, body: {} });
  const sessionId = created.data.session.id;

  const sse = await app.postSse(`/api/sessions/${sessionId}/chat`, {
    token: user.token,
    body: { message: '   ' },
  });
  assert.equal(sse.status, 400);
});
