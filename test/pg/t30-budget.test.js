// T30：预算耗尽时先落部分成果报告，再以 failed/budget_exhausted 结束。
import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureSchema, createTenant, canUseTestDatabase, getPool, closeTestDb,
} from '../helpers/pg.js';
import { startFakeModel, plan, finish } from '../helpers/fake-model.js';
import { TaskService } from '../../server/control/task-service.js';
import { TaskWorker } from '../../server/control/worker.js';
import { getArtifactService } from '../../server/artifacts/service.js';

const skip = !canUseTestDatabase();

async function runTask({ tenantId, ownerId, model, budget, goal }){
  const service = new TaskService();
  const task = await service.createTask({ tenantId, ownerId, goal, budget });
  const worker = new TaskWorker({ workerId: `t30-${task.id.slice(0, 8)}`, model });
  const result = await worker.runOnce();
  const row = (await getPool().query(
    'SELECT * FROM agent_tasks WHERE tenant_id = $1 AND id = $2', [tenantId, task.id],
  )).rows[0];
  return { task, result, row };
}

async function readReport(tenantId, taskId){
  const artifacts = getArtifactService();
  const list = await artifacts.list({ tenantId, taskId, limit: 200 });
  const meta = list.find(a => a.name === 'budget-report.json');
  assert.ok(meta, '缺少 budget-report.json');
  const { buffer } = await artifacts.getForRead({ tenantId, taskId, artifactId: meta.id });
  return JSON.parse(buffer.toString('utf8'));
}

test('T30：max_model_calls 耗尽写入部分成果报告并标记预算键', { skip, timeout: 60000 }, async t => {
  await ensureSchema();
  const tenantId = await createTenant('t30-model-calls');
  t.after(() => closeTestDb());

  const model = await startFakeModel(() => ({
    content: plan([{ item_key: 'k1', title: '收集材料', completion_criteria: '材料齐全' },
      { item_key: 'k2', title: '撰写报告', completion_criteria: '报告完成' }]),
    usage: { prompt_tokens: 30, completion_tokens: 20 },
  }));
  t.after(() => model.close());

  const { task, result, row } = await runTask({
    tenantId, ownerId: 'owner-t30-a', model,
    goal: '预算耗尽测试', budget: { max_model_calls: 1 },
  });
  assert.equal(result.status, 'failed_or_retried');
  assert.equal(row.status, 'failed');
  assert.equal(row.last_error_code, 'budget_exhausted');
  assert.equal(row.usage_json.model_calls, 1);
  assert.equal(row.usage_json.input_tokens, 30);
  assert.equal(row.usage_json.output_tokens, 20);
  assert.equal(row.usage_json.token_estimated, false);

  const report = await readReport(tenantId, task.id);
  assert.equal(report.reason_key, 'max_model_calls');
  assert.equal(report.usage.model_calls, 1);
  assert.equal(report.usage.total_tokens, 50);
  assert.equal(report.plan.total_count, 2);
  assert.equal(report.plan.completed_count, 0);
  assert.deepEqual(report.plan.items.map(i => i.completed), [false, false]);

  const events = (await getPool().query(
    'SELECT type, payload FROM agent_events WHERE tenant_id = $1 AND task_id = $2 ORDER BY seq',
    [tenantId, task.id],
  )).rows;
  assert.ok(events.some(e => e.type === 'budget.exhausted'
    && e.payload?.reason_key === 'max_model_calls'));
  const failed = events.find(e => e.type === 'task.failed');
  assert.equal(failed.payload.budget_key, 'max_model_calls');
  assert.ok(Array.isArray(failed.payload.artifact_ids));
  assert.equal(failed.payload.artifact_ids.length, 1);
});

test('T30：max_tokens 在模型返回后立即触发，token 写入 step', { skip, timeout: 60000 }, async t => {
  await ensureSchema();
  const tenantId = await createTenant('t30-tokens');
  t.after(() => closeTestDb());

  const model = await startFakeModel(() => ({
    content: finish('不应完成'),
    usage: { prompt_tokens: 8, completion_tokens: 5 },
  }));
  t.after(() => model.close());

  const { task, row } = await runTask({
    tenantId, ownerId: 'owner-t30-b', model,
    goal: 'token 预算测试', budget: { max_tokens: 10 },
  });
  assert.equal(row.status, 'failed');
  assert.equal(row.last_error_code, 'budget_exhausted');
  assert.equal(row.usage_json.input_tokens, 8);
  assert.equal(row.usage_json.output_tokens, 5);

  const step = (await getPool().query(
    'SELECT status, input_tokens, output_tokens FROM agent_steps WHERE tenant_id = $1 AND task_id = $2 ORDER BY seq DESC LIMIT 1',
    [tenantId, task.id],
  )).rows[0];
  assert.equal(step.status, 'failed');
  assert.equal(step.input_tokens, 8);
  assert.equal(step.output_tokens, 5);

  const report = await readReport(tenantId, task.id);
  assert.equal(report.reason_key, 'max_tokens');
  assert.equal(report.usage.total_tokens, 13);
});

test('provider 不返回 usage 时按字符估算并标记', { skip, timeout: 60000 }, async t => {
  await ensureSchema();
  const tenantId = await createTenant('t30-estimate');
  t.after(() => closeTestDb());

  const model = await startFakeModel(() => plan([{ item_key: 'k1', title: '唯一事项', completion_criteria: '完成' }]));
  t.after(() => model.close());

  const { row } = await runTask({
    tenantId, ownerId: 'owner-t30-c', model,
    goal: '估算 token 测试', budget: { max_model_calls: 1 },
  });
  assert.equal(row.status, 'failed');
  assert.equal(row.usage_json.token_estimated, true);
  assert.ok(row.usage_json.input_tokens > 0, '估算输入 token 不应为 0');
  assert.ok(row.usage_json.output_tokens > 0, '估算输出 token 不应为 0');
});
