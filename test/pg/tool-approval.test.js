import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureSchema, createTenant, canUseTestDatabase, getEvents, closeTestDb,
} from '../helpers/pg.js';
import { startFakeModel, finish } from '../helpers/fake-model.js';
import { getPool } from '../../server/control/pg.js';
import { TaskService } from '../../server/control/task-service.js';
import { claimNextTask } from '../../server/control/task-repo.js';
import { executeTask } from '../../server/control/task-executor.js';
import { resolveTools } from '../../server/tools/registry.js';
import { createToolExecutor } from '../../server/tools/executor.js';
import { createCustomTool } from '../../server/tools/custom-tools-repo.js';
import { customToolName } from '../../server/tools/contract.js';

const skip = !canUseTestDatabase();

const TOOL_CODE = `
export default {
  name: '加法',
  description: '返回两数之和',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
    additionalProperties: false,
  },
  execute({ a, b }) { return String(a + b); },
};
`;

const callTool = name => JSON.stringify({ type: 'call_tool', tool_name: name, arguments: { a: 1, b: 2 } });

function toolFactory({ task, knowledge, signal }){
  return createToolExecutor({ task, knowledge, signal });
}

test('S-08：工具审批暂停、参数绑定、一次性消费与拒绝不执行', { skip }, async t => {
  await ensureSchema();
  const tenantId = await createTenant('p04-approval');
  const ownerId = 'approval-user';
  const tool = createCustomTool({
    ownerId, name: '加法', description: '返回两数之和',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'], additionalProperties: false,
    },
    code: TOOL_CODE,
  });
  const name = customToolName(tool.id);
  const service = new TaskService({ resolveTools });
  t.after(async () => { await closeTestDb(); });

  const createTask = () => service.createTask({
    tenantId, ownerId, goal: '计算 1+2', input: { tools: [`custom:${tool.id}`] },
  });
  const toolCallRow = async taskId => (await getPool().query(
    'SELECT * FROM agent_tool_calls WHERE tenant_id = $1 AND task_id = $2 ORDER BY created_at',
    [tenantId, taskId],
  )).rows;
  const approvalRow = async taskId => (await getPool().query(
    'SELECT * FROM agent_approvals WHERE tenant_id = $1 AND task_id = $2 ORDER BY created_at',
    [tenantId, taskId],
  )).rows[0];

  await t.test('审批前不执行；参数变化 409；自批 403；批准后只执行一次', async () => {
    const task = await createTask();
    assert.deepEqual(task.input_json.tools.map(x => x.name), [name]);
    const claimed = await claimNextTask({ workerId: 'w-approval', leaseTtlMs: 5000 });
    assert.equal(claimed.id, task.id);

    const model = await startFakeModel(({ call }) => (
      call === 1 ? callTool(name) : finish('计算完成')
    ));
    t.after(() => model.close());

    const paused = await executeTask(claimed, {
      workerId: 'w-approval', model, toolFactory,
    });
    assert.equal(paused.status, 'waiting_approval');
    const row = await getPool().query('SELECT status FROM agent_tasks WHERE tenant_id = $1 AND id = $2', [tenantId, task.id]);
    assert.equal(row.rows[0].status, 'waiting_approval');

    const [call] = await toolCallRow(task.id);
    assert.equal(call.status, 'awaiting_approval');
    assert.equal(call.code_hash, tool.code_hash);
    assert.match(call.args_hash, /^[0-9a-f]{64}$/);
    assert.equal((await getPool().query(
      'SELECT COUNT(*)::int AS n FROM agent_tool_attempts WHERE tenant_id = $1 AND tool_call_id = $2',
      [tenantId, call.id],
    )).rows[0].n, 0, '审批前不得执行');

    const approval = await approvalRow(task.id);
    assert.equal(approval.status, 'pending');
    assert.equal(approval.tool_call_id, call.id);
    assert.equal(approval.args_hash, call.args_hash);

    // 审批 UI 需要展示真实调用参数；快照只返回给任务所有者。
    const pausedSnapshot = await service.snapshot({ tenantId, taskId: task.id, userId: ownerId });
    assert.deepEqual(pausedSnapshot.pending.approval.arguments, { a: 1, b: 2 });

    // 参数哈希不匹配：拒绝批准。
    await assert.rejects(() => service.decideApproval({
      tenantId, approvalId: approval.id, userId: ownerId, decision: 'approve',
      argsHash: '0'.repeat(64),
    }), e => e.code === 'approval_args_mismatch');
    assert.equal((await approvalRow(task.id)).status, 'pending');

    // 自批：把请求人改成当前用户，拒绝。
    await getPool().query('UPDATE agent_approvals SET requested_by = $3 WHERE tenant_id = $1 AND id = $2', [
      tenantId, approval.id, ownerId,
    ]);
    await assert.rejects(() => service.decideApproval({
      tenantId, approvalId: approval.id, userId: ownerId, decision: 'approve', argsHash: call.args_hash,
    }), e => e.code === 'forbidden');
    await getPool().query('UPDATE agent_approvals SET requested_by = $3 WHERE tenant_id = $1 AND id = $2', [
      tenantId, approval.id, `agent:w-approval`,
    ]);

    const approved = await service.decideApproval({
      tenantId, approvalId: approval.id, userId: ownerId, decision: 'approve', argsHash: call.args_hash,
    });
    assert.equal(approved.status, 'queued');
    const afterApprove = await approvalRow(task.id);
    assert.equal(afterApprove.status, 'approved');
    assert.equal(afterApprove.consumed_at, null, '批准不等于已执行');

    const resumedClaim = await claimNextTask({ workerId: 'w-resume', leaseTtlMs: 5000 });
    assert.equal(resumedClaim.id, task.id);
    const resumed = await executeTask(resumedClaim, {
      workerId: 'w-resume', model, toolFactory,
    });
    assert.equal(resumed.status, 'completed');

    const done = await toolCallRow(task.id);
    assert.equal(done.length, 1, '不得创建第二个工具调用');
    assert.equal(done[0].status, 'succeeded');
    assert.match(done[0].result_preview, /3/);
    assert.match(done[0].result_hash, /^[0-9a-f]{64}$/);
    assert.equal((await getPool().query(
      'SELECT COUNT(*)::int AS n FROM agent_tool_attempts WHERE tenant_id = $1 AND tool_call_id = $2',
      [tenantId, done[0].id],
    )).rows[0].n, 1, '已批准调用只能执行一次');
    const consumed = await approvalRow(task.id);
    assert.ok(consumed.consumed_at);
    assert.equal(consumed.consumed_by, 'w-resume');

    const events = await getEvents(tenantId, task.id);
    const types = events.map(e => e.type);
    assert.ok(types.includes('tool.requested'));
    assert.ok(types.includes('tool.started'));
    assert.ok(types.includes('tool.completed'));
    assert.ok(types.includes('task.waiting_approval'));
    assert.equal(types.filter(x => x === 'tool.started').length, 1);
    const seqs = events.map(e => Number(e.seq));
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), '事件序号必须连续');
    const completed = events.find(e => e.type === 'task.completed');
    assert.equal(completed.payload.summary, '计算完成');
  });

  await t.test('批准后过期：恢复时不得执行，任务继续', async () => {
    const task = await createTask();
    const claimed = await claimNextTask({ workerId: 'w-expire', leaseTtlMs: 5000 });
    assert.equal(claimed.id, task.id);
    const pauseModel = await startFakeModel(() => callTool(name));
    t.after(() => pauseModel.close());
    assert.equal((await executeTask(claimed, {
      workerId: 'w-expire', model: pauseModel, toolFactory,
    })).status, 'waiting_approval');

    const approval = await approvalRow(task.id);
    await service.decideApproval({
      tenantId, approvalId: approval.id, userId: ownerId, decision: 'approve', argsHash: approval.args_hash,
    });
    await getPool().query(
      `UPDATE agent_approvals SET expires_at = now() - interval '1 second'
        WHERE tenant_id = $1 AND task_id = $2`,
      [tenantId, task.id],
    );

    const resumedClaim = await claimNextTask({ workerId: 'w-expire-resume', leaseTtlMs: 5000 });
    assert.equal(resumedClaim.id, task.id);
    const resumeModel = await startFakeModel(() => finish('审批过期后完成'));
    t.after(() => resumeModel.close());
    const result = await executeTask(resumedClaim, {
      workerId: 'w-expire-resume', model: resumeModel, toolFactory,
    });
    assert.equal(result.status, 'completed');

    const [call] = await toolCallRow(task.id);
    assert.equal(call.status, 'failed');
    assert.equal(call.error_code, 'approval_expired');
    assert.equal((await getPool().query(
      'SELECT COUNT(*)::int AS n FROM agent_tool_attempts WHERE tenant_id = $1 AND tool_call_id = $2',
      [tenantId, call.id],
    )).rows[0].n, 0, '过期审批绝不能执行');
    const expired = await approvalRow(task.id);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.consumed_at, null);
    const events = await getEvents(tenantId, task.id);
    assert.ok(events.some(e => e.type === 'approval.decided' && e.payload.decision === 'expired'));
    assert.ok(events.some(e => e.type === 'tool.failed' && e.payload.error_code === 'approval_expired'));
  });

  await t.test('拒绝审批：任务取消、调用失败且绝不执行', async () => {
    const task = await createTask();
    const claimed = await claimNextTask({ workerId: 'w-deny', leaseTtlMs: 5000 });
    assert.equal(claimed.id, task.id);
    const model = await startFakeModel(() => callTool(name));
    t.after(() => model.close());

    const paused = await executeTask(claimed, { workerId: 'w-deny', model, toolFactory });
    assert.equal(paused.status, 'waiting_approval');
    const approval = await approvalRow(task.id);
    const denied = await service.decideApproval({
      tenantId, approvalId: approval.id, userId: ownerId, decision: 'deny', argsHash: approval.args_hash,
    });
    assert.equal(denied.status, 'cancelled');

    const [call] = await toolCallRow(task.id);
    assert.equal(call.status, 'failed');
    assert.equal(call.error_code, 'approval_denied');
    assert.equal((await getPool().query(
      'SELECT COUNT(*)::int AS n FROM agent_tool_attempts WHERE tenant_id = $1 AND tool_call_id = $2',
      [tenantId, call.id],
    )).rows[0].n, 0);
    const types = (await getEvents(tenantId, task.id)).map(e => e.type);
    assert.equal(types.includes('tool.started'), false);
    assert.equal(types.includes('tool.completed'), false);
  });
});
