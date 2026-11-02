import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJson, hashJson, hashArgs, schemaHashFor, customToolName, customToolVersion,
  normalizeToolDescriptor, descriptorHash, ToolContractError,
} from '../../server/tools/contract.js';

test('canonicalJson：键顺序不影响哈希，拒绝循环与非有限数字', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.equal(hashArgs({ x: [1, { b: true, a: null }] }), hashArgs({ x: [1, { a: null, b: true }] }));
  assert.match(hashArgs({}), /^[0-9a-f]{64}$/);
  assert.throws(() => canonicalJson({ n: Infinity }), ToolContractError);
  assert.throws(() => canonicalJson({ n: NaN }), ToolContractError);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /循环/);
  assert.throws(() => canonicalJson({ fn: () => 1 }), ToolContractError);
  const withDate = { d: new Date() };
  assert.throws(() => canonicalJson(withDate), /纯 JSON/);
});

test('工具命名与版本：custom.<id> / 1.<n>.0 / schema_hash 稳定', () => {
  assert.equal(customToolName('abc-123'), 'custom.abc-123');
  assert.equal(customToolVersion({ current_version: 3 }), '1.3.0');
  assert.equal(customToolVersion({ version: 2 }), '1.2.0');
  assert.equal(
    schemaHashFor({ name: 'knowledge.search', version: '1.0.0', description: 'd', input_schema: { type: 'object' } }),
    schemaHashFor({ name: 'knowledge.search', version: '1.0.0', description: 'd', input_schema: { type: 'object' } }),
  );
  assert.notEqual(
    schemaHashFor({ name: 'knowledge.search', version: '1.0.0', description: 'd', input_schema: { type: 'object' } }),
    schemaHashFor({ name: 'knowledge.search', version: '1.0.1', description: 'd', input_schema: { type: 'object' } }),
  );
});

test('normalizeToolDescriptor：默认值、校验与哈希', () => {
  const d = normalizeToolDescriptor({
    name: 'custom.abc', version: '1.2.0', source: 'custom', description: '工具',
    input_schema: { type: 'object', properties: { a: { type: 'number' } } },
    side_effect: 'code_exec',
  });
  assert.equal(d.approval_policy, 'risk_based');
  assert.equal(d.sandbox_profile, 'code_exec');
  assert.equal(d.idempotency, 'required');
  assert.equal(d.resource_scope, 'task');
  assert.match(d.schema_hash, /^[0-9a-f]{64}$/);
  assert.equal(d.code_hash, '');
  const h1 = descriptorHash(d);
  const h2 = descriptorHash({ ...d, code_hash: 'a'.repeat(64) });
  assert.notEqual(h1, h2);

  assert.throws(() => normalizeToolDescriptor({ name: 'Bad Name', source: 'builtin' }), ToolContractError);
  assert.throws(() => normalizeToolDescriptor({ name: 'x', version: '1.0', source: 'builtin' }), ToolContractError);
  assert.throws(() => normalizeToolDescriptor({ name: 'x', source: 'nope' }), ToolContractError);
  assert.throws(() => normalizeToolDescriptor({ name: 'x', source: 'builtin', side_effect: 'nope' }), ToolContractError);
  assert.throws(() => normalizeToolDescriptor({ name: 'x', source: 'builtin', schema_hash: 'xyz' }), ToolContractError);
  assert.throws(() => normalizeToolDescriptor({
    name: 'x', source: 'builtin', input_schema: { type: 'object', $ref: '#/x' },
  }), /不支持/);
});

test('JSON 数字格式同一值生成同一哈希', () => {
  assert.equal(hashJson({ n: 1 }), hashJson({ n: 1.0 }));
  assert.notEqual(hashJson({ n: 1 }), hashJson({ n: 2 }));
});
