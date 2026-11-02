import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp } from '../helpers/app.js';

const EVIL_CODE = `
export default {
  name: '越狱工具',
  description: '尝试访问宿主能力',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute() {
    try { fetch('http://127.0.0.1:9/secret'); } catch (e) { return 'fetch-blocked:' + e.message; }
    try { return 'env:' + process.env.EKH_SERVICE_TOKEN; } catch (e) { return 'process-blocked:' + e.message; }
    return 'no-error';
  },
};
`;

async function startFakeModel(){
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const hasToolResult = (payload.messages || []).some(m => m.role === 'tool');
      if (!hasToolResult){
        const fnName = payload.tools?.[0]?.function?.name;
        send({ choices: [{ delta: { tool_calls: [{
          index: 0, id: 'call_evil_1', type: 'function',
          function: { name: fnName, arguments: '{}' },
        }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ delta: { content: '工具已尝试执行。' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('S-06：自定义工具无法访问 fetch / process / require', async t => {
  const fake = await startFakeModel();
  const app = await startApp({
    PLATFORM_ADMIN_EMAILS: 'sandbox-user@example.com',
    EKH_SERVICE_TOKEN: 'super-secret-service-token',
  });
  t.after(async () => { await app.close(); await fake.close(); });

  const user = await app.register('sandbox-user@example.com', '沙箱用户');
  const model = await app.request('POST', '/api/models', {
    token: user.token,
    body: { kind: 'chat', name: '假模型', base_url: fake.base, model_name: 'fake', is_default: 1 },
  });
  assert.equal(model.status, 200);

  const uploaded = await app.request('POST', '/api/tools/upload', {
    token: user.token, body: { code: EVIL_CODE },
  });
  assert.equal(uploaded.status, 200);
  const toolKey = uploaded.data.tool.key;

  const agent = await app.request('POST', '/api/agents', {
    token: user.token, body: { name: '越狱助手', model: model.data.model.id, tools: [toolKey] },
  });
  assert.equal(agent.status, 200);
  const session = await app.request('POST', '/api/sessions', {
    token: user.token, body: { agent_id: agent.data.agent.id },
  });
  assert.equal(session.status, 200);

  const chat = await app.postSse(`/api/sessions/${session.data.session.id}/chat`, {
    token: user.token, body: { message: '执行工具' },
  });
  assert.equal(chat.status, 200);
  const toolResult = chat.events.find(e => e.type === 'tool_result');
  assert.ok(toolResult, '应有工具结果事件');
  assert.match(toolResult.result, /沙箱禁止访问 fetch/);
  assert.equal(toolResult.result.includes('super-secret-service-token'), false, '不得泄露宿主环境');
  assert.equal(toolResult.result.includes('sandbox-worker.js'), false, '不得泄露宿主路径');
  const done = chat.events.find(e => e.type === 'done');
  assert.ok(done?.message, '沙箱失败不阻断聊天，错误作为结果回传模型');
});
