// ToolRegistry：组合内置工具、自定义工具不可变版本与 MCP 缓存，
// 在任务创建时固定完整描述符快照；执行阶段只认快照 + 当前注册表校验。
import { config } from '../config.js';
import {
  normalizeToolDescriptor, schemaHashFor, customToolName, customToolVersion,
  ToolReferenceError,
} from './contract.js';
import { builtinDescriptor, builtinDescriptors, getBuiltinTool } from './builtins.js';
import {
  getCustomTool, getCustomToolVersion, listCustomTools,
} from './custom-tools-repo.js';
import { getToolRegistryRow, listToolRegistry } from '../control/tool-registry-repo.js';

export class ToolDriftError extends Error {
  constructor(message, code = 'tool_schema_mismatch'){
    super(message);
    this.name = 'ToolDriftError';
    this.code = code;
    this.retryable = false;
  }
}

const BUILTIN_NAMES = new Set(builtinDescriptors().map(d => d.name));

export function defaultToolRefs(){
  return ['knowledge.search', 'knowledge.get_document', 'knowledge.get_citation', 'knowledge.list_bases'];
}

function diagnoseCustomRef(ref){
  const id = ref.startsWith('custom:') ? ref.slice(7) : ref.slice(7);
  const row = getCustomTool(id, { includeDeleted: true });
  if (!row) throw new ToolReferenceError(`工具不存在：${ref}`, 'tool_not_found');
  if (row.deleted_at) throw new ToolReferenceError(`工具已删除：${ref}`, 'tool_not_found');
  if (!row.enabled) throw new ToolReferenceError(`工具已停用：${ref}`, 'tool_not_found');
  return row;
}

export function descriptorForCustom(tool, versionRow = null){
  const version = versionRow || getCustomToolVersion(tool.id, tool.current_version);
  if (!version) throw new ToolDriftError('自定义工具版本不存在', 'tool_version_missing');
  const descriptor = normalizeToolDescriptor({
    name: customToolName(tool.id),
    version: customToolVersion({ current_version: version.version }),
    source: 'custom',
    description: version.description || tool.description || '',
    input_schema: version.parameters || {},
    // 自定义 JS 工具在子进程中执行，按代码执行对待。
    side_effect: 'code_exec',
    approval_policy: 'risk_based',
    timeout_ms: config.tools.timeoutMs,
    idempotency: 'none',
    resource_scope: 'task',
    sandbox_profile: 'code_exec',
    code_hash: version.code_hash,
    tool_id: tool.id,
    enabled: !!tool.enabled,
  });
  return descriptor;
}

export function descriptorFromRegistryRow(row){
  if (!row) return null;
  return normalizeToolDescriptor({
    name: row.name,
    version: row.version,
    source: row.source,
    description: row.description || '',
    input_schema: row.input_schema || {},
    schema_hash: row.schema_hash,
    side_effect: row.side_effect,
    approval_policy: row.approval_policy,
    timeout_ms: Number(row.timeout_ms),
    idempotency: row.idempotency,
    resource_scope: row.resource_scope,
    sandbox_profile: row.sandbox_profile,
    code_hash: row.code_hash || '',
    connection_id: row.connection_id || undefined,
    enabled: !!row.enabled,
  });
}

function resolveOne(ref, { tenantId, ownerId }){
  if (BUILTIN_NAMES.has(ref)){
    const d = builtinDescriptor(ref);
    return normalizeToolDescriptor({ ...d, enabled: true });
  }
  if (ref.startsWith('custom:') || ref.startsWith('custom.')){
    const row = diagnoseCustomRef(ref);
    if (String(row.owner_id) !== String(ownerId)){
      throw new ToolReferenceError(`无权使用该工具：${ref}`, 'tool_forbidden');
    }
    const d = descriptorForCustom(row);
    if (!d.enabled) throw new ToolReferenceError(`工具已停用：${ref}`, 'tool_not_found');
    return d;
  }
  // MCP 工具由 tool_registry 记录，名称形如 mcp.<connection>.<tool>。
  return null;
}

async function resolveMcp(ref, { tenantId }){
  if (!ref.startsWith('mcp.')) return null;
  const row = await getToolRegistryRow({ tenantId, name: ref });
  if (!row || row.source !== 'mcp') throw new ToolReferenceError(`工具不存在：${ref}`, 'tool_not_found');
  if (!row.enabled) throw new ToolReferenceError(`工具已停用：${ref}`, 'tool_not_found');
  return descriptorFromRegistryRow(row);
}

