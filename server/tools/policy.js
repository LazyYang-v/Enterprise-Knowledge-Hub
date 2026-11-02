// PolicyEngine：默认拒绝；只有明确 allow / approval 才能进入执行。
// 决策顺序：工具存在/版本 → 归属/启用 → 策略（user > role > preset > tenant）→
// 次数/预算 → 审批。策略拒绝以工具错误返回模型，预算耗尽才是 fatal。
import { HIGH_RISK_SIDE_EFFECTS } from './contract.js';

export class PolicyDeniedError extends Error {
  constructor(reason, message, { fatal = false, code = 'policy_denied' } = {}){
    super(message);
    this.name = 'PolicyDeniedError';
    this.reason = reason;
    this.code = code;
    this.fatal = fatal;
    this.retryable = false;
  }
}

function selectPolicy(policies, { userId, roleIds = [], presetId = null, tenantId }){
  const list = Array.isArray(policies) ? policies : [];
  const by = (type, id) => list.find(p => p.principal_type === type && String(p.principal_id) === String(id));
  return by('user', userId)
    || roleIds.map(r => by('role', r)).find(Boolean)
    || (presetId ? by('preset', presetId) : null)
    || (tenantId ? by('tenant', tenantId) : null)
    || null;
}

export function riskLevelOf(tool){
  if (['destructive', 'external_send', 'write_business', 'code_exec'].includes(tool.side_effect)) return 'high';
  if (tool.side_effect === 'write_workspace') return 'medium';
  return 'low';
}

export function approvalRequired({ tool, approvalMode = 'risk_based' }){
  const risk = riskLevelOf(tool);
  // 任务/policy 的 never 不得降级高风险写与代码执行。
  if (HIGH_RISK_SIDE_EFFECTS.includes(tool.side_effect)) return true;
  if (approvalMode === 'always') return true;
  return approvalMode === 'risk_based' && risk === 'high';
}

/**
 * @returns {{decision:'allow'|'approval'|'deny', reason:string, riskLevel:'low'|'medium'|'high',
 *   approvalMode:string, fatal:boolean, policy?:object}}
 */
export function decideToolCall({
  task, tool, policies = [], usage = {}, budget = {}, callCount = 0, roleIds = [],
} = {}){
  if (!tool){
    return { decision: 'deny', reason: 'tool_not_found', riskLevel: 'low', approvalMode: 'never', fatal: false };
  }
  if (tool.enabled === false){
    return { decision: 'deny', reason: 'tool_disabled', riskLevel: riskLevelOf(tool), approvalMode: 'never', fatal: false };
  }
  const policy = selectPolicy(policies, {
    userId: task?.owner_id, roleIds, presetId: task?.preset_id, tenantId: task?.tenant_id,
  });
  if (policy && policy.enabled === false){
    return { decision: 'deny', reason: 'policy_denied', riskLevel: riskLevelOf(tool), approvalMode: policy.approval_mode || 'never', fatal: false, policy };
  }
  if (policy?.allowed_scopes?.length && !policy.allowed_scopes.includes(tool.resource_scope)){
    return { decision: 'deny', reason: 'policy_scope_denied', riskLevel: riskLevelOf(tool), approvalMode: policy.approval_mode || 'never', fatal: false, policy };
  }
  if (policy?.max_calls_per_task != null && callCount >= Number(policy.max_calls_per_task)){
    return { decision: 'deny', reason: 'rate_limited', riskLevel: riskLevelOf(tool), approvalMode: policy.approval_mode || 'never', fatal: false, policy };
  }
  const maxToolCalls = Number(budget.max_tool_calls);
  if (Number.isFinite(maxToolCalls) && Number(usage.tool_calls || 0) >= maxToolCalls){
    return { decision: 'deny', reason: 'budget_exhausted', riskLevel: riskLevelOf(tool), approvalMode: 'never', fatal: true, policy };
  }

  const taskMode = ['never', 'risk_based', 'always'].includes(task?.input_json?.approval_mode)
    ? task.input_json.approval_mode : 'risk_based';
  const approvalMode = taskMode === 'always'
    ? 'always'
    : (policy?.approval_mode || tool.approval_policy || taskMode);
  const riskLevel = riskLevelOf(tool);
  if (approvalRequired({ tool, approvalMode })){
    return { decision: 'approval', reason: 'approval_required', riskLevel, approvalMode, fatal: false, policy };
  }
  return { decision: 'allow', reason: 'allowed', riskLevel, approvalMode, fatal: false, policy };
}
