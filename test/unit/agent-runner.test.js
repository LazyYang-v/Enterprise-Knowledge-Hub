import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../../server/agent/runner.js';

const MODEL = { base_url: 'http://127.0.0.1:1', model_name: 'fake', api_key: '' };

/** 按脚本依次返回每一轮的流事件；同时记录收到的 messages 快照。 */
function scriptedStream(rounds){
  const calls = [];
  async function* stream(model, messages, options){
    calls.push({ messages: messages.map(m => ({ ...m })), options });
    const round = rounds.shift() || [{ text: '' }];
    for (const part of round) yield part;
  }
  stream.calls = calls;
  return stream;
}

test('无工具调用：直接返回文本并透传增量', async () => {
  const stream = scriptedStream([[{ text: '你好' }, { text: '，世界' }]]);
  const deltas = [];
  const result = await runAgentLoop({
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    streamModel: stream,
    onDelta: t => deltas.push(t),
  });
  assert.equal(result.text, '你好，世界');
  assert.equal(result.iterations, 0);
  assert.deepEqual(deltas, ['你好', '，世界']);
  assert.equal(stream.calls.length, 1);
  assert.equal(stream.calls[0].options.tools, undefined);
});

test('工具轮：执行工具、追加 assistant/tool 消息并继续生成', async () => {
  const stream = scriptedStream([
    [{ text: '我先算一下。' }, { toolCalls: [{ id: 'call_1', name: 'add', arguments: '{"a":2,"b":3}' }] }],
    [{ text: '结果是 5。' }],
  ]);
  const events = [];
  const result = await runAgentLoop({
    model: MODEL,
    messages: [{ role: 'user', content: '2+3' }],
    tools: [{ type: 'function', function: { name: 'add' } }],
    streamModel: stream,
    executeTool: async call => {
      assert.equal(call.name, 'add');
      return '5';
    },
    onToolCall: c => events.push(['call', c.name]),
    onToolResult: (c, r) => events.push(['result', r]),
    onIteration: n => events.push(['iter', n]),
  });

  assert.equal(result.text, '我先算一下。结果是 5。');
  assert.equal(result.iterations, 1);
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(events, [['call', 'add'], ['result', '5'], ['iter', 1]]);

  const secondRound = stream.calls[1].messages;
  const assistant = secondRound.find(m => m.role === 'assistant');
  assert.deepEqual(assistant.tool_calls, [{
    id: 'call_1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' },
  }]);
  assert.equal(assistant.content, '我先算一下。');
  const toolMsg = secondRound.find(m => m.role === 'tool');
  assert.deepEqual(toolMsg, { role: 'tool', tool_call_id: 'call_1', content: '5' });
  assert.deepEqual(stream.calls[1].options.tools, [{ type: 'function', function: { name: 'add' } }]);
});

test('未知工具（executeTool 返回 null）不产生 tool 消息，且循环继续', async () => {
  const stream = scriptedStream([
    [{ toolCalls: [{ name: 'unknown', arguments: '{}' }] }],
    [{ text: '继续回答' }],
  ]);
  const result = await runAgentLoop({
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    streamModel: stream,
    executeTool: () => null,
  });
  assert.equal(result.text, '继续回答');
  assert.equal(result.iterations, 1);
  assert.ok(result.toolCalls[0].id.startsWith('call_'));
  const secondRound = stream.calls[1].messages;
  assert.equal(secondRound.filter(m => m.role === 'tool').length, 0);
  assert.ok(secondRound.some(m => m.role === 'assistant' && m.tool_calls?.length === 1));
});

test('maxIterations 限制工具轮次', async () => {
  const rounds = Array.from({ length: 10 }, () => [{ toolCalls: [{ name: 'loop', arguments: '{}' }] }]);
  const stream = scriptedStream(rounds);
  let executed = 0;
  const result = await runAgentLoop({
    model: MODEL,
    messages: [{ role: 'user', content: 'loop' }],
    maxIterations: 3,
    streamModel: stream,
    executeTool: () => { executed++; return 'ok'; },
  });
  assert.equal(executed, 2);
  assert.equal(result.iterations, 3);
});

test('中止信号：停止后续轮次', async () => {
  const controller = new AbortController();
  controller.abort();
  const stream = scriptedStream([[{ toolCalls: [{ name: 'add', arguments: '{}' }] }], [{ text: '不应出现' }]]);
  let executed = 0;
  const result = await runAgentLoop({
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    signal: controller.signal,
    streamModel: stream,
    executeTool: () => { executed++; return 'ok'; },
  });
  assert.equal(executed, 0);
  assert.equal(result.text, '');
  assert.equal(stream.calls.length, 1);
});

test('缺少模型时拒绝运行', async () => {
  await assert.rejects(() => runAgentLoop({ messages: [] }), /需要已解析的模型/);
});
