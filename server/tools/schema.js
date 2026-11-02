// 工具 JSON Schema 子集：不引入外部依赖，禁止 $ref 与过深嵌套。
// P0 只支持对象/数组/标量、required、properties、additionalProperties、enum、
// anyOf/oneOf、min/max、长度与数量限制；未知关键字在定义阶段拒绝。

export const MAX_SCHEMA_DEPTH = 8;

export class ToolSchemaError extends Error {
  constructor(message, code = 'tool_schema_invalid'){
    super(message);
    this.name = 'ToolSchemaError';
    this.code = code;
    this.retryable = false;
  }
}

const ALLOWED_KEYS = new Set([
  'type', 'description', 'title', 'default', 'enum', 'const',
  'properties', 'required', 'additionalProperties', 'items',
  'minLength', 'maxLength', 'minimum', 'maximum',
  'minItems', 'maxItems', 'anyOf', 'oneOf',
  'format', 'examples',
]);
const FORBIDDEN_KEYS = new Set([
  '$ref', '$defs', 'definitions', 'allOf', 'not', 'if', 'then', 'else',
  'patternProperties', 'dependencies', 'dependentSchemas', 'unevaluatedProperties',
]);

function isPlainObject(v){
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function assertSchemaDefinition(schema, path = '$', depth = 0){
  if (depth > MAX_SCHEMA_DEPTH) throw new ToolSchemaError(`schema 嵌套超过 ${MAX_SCHEMA_DEPTH} 层`);
  if (!isPlainObject(schema)) throw new ToolSchemaError(`${path} 必须是对象`);
  for (const key of Object.keys(schema)){
    if (FORBIDDEN_KEYS.has(key)) throw new ToolSchemaError(`${path} 不支持 ${key}`);
    if (!ALLOWED_KEYS.has(key)) throw new ToolSchemaError(`${path} 包含未知关键字 ${key}`);
  }
  const type = schema.type;
  if (type != null && typeof type !== 'string') throw new ToolSchemaError(`${path}.type 必须是字符串`);
  if (type != null && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)){
    throw new ToolSchemaError(`${path}.type 不合法`);
  }
  if (schema.enum != null && !Array.isArray(schema.enum)) throw new ToolSchemaError(`${path}.enum 必须是数组`);
  if (schema.required != null && (!Array.isArray(schema.required) || schema.required.some(v => typeof v !== 'string'))){
    throw new ToolSchemaError(`${path}.required 必须是字符串数组`);
  }
  if (schema.properties != null){
    if (!isPlainObject(schema.properties)) throw new ToolSchemaError(`${path}.properties 必须是对象`);
    for (const [key, sub] of Object.entries(schema.properties)){
      assertSchemaDefinition(sub, `${path}.properties.${key}`, depth + 1);
    }
  }
  if (schema.additionalProperties != null && typeof schema.additionalProperties !== 'boolean'){
    throw new ToolSchemaError(`${path}.additionalProperties 只支持布尔值`);
  }
  if (schema.items != null) assertSchemaDefinition(schema.items, `${path}.items`, depth + 1);
  for (const key of ['anyOf', 'oneOf']){
    if (schema[key] == null) continue;
    if (!Array.isArray(schema[key]) || schema[key].length === 0){
      throw new ToolSchemaError(`${path}.${key} 必须是非空数组`);
    }
    schema[key].forEach((sub, i) => assertSchemaDefinition(sub, `${path}.${key}[${i}]`, depth + 1));
  }
  return schema;
}

function typeOf(value){
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value, type){
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function fail(path, message){
  throw new ToolSchemaError(`${path} ${message}`, 'tool_schema_mismatch');
}

function validateAny(value, schema, path, depth){
  if (Array.isArray(schema.enum) && !schema.enum.some(v => Object.is(v, value))){
    fail(path, '不在 enum 允许值内');
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !Object.is(schema.const, value)){
    fail(path, '不等于 const');
  }
  if (schema.type != null && !matchesType(value, schema.type)){
    fail(path, `必须是 ${schema.type}`);
  }
  if (typeof value === 'string'){
    if (schema.minLength != null && value.length < schema.minLength) fail(path, `长度小于 ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) fail(path, `长度超过 ${schema.maxLength}`);
  }
  if (typeof value === 'number' && Number.isFinite(value)){
    if (schema.minimum != null && value < schema.minimum) fail(path, `小于最小值 ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) fail(path, `大于最大值 ${schema.maximum}`);
  }
  if (Array.isArray(value)){
    if (schema.minItems != null && value.length < schema.minItems) fail(path, `元素少于 ${schema.minItems}`);
    if (schema.maxItems != null && value.length > schema.maxItems) fail(path, `元素多于 ${schema.maxItems}`);
    if (schema.items) value.forEach((item, i) => validateValue(item, schema.items, `${path}[${i}]`, depth + 1));
  }
  if (isPlainObject(value)){
    const props = schema.properties || {};
    const required = schema.required || [];
    for (const key of required){
      if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key}`, '是必填字段');
    }
    for (const [key, sub] of Object.entries(value)){
      if (Object.prototype.hasOwnProperty.call(props, key)){
        validateValue(sub, props[key], `${path}.${key}`, depth + 1);
      } else if (schema.additionalProperties === false){
        fail(`${path}.${key}`, '不是允许的字段');
      }
    }
  }
}

function validateValue(value, schema, path, depth){
  if (depth > MAX_SCHEMA_DEPTH) fail(path, '嵌套过深');
  if (!isPlainObject(schema)) fail(path, 'schema 不合法');
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)){
    // JSON Schema 语义：父级关键字与 anyOf/oneOf 同时生效。
    const { anyOf, oneOf, ...base } = schema;
    if (Object.keys(base).length) validateAny(value, base, path, depth);
    if (Array.isArray(anyOf)){
      const errors = [];
      for (const sub of anyOf){
        try { validateValue(value, sub, path, depth); return; } catch (e){ errors.push(e.message); }
      }
      fail(path, `不匹配 anyOf（${errors.slice(0, 2).join('；')}）`);
    }
    let matched = 0;
    for (const sub of oneOf){
      try { validateValue(value, sub, path, depth); matched += 1; } catch { /* 继续 */ }
    }
    if (matched !== 1) fail(path, '必须匹配且只匹配 oneOf 中的一项');
    return;
  }
  validateAny(value, schema, path, depth);
}

/** 校验工具参数；失败抛 ToolSchemaError(code=tool_schema_mismatch)。 */
export function validateToolArguments(schema, args){
  const definition = schema == null ? { type: 'object', properties: {}, additionalProperties: false } : schema;
  assertSchemaDefinition(definition);
  validateValue(args, definition, 'arguments', 0);
  return args;
}
