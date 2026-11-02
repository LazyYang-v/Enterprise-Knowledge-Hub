import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerSandboxProcess, unregisterSandboxProcess, listSandboxProcesses,
  killSandboxProcess, killAllSandboxProcesses,
} from '../../server/tools/sandbox-registry.js';

test('沙箱注册表：注册、注销、按 ID 杀与全部杀幂等', async () => {
  const killed = [];
  registerSandboxProcess('a', { kill: async () => killed.push('a') });
  registerSandboxProcess('b', { kill: async () => killed.push('b') });
  assert.deepEqual(listSandboxProcesses().sort(), ['a', 'b']);

  await killSandboxProcess('a', 'test');
  assert.deepEqual(killed, ['a']);
  assert.deepEqual(listSandboxProcesses(), ['b']);

  unregisterSandboxProcess('a', 'test');
  await killSandboxProcess('missing', 'test');

  await killAllSandboxProcesses('shutdown');
  assert.deepEqual(killed.sort(), ['a', 'b']);
  assert.deepEqual(listSandboxProcesses(), []);
  await killAllSandboxProcesses('shutdown');
});
