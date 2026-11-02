// process 后端：执行、vm 边界、输出上限、超时、abort 与注册表清理。
process.env.EKH_TOOL_SANDBOX_MODE = 'process';

import test from 'node:test';
import assert from 'node:assert/strict';

const { runSandbox } = await import('../../server/tools/sandbox.js');
const { listSandboxProcesses } = await import('../../server/tools/sandbox-registry.js');

const CODE = `
export default {
  name: 'echo',
  description: '返回参数',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
  execute({ value }) { return String(value ?? ''); },
};
`;

test('process 沙箱执行自定义工具并清理注册表', async () => {
  const out = await runSandbox({ mode: 'execute', code: CODE, args: { value: 'hello' }, timeoutMs: 5000 });
  assert.equal(out.result, 'hello');
  assert.deepEqual(listSandboxProcesses(), []);
});

test('process 沙箱拒绝 require/process/fetch', async () => {
  const forbidden = `
export default {
  name: 'bad', description: 'bad',
  parameters: { type: 'object', properties: {} },
  execute(){ return fetch('https://example.com'); },
};
`;
  await assert.rejects(
    () => runSandbox({ mode: 'execute', code: forbidden, args: {}, timeoutMs: 5000 }),
    e => e.code === 'sandbox_violation',
  );
});

test('输出超过单条结果上限时标记 truncated', async () => {
  const big = `
export default {
  name: 'big', description: 'big',
  parameters: { type: 'object', properties: {} },
  execute(){ return 'x'.repeat(600000); },
};
`;
  const out = await runSandbox({ mode: 'execute', code: big, args: {}, timeoutMs: 5000 });
  assert.equal(out.truncated, true);
  assert.ok(out.result.length <= 256 * 1024);
});

test('同步死循环被超时杀死', async () => {
  const loop = `
export default {
  name: 'loop', description: 'loop',
  parameters: { type: 'object', properties: {} },
  execute(){ while (true) {} },
};
`;
  await assert.rejects(
    () => runSandbox({ mode: 'execute', code: loop, args: {}, timeoutMs: 1000 }),
    e => e.code === 'tool_timeout',
  );
  assert.deepEqual(listSandboxProcesses(), []);
});

test('abort 会杀死子进程并拒绝', async () => {
  const hanging = `
export default {
  name: 'hang', description: 'hang',
  parameters: { type: 'object', properties: {} },
  execute(){ return new Promise(() => {}); },
};
`;
  const controller = new AbortController();
  const started = Date.now();
  const pending = runSandbox({
    mode: 'execute', code: hanging, args: {}, timeoutMs: 30000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100).unref();
  await assert.rejects(pending, e => e.code === 'sandbox_aborted');
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(listSandboxProcesses(), []);
});
