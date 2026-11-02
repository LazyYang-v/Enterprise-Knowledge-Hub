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
import { createCustomTool, updateCustomTool, getCustomToolVersion } from '../../server/tools/custom-tools-repo.js';
import { upsertToolPolicy } from '../../server/control/tool-registry-repo.js';
import { customToolName } from '../../server/tools/contract.js';

const skip = !canUseTestDatabase();
const OWNER = 'policy-owner';
const callTool = (name, args = {}) => JSON.stringify({ type: 'call_tool', tool_name: name, arguments: args });

const TOOL_CODE = `
export default {
  name: '策略工具',
  description: '测试用',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute() { return 'ok'; },
};
`;

function toolFactory({ task, knowledge, signal }){
  return createToolExecutor({ task, knowledge, signal });
}

test('S-07：默认拒绝、策略/预算、工具漂移与归属', { skip }, async t => {
  await ensureSchema();
  const tenantId = await createTenant('p04-policy');
  const service = new TaskService({ resolveTools });
  t.after(async () => { await closeTestDb(); });

  await t.test('未知工具、他人工具、停用工具在创建期拒绝', async () => {
    await assert.rejects(() => service.createTask({
      tenantId, ownerId: OWNER, goal: '未知', input: { tools: ['no.such.tool'] },
    }), e => e.code === 'validation_error');

    const privateTool = createCustomTool({
      ownerId: 'someone-else', name: '私有', description: 'x',
      parameters: { type: 'object', properties: {} }, code: TOOL_CODE,
    });
    await assert.rejects(() => service.createTask({
      tenantId, ownerId: OWNER, goal: '越权', input: { tools: [`custom:${privateTool.id}`] },
    }), e => e.code === 'forbidden');

    updateCustomTool(privateTool.id, { enabled: false }, { ownerId: 'someone-else' });
    await assert.rejects(() => service.createTask({
      tenantId, ownerId: 'someone-else', goal: '停用',
      input: { tools: [`custom:${privateTool.id}`] },
    }), e => e.code === 'validation_error');
  });

  await t.test('policy.enabled=false：拒绝执行但任务可继续完成', async () => {
    await upsertToolPolicy({
      tenantId, toolName: 'knowledge.search', principalType: 'user',
      principalId: OWNER, enabled: false,
    });
    const task = await service.createTask({ tenantId, ownerId: OWNER, goal: '被策略拒绝' });
    const claimed = await claimNextTask({ workerId: 'w-policy', leaseTtlMs: 5000 });
    assert.equal(claimed.id, task.id);
    const model = await startFakeModel(({ call }) => (
      call === 1 ? callTool('knowledge.search', { query: 'x' }) : finish('已绕过工具完成')
    ));
    t.after(() => model.close());

    const result = await executeTask(claimed, { workerId: 'w-policy', model, toolFactory });
    assert.equal(result.status, 'completed');
    const calls = (await getPool().query(
      'SELECT * FROM agent_tool_calls WHERE tenant_id = $1 AND task_id = $2', [tenantId, task.id],
    )).rows;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 'failed');
    assert.equal(calls[0].error_code, 'policy_denied');
    const types = (await getEvents(tenantId, task.id)).map(e => e.type);
    assert.ok(types.includes('policy.denied'));
    assert.ok(types.includes('tool.failed'));
    assert.equal(types.includes('tool.started'), false);
  });

  await t.test('预算耗尽：fatal 拒绝并 failed/budget_exhausted', async () => {
    await getPool().query('DELETE FROM tool_policies WHERE tenant_id = $1', [tenantId]);
    const task = await service.createTask({
      tenantId, ownerId: OWNER, goal: '预算',
      budget: { max_tool_calls: 1 },
    });
    await getPool().query(
      `UPDATE agent_tasks SET usage_json = '{"tool_calls":1}'::jsonb WHERE tenant_id = $1 AND id = $2`,
      [tenantId, task.id],
    );
    const claimed = await claimNextTask({ workerId: 'w-budget', leaseTtlMs: 5000 });
    assert.equal(claimed.id, task.id);
    const model = await startFakeModel(() => callTool('knowledge.search', { query: 'x' }));
    t.after(() => model.close());
    const result = await executeTask(claimed, { workerId: 'w-budget', model, toolFactory });
    assert.equal(result.status, 'failed');
    const row = await getPool().query(
      'SELECT status, last_error_code FROM agent_tasks WHERE tenant_id = $1 AND id = $2', [tenantId, task.id],
    );
    assert.equal(row.rows[0].status, 'failed');
    assert.equal(row.rows[0].last_error_code, 'budget_exhausted');
    const types = (await getEvents(tenantId, task.id)).map(e => e.type);
    assert.ok(types.includes('task.failed'));
  });

  await t.test('自定义工具版本不可变；快照哈希不匹配拒绝执行', async () => {
    const tool = createCustomTool({
      ownerId: OWNER, name: '可变工具', description: 'v1',
      parameters: { type: 'object', properties: {} }, code: TOOL_CODE,
    });
    const name = customToolName(tool.id);
    const task = await service.createTask({
      tenantId, ownerId: OWNER, goal: '漂移', input: { tools: [`custom:${tool.id}`] },
    });
    assert.equal(task.input_json.tools[0].version, '1.1.0');
    const claimed = await claimNextTask({ workerId: 'w-drift', leaseTtlMs: 5000 });
    assert.equal(claimed.id, task.id);

    const updated = updateCustomTool(tool.id, {
      code: TOOL_CODE.replace("return 'ok'", "return 'v2'"),
    }, { ownerId: OWNER });
    assert.equal(updated.tool.current_version, 2);
    // 旧版本代码与哈希保持不变，运行中任务继续使用固定版本。
    const v1 = getCustomToolVersion(tool.id, 1);
    assert.equal(v1.code, TOOL_CODE);
    assert.equal(v1.code_hash, tool.code_hash);

    // 模拟快照被篡改/代码漂移：执行阶段必须拒绝。
    const badHash = '0'.repeat(64);
    await getPool().query(
      `UPDATE agent_tasks
          SET input_json = jsonb_set(input_json, '{tools,0,code_hash}', to_jsonb($3::text))
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, task.id, badHash],
    );

    const model = await startFakeModel(({ call }) => (
      call === 1 ? callTool(name) : finish('工具失败后完成')
    ));
    t.after(() => model.close());
    const result = await executeTask(claimed, { workerId: 'w-drift', model, toolFactory });
    assert.equal(result.status, 'completed');
    const call = (await getPool().query(
      'SELECT * FROM agent_tool_calls WHERE tenant_id = $1 AND task_id = $2', [tenantId, task.id],
    )).rows[0];
    assert.equal(call.status, 'failed');
    assert.equal(call.error_code, 'tool_code_changed');
    assert.equal(call.tool_version, '1.1.0');
    assert.equal(call.code_hash, badHash);
  });
});
