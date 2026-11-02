import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentAction, ActionValidationError, MAX_PLAN_ITEMS } from '../../server/agent/actions.js';

function codeOf(fn){
  try { fn(); } catch (e){
    assert.ok(e instanceof ActionValidationError, '应抛出 ActionValidationError');
    return e.code;
  }
  assert.fail('预期抛出 ActionValidationError');
}

test('plan：解析并补全默认状态', () => {
  const action = parseAgentAction({
    type: 'plan',
    plan_items: [
      { item_key: 'a', title: '检索制度', completion_criteria: '找到现行版本' },
      { item_key: 'b', title: '对比差异', completion_criteria: '列出差异', depends_on: ['a'] },
    ],
  });
  assert.equal(action.type, 'plan');
  assert.equal(action.plan_items.length, 2);
  assert.equal(action.plan_items[0].status, 'pending');
  assert.deepEqual(action.plan_items[1].depends_on, ['a']);
});

test('plan：拒绝重复 key、悬空依赖、自依赖与循环依赖', () => {
  const item = (key, deps = []) => ({ item_key: key, title: key, completion_criteria: 'done', depends_on: deps });
  assert.equal(codeOf(() => parseAgentAction({ type: 'plan', plan_items: [item('a'), item('a')] })), 'action_invalid_plan');
  assert.equal(codeOf(() => parseAgentAction({ type: 'plan', plan_items: [item('a', ['missing'])] })), 'action_invalid_plan');
  assert.equal(codeOf(() => parseAgentAction({ type: 'plan', plan_items: [item('a', ['a'])] })), 'action_invalid_plan');
  assert.equal(codeOf(() => parseAgentAction({ type: 'plan', plan_items: [item('a', ['b']), item('b', ['a'])] })), 'action_invalid_plan');
});

test('plan：限制条目数与未知字段', () => {
  const items = Array.from({ length: MAX_PLAN_ITEMS + 1 }, (_, i) => ({
    item_key: 'i' + i, title: 't' + i, completion_criteria: 'c',
  }));
  assert.equal(codeOf(() => parseAgentAction({ type: 'plan', plan_items: items })), 'action_invalid_plan');
  assert.equal(codeOf(() => parseAgentAction({
    type: 'plan', plan_items: [{ item_key: 'a', title: 't', completion_criteria: 'c', extra: 1 }],
  })), 'action_unknown_field');
  assert.equal(codeOf(() => parseAgentAction({ type: 'plan', plan_items: [], extra: true })), 'action_unknown_field');
});

test('call_tool：允许集合与参数约束', () => {
  const action = parseAgentAction(
    { type: 'call_tool', tool_name: 'kb.search', arguments: { query: '制度' } },
    { allowedTools: ['kb.search'] },
  );
  assert.deepEqual(action, { type: 'call_tool', tool_name: 'kb.search', arguments: { query: '制度' } });

  assert.equal(codeOf(() => parseAgentAction(
    { type: 'call_tool', tool_name: 'shell.exec', arguments: {} },
    { allowedTools: ['kb.search'] },
  )), 'action_tool_not_allowed');
  assert.equal(codeOf(() => parseAgentAction({ type: 'call_tool', tool_name: 'kb.search', arguments: [] })), 'action_invalid_field');
  assert.equal(codeOf(() => parseAgentAction({ type: 'call_tool', tool_name: 'Bad Name', arguments: {} })), 'action_invalid_field');
  assert.equal(codeOf(() => parseAgentAction({ type: 'call_tool', tool_name: 'kb.search', arguments: {}, x: 1 })), 'action_unknown_field');
});

test('ask_user：问题与输入 schema 校验', () => {
  const action = parseAgentAction({
    type: 'ask_user',
    question: '请提供审批人',
    input_schema: { type: 'object', properties: { approver: { type: 'string', required: true } } },
  });
  assert.equal(action.type, 'ask_user');
  assert.equal(action.input_schema.properties.approver.type, 'string');

  assert.equal(codeOf(() => parseAgentAction({ type: 'ask_user', question: '', input_schema: { type: 'object', properties: {} } })), 'action_invalid_field');
  assert.equal(codeOf(() => parseAgentAction({
    type: 'ask_user',
    question: 'q',
    input_schema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['f' + i, { type: 'string' }])) },
  })), 'action_invalid_field');
  assert.equal(codeOf(() => parseAgentAction({
    type: 'ask_user', question: 'q', input_schema: { type: 'object', properties: { a: { type: 'file' } } },
  })), 'action_invalid_field');
});

test('finish 与 fail：字段约束', () => {
  const finish = parseAgentAction({ type: 'finish', summary: '完成' });
  assert.deepEqual(finish, { type: 'finish', summary: '完成', artifact_refs: [], citations: [] });

  const fail = parseAgentAction({ type: 'fail', error_code: 'kb_empty', message: '没有可用证据' });
  assert.deepEqual(fail, { type: 'fail', error_code: 'kb_empty', message: '没有可用证据' });
  assert.equal(codeOf(() => parseAgentAction({ type: 'fail', error_code: 'KB EMPTY', message: 'x' })), 'action_invalid_field');
  assert.equal(codeOf(() => parseAgentAction({ type: 'finish' })), 'action_invalid_field');
});

test('文本输入：允许单个 json 代码块，拒绝其他包装与非法 JSON', () => {
  const parsed = parseAgentAction('```json\n{"type":"finish","summary":"ok"}\n```');
  assert.equal(parsed.summary, 'ok');
  assert.equal(codeOf(() => parseAgentAction('好的，这是结果：{"type":"finish","summary":"ok"}')), 'action_invalid_json');
  assert.equal(codeOf(() => parseAgentAction('```json\n{"type":"finish",}\n```')), 'action_invalid_json');
  assert.equal(codeOf(() => parseAgentAction('')), 'action_empty');
  assert.equal(codeOf(() => parseAgentAction('[]')), 'action_invalid');
  assert.equal(codeOf(() => parseAgentAction({ type: 'unknown' })), 'action_unknown_type');
});

test('大小与嵌套深度限制', () => {
  assert.equal(codeOf(() => parseAgentAction('{'.repeat(300 * 1024))), 'action_too_large');
  let nested = {};
  let cursor = nested;
  for (let i = 0; i < 10; i++){ cursor.next = {}; cursor = cursor.next; }
  assert.equal(codeOf(() => parseAgentAction({ type: 'call_tool', tool_name: 'kb.search', arguments: nested })), 'action_too_deep');
});