/** 创建任务时解析工具引用；返回完整描述符数组（快照）。 */
export async function resolveTools({ tenantId, ownerId, refs = null } = {}){
  const requested = refs == null || (Array.isArray(refs) && refs.length === 0) ? defaultToolRefs() : refs;
  if (!Array.isArray(requested)) throw new ToolReferenceError('tools 必须是数组', 'tool_invalid');
  const unique = [...new Set(requested.map(String))];
  if (unique.length > config.tools.maxToolsPerTask){
    throw new ToolReferenceError(`工具数量超过上限 ${config.tools.maxToolsPerTask}`, 'tool_invalid');
  }
  const out = [];
  for (const ref of unique){
    const local = resolveOne(ref, { tenantId, ownerId });
    if (local){ out.push(local); continue; }
    const mcp = await resolveMcp(ref, { tenantId });
    if (mcp){ out.push(mcp); continue; }
    throw new ToolReferenceError(`未知工具：${ref}`, 'tool_not_found');
  }
  return out;
}

/** 执行阶段按快照重新解析；版本/哈希漂移即拒绝执行。 */
export async function resolvePinned({ tenantId, ownerId, snapshot } = {}){
  const name = String(snapshot?.name || '');
  if (BUILTIN_NAMES.has(name)){
    const current = normalizeToolDescriptor({ ...builtinDescriptor(name), enabled: true });
    if (snapshot.version !== current.version || snapshot.schema_hash !== current.schema_hash){
      throw new ToolDriftError(`内置工具定义已变化：${name}`);
    }
    return current;
  }
  if (name.startsWith('custom.')){
    const toolId = snapshot.tool_id || name.slice('custom.'.length);
    const row = getCustomTool(toolId, { includeDeleted: true });
    if (!row || row.deleted_at) throw new ToolDriftError(`工具不存在：${name}`, 'tool_not_found');
    if (String(row.owner_id) !== String(ownerId)) throw new ToolDriftError('无权使用该工具', 'tool_forbidden');
    if (!row.enabled) throw new ToolDriftError(`工具已停用：${name}`, 'tool_disabled');
    const version = Number(String(snapshot.version || '').split('.')[1]);
    const versionRow = Number.isInteger(version) ? getCustomToolVersion(toolId, version) : null;
    if (!versionRow) throw new ToolDriftError(`工具版本不存在：${name}@${snapshot.version}`, 'tool_version_missing');
    if (versionRow.code_hash !== snapshot.code_hash){
      throw new ToolDriftError(`工具代码已变化：${name}@${snapshot.version}`, 'tool_code_changed');
    }
    const current = descriptorForCustom(row, versionRow);
    if (current.schema_hash !== snapshot.schema_hash || current.version !== snapshot.version){
      throw new ToolDriftError(`工具定义已变化：${name}`);
    }
    return current;
  }
  if (name.startsWith('mcp.')){
    const row = await getToolRegistryRow({ tenantId, name, version: snapshot.version });
    if (!row || row.source !== 'mcp') throw new ToolDriftError(`MCP 工具不存在：${name}`, 'tool_not_found');
    if (!row.enabled) throw new ToolDriftError(`MCP 工具已停用：${name}`, 'tool_disabled');
    if (row.schema_hash !== snapshot.schema_hash){
      throw new ToolDriftError(`MCP 工具定义已变化：${name}`);
    }
    return descriptorFromRegistryRow(row);
  }
  throw new ToolDriftError(`未知工具：${name}`, 'tool_not_found');
}

/** 列出用户可见的工具（工具箱/注册表 API）。 */
export async function listForUser({ tenantId, userId, isAdmin = false } = {}){
  const builtins = builtinDescriptors().map(d => normalizeToolDescriptor({ ...d, enabled: true }));
  const customs = listCustomTools({ ownerId: userId, includeAll: isAdmin })
    .filter(t => !t.deleted_at)
    .map(t => ({ ...descriptorForCustom(t), owner_id: t.owner_id }));
  let mcp = [];
  try {
    const rows = await listToolRegistry({ tenantId });
    mcp = rows.filter(r => r.source === 'mcp').map(r => ({
      ...descriptorFromRegistryRow(r),
      connection_name: String(r.name).split('.')[1] || '',
      untrusted_description: true,
    }));
  } catch (e){
    // 注册表 API 在 PG 不可用时只返回本地工具，不阻断工具箱。
    console.error('[tools] mcp registry unavailable:', e?.message || e);
  }
  return [...builtins, ...customs, ...mcp];
}

export function getBuiltinHandler(name){
  return getBuiltinTool(name)?.handler || null;
}
