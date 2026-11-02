import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideToolCall, approvalRequired, riskLevelOf, PolicyDeniedError,
} from '../../server/tools/policy.js';

const readTool = { name: 'knowledge.search', side_effect: 'read', approval_policy: 'never', resource_scope: 'knowledge_base', enabled: true };
const execTool = { name: 'custom.x', side_effect: 'code_exec', approval_policy: 'risk_based', resource_scope: 'task', enabled: true };
const sendTool = { name: 'mcp.x.send', side_effect: 'external_send', approval_policy: 'never', resource_scope: 'external', enabled: true };
const task = { owner_id: 'u1', tenant_id: 't1', preset_id: null, input_json: {} };

test('默认：读工具 allow，高风险工具 approval，禁用 deny', () => {
  assert.equal(decideToolCall({ task, tool: readTool }).decision, 'allow');
  assert.equal(decideToolCall({ task, tool: execTool }).decision, 'approval');
  const disabled = { ...execTool, enabled: false };
  assert.equal(decideToolCall({ task, tool: disabled }).decision, 'deny');
  assert.equal(decideToolCall({ task, tool: disabled }).reason, 'tool_disabled');
  assert.equal(decideToolCall({ task, tool: null }).decision, 'deny');
});

test('policy 优先级：user > role > preset > tenant', () => {
  const policies = [
    { principal_type: 'tenant', principal_id: 't1', enabled: true, approval_mode: 'never' },
    { principal_type: 'preset', principal_id: 'p1', enabled: true, approval_mode: 'always' },
    { principal_type: 'role', principal_id: 'owner', enabled: false },
    { principal_type: 'user', principal_id: 'u1', enabled: true, approval_mode: 'never' },
  ];
  const withPreset = { ...task, preset_id: 'p1' };
  const d1 = decideToolCall({ task: withPreset, tool: readTool, policies, roleIds: ['owner'] });
  assert.equal(d1.decision, 'allow', 'user policy 优先');
  assert.equal(d1.approvalMode, 'never');

  const withoutUser = policies.filter(p => p.principal_type !== 'user');
  assert.equal(decideToolCall({ task: withPreset, tool: readTool, policies: withoutUser, roleIds: ['owner'] }).decision, 'deny');

  const roleOnly = policies.filter(p => p.principal_type === 'role');
  assert.equal(decideToolCall({ task, tool: readTool, policies: roleOnly, roleIds: ['owner'] }).decision, 'deny');
});

test('policy 限制：允许范围、单任务次数、预算', () => {
  const scoped = [{ principal_type: 'user', principal_id: 'u1', enabled: true, allowed_scopes: ['task'] }];
  assert.equal(decideToolCall({ task, tool: readTool, policies: scoped }).reason, 'policy_scope_denied');

  const limited = [{ principal_type: 'user', principal_id: 'u1', enabled: true, max_calls_per_task: 2 }];
  assert.equal(decideToolCall({ task, tool: readTool, policies: limited, callCount: 1 }).decision, 'allow');
  assert.equal(decideToolCall({ task, tool: readTool, policies: limited, callCount: 2 }).reason, 'rate_limited');

  const budgetDenied = decideToolCall({ task, tool: execTool, budget: { max_tool_calls: 1 }, usage: { tool_calls: 1 } });
  assert.equal(budgetDenied.decision, 'deny');
  assert.equal(budgetDenied.fatal, true);
});

test('审批：never 不能降级高风险；task always 提升所有工具', () => {
  assert.equal(approvalRequired({ tool: sendTool, approvalMode: 'never' }), true);
  assert.equal(approvalRequired({ tool: execTool, approvalMode: 'never' }), true);
  assert.equal(approvalRequired({ tool: readTool, approvalMode: 'never' }), false);
  assert.equal(approvalRequired({ tool: readTool, approvalMode: 'risk_based' }), false);
  assert.equal(approvalRequired({ tool: readTool, approvalMode: 'always' }), true);
  assert.equal(riskLevelOf(sendTool), 'high');

  const alwaysTask = { ...task, input_json: { approval_mode: 'always' } };
  assert.equal(decideToolCall({ task: alwaysTask, tool: readTool }).decision, 'approval');
  assert.equal(decideToolCall({ task, tool: sendTool }).decision, 'approval', 'external_send 始终需要审批');

  const policyNever = [{ principal_type: 'user', principal_id: 'u1', enabled: true, approval_mode: 'never' }];
  assert.equal(decideToolCall({ task, tool: sendTool, policies: policyNever }).decision, 'approval');
});

test('PolicyDeniedError 携带 reason / fatal / code', () => {
  const e = new PolicyDeniedError('rate_limited', '太频繁', { code: 'rate_limited' });
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.fatal, false);
  assert.equal(e.retryable, false);
});
