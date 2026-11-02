import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configureFaults, resetFaultStateForTest, selectFault, injectFault,
  faultInjectionEnabled, FaultInjectedError, FAULT_POINTS, FAULT_ACTIONS,
} from '../../server/testing/fault-injection.js';

test.afterEach(() => resetFaultStateForTest());

test('默认关闭：不选择、不注入', async () => {
  resetFaultStateForTest();
  assert.equal(faultInjectionEnabled(), false);
  assert.equal(selectFault('model.before_call', {}), null);
  assert.equal(await injectFault('model.before_call', {}), null);
});

test('after/times/match 确定性生效', async () => {
  configureFaults({
    enabled: true,
    configJson: JSON.stringify([
      { point: 'model.before_call', action: 'throw', after: 1, times: 1, match: { tool_name: 'x' } },
    ]),
  });
  assert.equal(selectFault('model.before_call', { tool_name: 'x' }), null, '第一次跳过');
  const hit = selectFault('model.before_call', { tool_name: 'x' });
  assert.equal(hit.action, 'throw');
  assert.equal(hit.occurrence, 2);
  assert.equal(selectFault('model.before_call', { tool_name: 'x' }), null, 'times 用尽');
  assert.equal(selectFault('model.before_call', { tool_name: 'y' }), null, 'match 不命中');
});

test('probability 由 seed 与发生序号确定', () => {
  const json = JSON.stringify([
    { point: 'tool.before_execute', action: 'delay', probability: 0.5 },
  ]);
  const run = seed => {
    resetFaultStateForTest();
    configureFaults({ enabled: true, configJson: json, seed });
    return [1, 2, 3, 4, 5].map(i => !!selectFault('tool.before_execute', { task_id: 't', tool_name: `n${i}` }));
  };
  assert.deepEqual(run(42), run(42), '同一 seed 必须确定');

  resetFaultStateForTest();
  configureFaults({ enabled: true, configJson: JSON.stringify([
    { point: 'tool.before_execute', action: 'delay', probability: 0 },
  ]) });
  assert.equal(selectFault('tool.before_execute', {}), null);
  resetFaultStateForTest();
  configureFaults({ enabled: true, configJson: JSON.stringify([
    { point: 'tool.before_execute', action: 'delay', probability: 1 },
  ]) });
  assert.equal(selectFault('tool.before_execute', {}).action, 'delay');
});

test('throw/delay/empty 动作', async () => {
  configureFaults({
    enabled: true,
    configJson: JSON.stringify([
      { point: 'model.after_call', action: 'empty', times: 1 },
      { point: 'tool.before_execute', action: 'throw', code: 'injected_boom', message: 'boom', times: 1 },
    ]),
  });
  const empty = await injectFault('model.after_call', {});
  assert.equal(empty.result.kind, 'empty');
  assert.equal(empty.result.content, '');
  await assert.rejects(
    () => injectFault('tool.before_execute', {}),
    e => e instanceof FaultInjectedError && e.code === 'injected_boom' && e.retryable,
  );
  resetFaultStateForTest();

  configureFaults({
    enabled: true,
    configJson: JSON.stringify([{ point: 'model.before_call', action: 'delay', delay_ms: 20, times: 1 }]),
  });
  const started = Date.now();
  await injectFault('model.before_call', {});
  assert.ok(Date.now() - started >= 15);
});

test('非法配置在启动时拒绝', () => {
  assert.throws(
    () => configureFaults({ enabled: true, configJson: '{"point":"x"}' }),
    /必须是数组/,
  );
  assert.throws(
    () => configureFaults({ enabled: true, configJson: '[{"point":"nope","action":"delay"}]' }),
    /未知故障点/,
  );
  assert.throws(
    () => configureFaults({ enabled: true, configJson: '[{"point":"model.before_call","action":"nope"}]' }),
    /未知故障动作/,
  );
  assert.throws(
    () => configureFaults({ enabled: true, configJson: '[{"point":"model.before_call","action":"delay","probability":2}]' }),
    /probability/,
  );
});

test('故障点与动作清单稳定', () => {
  assert.ok(FAULT_POINTS.includes('mcp.after_send_before_read'));
  assert.ok(FAULT_POINTS.includes('budget.before_check'));
  for (const action of ['delay', 'hang', 'throw', 'kill_self', 'empty', 'malformed', 'http_status', 'drop_response']){
    assert.ok(FAULT_ACTIONS.includes(action));
  }
});
