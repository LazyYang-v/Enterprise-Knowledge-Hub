import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-secrets-'));
process.env.EKH_MODEL_SECRET_DIR = secretDir;
process.env.EKH_TEST_MODEL_KEY = 'sk-test-value';
fs.writeFileSync(path.join(secretDir, 'model.key'), 'file-secret\n', { mode: 0o600 });
fs.mkdirSync(path.join(secretDir, 'sub'));
fs.writeFileSync(path.join(secretDir, 'sub', 'nested.key'), 'nested-secret\n');

const { resolveCredentialRef, credentialConfigured, CredentialError } =
  await import('../../server/control/credentials.js');

test('env: 引用只解析已配置的环境变量', () => {
  assert.equal(resolveCredentialRef('env:EKH_TEST_MODEL_KEY'), 'sk-test-value');
  assert.equal(resolveCredentialRef(''), '');
  assert.equal(resolveCredentialRef(null), '');
  assert.throws(() => resolveCredentialRef('env:EKH_MISSING_KEY'), e => e.code === 'credential_unavailable');
  assert.throws(() => resolveCredentialRef('env:BAD-NAME'), e => e.code === 'credential_invalid');
});

test('file: 引用限定在 EKH_MODEL_SECRET_DIR 内', () => {
  assert.equal(resolveCredentialRef('file:model.key'), 'file-secret');
  assert.equal(resolveCredentialRef('file:sub/nested.key'), 'nested-secret');
  for (const ref of [
    'file:../outside', 'file:/etc/passwd', 'file:sub/../../outside', 'file:', 'file:a\0b',
  ]) assert.throws(() => resolveCredentialRef(ref), CredentialError);
  assert.throws(() => resolveCredentialRef('file:missing.key'), e => e.code === 'credential_unavailable');
});

test('其他格式一律拒绝；credentialConfigured 不抛出', () => {
  for (const ref of ['plaintext', 'vault:foo', ' env:EKH_TEST_MODEL_KEY']) {
    if (ref.startsWith(' ')) continue;
    assert.throws(() => resolveCredentialRef(ref), CredentialError);
  }
  assert.equal(credentialConfigured('env:EKH_TEST_MODEL_KEY'), true);
  assert.equal(credentialConfigured('env:EKH_MISSING_KEY'), false);
  assert.equal(credentialConfigured('nope'), false);
});
