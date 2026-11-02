import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSchemaDefinition, validateToolArguments, ToolSchemaError, MAX_SCHEMA_DEPTH,
} from '../../server/tools/schema.js';

const isMismatch = e => e instanceof ToolSchemaError && e.code === 'tool_schema_mismatch';

test('参数校验：required / properties / additionalProperties', () => {
  const schema = {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, maxLength: 5 }, top_k: { type: 'integer', minimum: 1 } },
    required: ['query'],
    additionalProperties: false,
  };
  assert.doesNotThrow(() => validateToolArguments(schema, { query: 'abc' }));
  assert.throws(() => validateToolArguments(schema, {}), isMismatch);
  assert.throws(() => validateToolArguments(schema, { query: '' }), isMismatch);
  assert.throws(() => validateToolArguments(schema, { query: 'abcdef' }), isMismatch);
  assert.throws(() => validateToolArguments(schema, { query: 'a', top_k: 0 }), isMismatch);
  assert.throws(() => validateToolArguments(schema, { query: 'a', extra: 1 }), isMismatch);
  assert.throws(() => validateToolArguments(schema, null), isMismatch);
  assert.throws(() => validateToolArguments(schema, []), isMismatch);
});

test('参数校验：enum / const / anyOf / oneOf / 数组', () => {
  const schema = {
    type: 'object',
    properties: {
      mode: { enum: ['a', 'b'] },
      kind: { const: 'x' },
      list: { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 2 },
      either: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      exactly: { oneOf: [{ type: 'number' }, { type: 'integer' }] },
    },
    required: ['mode', 'kind', 'list'],
    additionalProperties: false,
  };
  assert.doesNotThrow(() => validateToolArguments(schema, {
    mode: 'a', kind: 'x', list: [1, 2], either: 's', exactly: 1.5,
  }));
  assert.throws(() => validateToolArguments(schema, { mode: 'c', kind: 'x', list: [1] }), isMismatch);
  assert.throws(() => validateToolArguments(schema, { mode: 'a', kind: 'y', list: [1] }), isMismatch);
  assert.throws(() => validateToolArguments(schema, { mode: 'a', kind: 'x', list: [] }), isMismatch);
  assert.throws(() => validateToolArguments(schema, { mode: 'a', kind: 'x', list: [1, 2, 3] }), isMismatch);
  assert.throws(() => validateToolArguments(schema, { mode: 'a', kind: 'x', list: ['1'] }), isMismatch);
  assert.throws(() => validateToolArguments(schema, { mode: 'a', kind: 'x', list: [1], either: true }), isMismatch);
  // 1 同时匹配 number 与 integer，因此不满足 oneOf。
  assert.throws(() => validateToolArguments(schema, { mode: 'a', kind: 'x', list: [1], exactly: 1 }), /oneOf/);
});

test('schema 定义：拒绝 $ref、未知关键字与过深嵌套', () => {
  for (const bad of [
    { type: 'object', $ref: '#/x' },
    { type: 'object', $defs: {} },
    { type: 'object', allOf: [] },
    { type: 'object', patternProperties: {} },
    { type: 'object', mystery: true },
    { type: 'object', additionalProperties: { type: 'string' } },
    { type: 'object', anyOf: [] },
    { type: 'object', required: [1] },
    { type: 'wat' },
  ]) assert.throws(() => assertSchemaDefinition(bad), ToolSchemaError);

  let deep = { type: 'string' };
  for (let i = 0; i <= MAX_SCHEMA_DEPTH + 1; i++) deep = { type: 'object', properties: { x: deep } };
  assert.throws(() => assertSchemaDefinition(deep), /嵌套超过/);
});

test('空 schema 只接受空对象', () => {
  assert.doesNotThrow(() => validateToolArguments(null, {}));
  assert.throws(() => validateToolArguments(null, { a: 1 }), isMismatch);
});
