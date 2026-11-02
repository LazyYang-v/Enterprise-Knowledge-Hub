import test from 'node:test';
import assert from 'node:assert/strict';
import { providerIdempotencyKey } from '../../server/tools/idempotency.js';

const BASE = {
  tenantId: 't-1', taskId: 'task-1', toolName: 'mcp.crm.create_record', argsHash: 'a'.repeat(64),
};

test('provider 幂等键稳定、不含明文参数且跨 step 不变', () => {
  const a = providerIdempotencyKey(BASE);
  const b = providerIdempotencyKey({ ...BASE });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.ok(!a.includes('crm'));
  assert.ok(!a.includes('task-1'));
});

test('provider 幂等键对租户、任务、工具、参数敏感', () => {
  const base = providerIdempotencyKey(BASE);
  assert.notEqual(base, providerIdempotencyKey({ ...BASE, tenantId: 't-2' }));
  assert.notEqual(base, providerIdempotencyKey({ ...BASE, taskId: 'task-2' }));
  assert.notEqual(base, providerIdempotencyKey({ ...BASE, toolName: 'mcp.crm.update_record' }));
  assert.notEqual(base, providerIdempotencyKey({ ...BASE, argsHash: 'b'.repeat(64) }));
});

test('provider 幂等键拒绝缺失字段', () => {
  for (const key of ['tenantId', 'taskId', 'toolName', 'argsHash']){
    assert.throws(() => providerIdempotencyKey({ ...BASE, [key]: '' }), /缺少/);
  }
});
