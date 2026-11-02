import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSandboxProfileSupported, buildDockerArgs, resolveSandboxRuntime,
  probeDocker, probeSandboxImage, CUSTOM_TOOL_PROFILES, SANDBOX_IMAGE_USER,
} from '../../server/tools/sandbox-runtime.js';
import { ToolRunError } from '../../server/tools/result.js';

test('自定义工具 profile 矩阵：只允许 read_only/workspace_write/code_exec', () => {
  assert.deepEqual([...CUSTOM_TOOL_PROFILES], ['read_only', 'workspace_write', 'code_exec']);
  for (const p of CUSTOM_TOOL_PROFILES) assert.equal(assertSandboxProfileSupported(p), p);
  for (const p of ['network_allowlist', 'browser', 'unknown']){
    assert.throws(() => assertSandboxProfileSupported(p),
      e => e instanceof ToolRunError && e.code === 'sandbox_profile_unsupported' && !e.retryable);
  }
});

test('Docker 参数固定隔离边界', () => {
  const args = buildDockerArgs({ name: 'ekh-sbx-test', profile: 'workspace_write', timeoutMs: 5000 });
  const joined = args.join(' ');
  for (const token of ['--rm', '--init', '--network none', '--read-only', '--cap-drop ALL',
    '--security-opt no-new-privileges', '--pids-limit', '--memory', '--cpus', '--ulimit',
    '--user 10001:10001', '--label ekh.sandbox=1']){
    assert.ok(joined.includes(token), `缺少 ${token}`);
  }
  assert.ok(joined.includes('/tmp:rw,noexec,nosuid'));
  assert.ok(joined.includes('/workspace:rw,noexec,nosuid'));
  assert.equal(args[args.length - 1], 'ekh-sandbox:1');
  assert.equal(SANDBOX_IMAGE_USER, '10001:10001');

  const readOnly = buildDockerArgs({ name: 'n', profile: 'read_only' }).join(' ');
  assert.ok(!readOnly.includes('/workspace'));
  const env = args.find(a => a.startsWith('EKH_SANDBOX_HARD_TIMEOUT_MS='));
  assert.ok(Number(env.split('=')[1]) > 5000);
});

test('container 模式 fail-closed：缺 Docker/镜像时拒绝', () => {
  assert.equal(probeDocker({ bin: '/definitely/not/docker' }).available, false);
  const docker = probeDocker();
  const image = docker.available && probeSandboxImage();
  if (!docker.available || !image){
    assert.throws(() => resolveSandboxRuntime({ mode: 'container' }),
      e => e instanceof ToolRunError && e.code === 'sandbox_unavailable' && !e.retryable);
  } else {
    assert.equal(resolveSandboxRuntime({ mode: 'container' }), 'container');
  }
  assert.equal(resolveSandboxRuntime({ mode: 'process' }), 'process');
});
