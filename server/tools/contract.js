// 工具统一契约：规范 JSON、参数哈希、描述符校验与工具名约定。
// 任务快照与审批都依赖这里生成的稳定哈希；禁止依赖 JSON.stringify 的键顺序。
import crypto from 'node:crypto';
import { assertSchemaDefinition } from './schema.js';

export const TOOL_SOURCES = Object.freeze(['builtin', 'custom', 'mcp', 'system']);
export const SIDE_EFFECTS = Object.freeze(['read', 'write_workspace', 'write_business', 'external_send', 'destructive', 'code_exec']);
export const APPROVAL_POLICIES = Object.freeze(['never', 'risk_based', 'always']);
export const IDEMPOTENCY = Object.freeze(['none', 'required', 'provider_key']);
export const RESOURCE_SCOPES = Object.freeze(['task', 'knowledge_base', 'external']);
export const SANDBOX_PROFILES = Object.freeze(['read_only', 'workspace_write', 'network_allowlist', 'code_exec', 'browser']);
export const HIGH_RISK_SIDE_EFFECTS = Object.freeze(['write_business', 'external_send', 'destructive', 'code_exec']);

const TOOL_NAME_RE = /^[a-z][a-z0-9_.-]{0,127}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

export class ToolContractError extends Error {
  constructor(message, code = 'tool_contract_invalid'){
    super(message);
    this.name = 'ToolContractError';
    this.code = code;
    this.retryable = false;
  }
}

export class ToolReferenceError extends Error {
  constructor(message, code = 'tool_not_found'){
    super(message);
    this.name = 'ToolReferenceError';
    this.code = code;
    this.retryable = false;
    this.status = code === 'tool_forbidden' ? 403 : 422;
  }
}

function canonicalize(value, seen){
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number'){
    if (!Number.isFinite(value)) throw new ToolContractError('JSON 不能包含非有限数字');
    return value;
  }
  if (t !== 'object') throw new ToolContractError(`JSON 不能包含 ${t}`);
  if (seen.has(value)) throw new ToolContractError('JSON 不能包含循环引用');
  seen.add(value);
  let out;
  if (Array.isArray(value)){
    out = value.map(v => canonicalize(v, seen));
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new ToolContractError('只接受纯 JSON 对象');
    out = {};
    for (const key of Object.keys(value).sort()){
      out[key] = canonicalize(value[key], seen);
    }
  }
  seen.delete(value);
  return out;
}

export function canonicalJson(value){
  return JSON.stringify(canonicalize(value, new Set()));
}

export function hashJson(value){
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function hashArgs(args){
  return hashJson(args ?? {});
}

export function schemaHashFor({ name, version, description = '', input_schema = {} }){
  return hashJson({ name, version, description, input_schema });
}

export function isToolName(value){
  return typeof value === 'string' && TOOL_NAME_RE.test(value);
}

export function customToolName(toolId){
  return `custom.${String(toolId)}`;
}

export function customToolVersion(row){
  const v = Number(row?.current_version ?? row?.version ?? 1);
  return `1.${Number.isInteger(v) && v > 0 ? v : 1}.0`;
}

export function mcpToolName(connectionName, toolName){
  return `mcp.${String(connectionName)}.${String(toolName)}`;
}

export function normalizeToolDescriptor(raw){
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolContractError('工具描述必须是对象');
  const name = String(raw.name || '');
  if (!isToolName(name)) throw new ToolContractError('工具名不合法');
  const version = String(raw.version || '1.0.0');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new ToolContractError('工具版本必须是 x.y.z');
  const source = String(raw.source || '');
  if (!TOOL_SOURCES.includes(source)) throw new ToolContractError('工具来源不合法');
  const description = String(raw.description || '').slice(0, 2000);
  const inputSchema = raw.input_schema ?? raw.parameters ?? { type: 'object', properties: {}, additionalProperties: false };
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)){
    throw new ToolContractError('input_schema 必须是对象');
  }
  assertSchemaDefinition(inputSchema);
  const sideEffect = String(raw.side_effect || 'read');
  if (!SIDE_EFFECTS.includes(sideEffect)) throw new ToolContractError('side_effect 不合法');
  const approvalPolicy = String(raw.approval_policy || 'risk_based');
  if (!APPROVAL_POLICIES.includes(approvalPolicy)) throw new ToolContractError('approval_policy 不合法');
  const timeoutMs = Number(raw.timeout_ms ?? 30000);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new ToolContractError('timeout_ms 不合法');
  const idempotency = String(raw.idempotency || (sideEffect === 'read' ? 'none' : 'required'));
  if (!IDEMPOTENCY.includes(idempotency)) throw new ToolContractError('idempotency 不合法');
  const resourceScope = String(raw.resource_scope || (source === 'mcp' ? 'external' : 'task'));
  if (!RESOURCE_SCOPES.includes(resourceScope)) throw new ToolContractError('resource_scope 不合法');
  const sandboxProfile = String(raw.sandbox_profile || (sideEffect === 'code_exec' ? 'code_exec' : 'read_only'));
  if (!SANDBOX_PROFILES.includes(sandboxProfile)) throw new ToolContractError('sandbox_profile 不合法');

  const codeHash = raw.code_hash == null ? '' : String(raw.code_hash);
  if (codeHash && !HASH_RE.test(codeHash)) throw new ToolContractError('code_hash 不合法');
  const schemaHash = raw.schema_hash == null
    ? schemaHashFor({ name, version, description, input_schema: inputSchema })
    : String(raw.schema_hash);
  if (!HASH_RE.test(schemaHash)) throw new ToolContractError('schema_hash 不合法');

  const descriptor = {
    name, version, source,
    description,
    input_schema: inputSchema,
    schema_hash: schemaHash,
    side_effect: sideEffect,
    approval_policy: approvalPolicy,
    timeout_ms: timeoutMs,
    idempotency,
    resource_scope: resourceScope,
    sandbox_profile: sandboxProfile,
    code_hash: codeHash,
  };
  if (raw.tool_id != null) descriptor.tool_id = String(raw.tool_id);
  if (raw.connection_id != null) descriptor.connection_id = String(raw.connection_id);
  if (raw.connection_name != null) descriptor.connection_name = String(raw.connection_name);
  if (raw.untrusted_description != null) descriptor.untrusted_description = !!raw.untrusted_description;
  if (raw.enabled != null) descriptor.enabled = !!raw.enabled;
  return descriptor;
}

export function assertToolDescriptor(value){
  return normalizeToolDescriptor(value);
}

export function descriptorHash(descriptor){
  return hashJson({
    name: descriptor.name,
    version: descriptor.version,
    schema_hash: descriptor.schema_hash,
    code_hash: descriptor.code_hash || '',
    source: descriptor.source,
  });
}
