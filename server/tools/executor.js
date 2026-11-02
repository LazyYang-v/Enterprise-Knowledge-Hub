// ToolExecutor：快照校验 → schema → PolicyEngine → 分派 builtin/custom/mcp。
// 执行器不创建任务状态、不写事件；调用方（TaskExecutor）负责持久化与状态迁移。
import { config } from '../config.js';
import { resolvePinned, getBuiltinHandler } from './registry.js';
import { validateToolArguments, ToolSchemaError } from './schema.js';
import { decideToolCall, PolicyDeniedError } from './policy.js';
import { normalizeToolResult, ToolRunError } from './result.js';
import { listToolPolicies } from '../control/tool-registry-repo.js';
import { countToolCalls } from '../control/task-repo.js';
import { getCustomToolVersion } from './custom-tools-repo.js';
import { runSandbox } from './sandbox.js';
import { callMcpTool } from './mcp-client.js';

function snapshotList(task){
  return Array.isArray(task?.input_json?.tools) ? task.input_json.tools : [];
}

function attemptNumber(descriptor){
  return String(descriptor?.version || '').split('.')[1];
}

export function createToolExecutor({ task, knowledge = null, signal = null } = {}){
  const snapshots = snapshotList(task);

  function findSnapshot(name){
    return snapshots.find(t => t.name === name) || null;
  }

  async function prepare(name, args){
    const snapshot = findSnapshot(name);
    if (!snapshot){
      throw new PolicyDeniedError('tool_not_allowed', `工具不在任务快照内：${name}`, { code: 'tool_not_found' });
    }
    let current;
    try {
      current = await resolvePinned({
        tenantId: task.tenant_id, ownerId: task.owner_id, snapshot,
      });
    } catch (e){
      throw new PolicyDeniedError(e.code || 'tool_schema_mismatch', e.message, { code: e.code || 'tool_schema_mismatch' });
    }
    try {
      validateToolArguments(snapshot.input_schema, args);
    } catch (e){
      if (e instanceof ToolSchemaError) throw e;
      throw new ToolSchemaError(e.message, 'tool_schema_mismatch');
    }
    let policies = [];
    try {
      policies = await listToolPolicies({ tenantId: task.tenant_id, toolName: name });
    } catch (e){
      throw new ToolRunError('tool_unavailable', `策略读取失败：${e.message}`, { retryable: true });
    }
    const callCount = await countToolCalls({
      tenantId: task.tenant_id, taskId: task.id, toolName: name,
    });
    const decision = decideToolCall({
      task, tool: current, policies,
      usage: task.usage_json || {}, budget: task.budget_json || {}, callCount,
    });
    if (decision.decision === 'deny'){
      throw new PolicyDeniedError(decision.reason, `工具调用被策略拒绝：${decision.reason}`, {
        fatal: !!decision.fatal, code: decision.reason,
      });
    }
    return { snapshot, current, decision };
  }

  async function execute(descriptor, args, { toolCallId = null, stepId = null } = {}){
    try {
      let value;
      if (descriptor.source === 'builtin'){
        const handler = getBuiltinHandler(descriptor.name);
        if (!handler) throw new ToolRunError('tool_unavailable', '内置工具未注册');
        value = await handler(args, {
          task, knowledge, toolCallId, stepId, leaseEpoch: task.lease_epoch,
        });
      } else if (descriptor.source === 'custom'){
        const toolId = descriptor.tool_id || descriptor.name.slice('custom.'.length);
        const versionNo = Number(attemptNumber(descriptor));
        const versionRow = getCustomToolVersion(toolId, versionNo);
        if (!versionRow) throw new ToolRunError('tool_version_missing', '自定义工具版本不存在');
        if (versionRow.code_hash !== descriptor.code_hash){
          throw new ToolRunError('tool_code_changed', '自定义工具代码已变化');
        }
        const out = await runSandbox({
          mode: 'execute', code: versionRow.code, args,
          timeoutMs: Math.min(descriptor.timeout_ms || config.tools.timeoutMs, config.tools.timeoutMs),
        });
        value = out.result;
        return normalizeToolResult({ status: 'succeeded', value, untrusted: true });
      } else if (descriptor.source === 'mcp'){
        value = await callMcpTool({ task, descriptor, args, signal });
      } else {
        throw new ToolRunError('tool_unavailable', '未知工具来源');
      }
      return normalizeToolResult({ status: 'succeeded', value, untrusted: true });
    } catch (e){
      if (e instanceof PolicyDeniedError) throw e;
      return normalizeToolResult({
        status: 'failed',
        errorCode: e?.code || 'tool_execution_failed',
        errorMessage: e?.message || String(e),
        untrusted: false,
      });
    }
  }

  return {
    snapshots,
    names: () => snapshots.map(t => t.name),
    findSnapshot,
    setTask: t => { task = t; },
    pinned: snapshot => resolvePinned({
      tenantId: task.tenant_id, ownerId: task.owner_id, snapshot,
    }),
    prepare,
    execute,
  };
}
