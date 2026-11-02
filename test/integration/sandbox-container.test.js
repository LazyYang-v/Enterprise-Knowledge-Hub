// container 后端集成测试：Docker 或 ekh-sandbox:1 镜像缺失时自动跳过。
// 运行：npm run sandbox:build && EKH_TOOL_SANDBOX_MODE=container node --test test/integration/sandbox-container.test.js
process.env.EKH_TOOL_SANDBOX_MODE = 'container';

import test from 'node:test';
import assert from 'node:assert/strict';

const { probeDocker, probeSandboxImage } = await import('../../server/tools/sandbox-runtime.js');
const { runSandbox } = await import('../../server/tools/sandbox.js');
const { listSandboxProcesses } = await import('../../server/tools/sandbox-registry.js');

const docker = probeDocker();
const available = docker.available && probeSandboxImage();
const skip = available ? false : `Docker/镜像不可用：${docker.available ? '缺少 ekh-sandbox:1' : docker.error}`;

const CODE = `
export default {
  name: 'echo',
  description: '返回参数',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
  execute({ value }) { return String(value ?? ''); },
};
`;

test('container 沙箱执行自定义工具且无残留句柄', { skip, timeout: 30000 }, async () => {
  const out = await runSandbox({ mode: 'execute', code: CODE, args: { value: 'container-ok' }, timeoutMs: 5000 });
  assert.equal(out.result, 'container-ok');
  assert.deepEqual(listSandboxProcesses(), []);
});

test('container 沙箱超时会被 docker kill 回收', { skip, timeout: 30000 }, async () => {
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

test('container 沙箱 abort 后无残留容器', { skip, timeout: 30000 }, async () => {
  const hanging = `
export default {
  name: 'hang', description: 'hang',
  parameters: { type: 'object', properties: {} },
  execute(){ return new Promise(() => {}); },
};
`;
  const controller = new AbortController();
  const pending = runSandbox({
    mode: 'execute', code: hanging, args: {}, timeoutMs: 30000, signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 200).unref();
  await assert.rejects(pending, e => e.code === 'sandbox_aborted');
  assert.deepEqual(listSandboxProcesses(), []);
});
