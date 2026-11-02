import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp } from '../helpers/app.js';

const TOOL_CODE = `
export default {
  name: '加法',
  description: '计算两个数之和',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  execute({ a, b }) { return String(a + b); },
};
`;

// 假 OpenAI 兼容服务：第一轮返回 function call，第二轮（收到 tool 结果后）返回文本。
async function startFakeModel(){
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      requests.push(payload);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      const hasToolResult = (payload.messages || []).some(m => m.role === 'tool');
      if (!hasToolResult){
        const fnName = payload.tools?.[0]?.function?.name;
        send({ choices: [{ delta: { tool_calls: [{
          index: 0,
          id: 'call_fake_1',
          type: 'function',
          function: { name: fnName, arguments: '{"a":2,"b":3}' },
        }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ delta: { content: '计算结果是 5。' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  return { base, requests, close: () => new Promise(resolve => server.close(resolve)) };
}

test('F-01 回归：旧聊天路径经 AgentRunner 完成自定义工具调用', async t => {
  const fake = await startFakeModel();
  const app = await startApp({
    PLATFORM_ADMIN_EMAILS: 'tool-user@example.com,err-user@example.com',
  });
  t.after(async () => { await app.close(); await fake.close(); });

  const user = await app.register('tool-user@example.com', '工具用户');

  const model = await app.request('POST', '/api/models', {
    token: user.token,
    body: {
      kind: 'chat',
      name: '假模型',
      base_url: fake.base,
      model_name: 'fake-model',
      is_default: 1,
    },
  });
  assert.equal(model.status, 200);

  const uploaded = await app.request('POST', '/api/tools/upload', {
    token: user.token,
    body: { code: TOOL_CODE },
  });
  assert.equal(uploaded.status, 200);
  const toolKey = uploaded.data.tool.key;
  assert.match(toolKey, /^custom:/);

  const agent = await app.request('POST', '/api/agents', {
    token: user.token,
    body: { name: '计算助手', model: model.data.model.id, tools: [toolKey] },
  });
  assert.equal(agent.status, 200);

  const session = await app.request('POST', '/api/sessions', {
    token: user.token,
    body: { agent_id: agent.data.agent.id },
  });
  assert.equal(session.status, 200);

  const chat = await app.postSse(`/api/sessions/${session.data.session.id}/chat`, {
    token: user.token,
    body: { message: '请计算 2+3' },
  });
  assert.equal(chat.status, 200);

  const types = chat.events.map(e => e.type);
  assert.ok(types.includes('retrieved'));
  assert.ok(types.includes('meta'));
  assert.equal(types.filter(t => t === 'tool').length, 1);
  assert.equal(types.filter(t => t === 'tool_result').length, 1);

  const toolEvent = chat.events.find(e => e.type === 'tool');
  assert.equal(toolEvent.name, '加法');
  const toolResult = chat.events.find(e => e.type === 'tool_result');
  assert.equal(toolResult.name, '加法');
  assert.equal(toolResult.result, '5');

  const done = chat.events.find(e => e.type === 'done');
  assert.ok(done?.message, '应保存助手消息');
  assert.equal(done.message.content, '计算结果是 5。');
  assert.match(done.message.think, /已调用工具「加法」并获取结果/);

  // 两次模型请求：第二次必须携带 tool 消息，证明循环正确续接。
  assert.equal(fake.requests.length, 2);
  const second = fake.requests[1].messages;
  const assistant = second.find(m => m.role === 'assistant');
  assert.equal(assistant.tool_calls[0].function.name.startsWith('tool_'), true);
  const toolMsg = second.find(m => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_fake_1');
  assert.equal(toolMsg.content, '5');

  // 第二次生成带上了旧聊天路径构造的系统提示词（ContextBuilder 兼容）。
  const system = second[0];
  assert.equal(system.role, 'system');
  assert.ok(system.content.includes('你是企业知识库智能助手'));
});

test('模型报错保留原有错误文案（ModelAdapter 不改变消息）', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    res.end('too many requests');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;

  const app = await startApp();
  t.after(async () => { await app.close(); await new Promise(r => server.close(r)); });

  const user = await app.register('err-user@example.com', '错误用户');
  await app.request('POST', '/api/models', {
    token: user.token,
    body: { kind: 'chat', name: '坏模型', base_url: base, model_name: 'x', is_default: 1 },
  });
  const session = await app.request('POST', '/api/sessions', { token: user.token, body: {} });

  const chat = await app.postSse(`/api/sessions/${session.data.session.id}/chat`, {
    token: user.token,
    body: { message: '你好' },
  });
  const error = chat.events.find(e => e.type === 'error');
  assert.ok(error, '应收到 error 事件');
  assert.match(error.message, /^模型调用失败：模型请求失败 \(429\)/);
});
