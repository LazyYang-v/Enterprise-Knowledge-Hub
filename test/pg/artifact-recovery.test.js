import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureSchema, createTenant, canUseTestDatabase, getTaskRow, getEvents, closeTestDb,
} from '../helpers/pg.js';
import { startFakeModel, finish } from '../helpers/fake-model.js';
import { getPool } from '../../server/control/pg.js';
import { TaskService } from '../../server/control/task-service.js';
import { TaskWorker } from '../../server/control/worker.js';
import {
  claimNextTask, startStep, createToolCall, startToolAttempt,
} from '../../server/control/task-repo.js';
import { resolveTools } from '../../server/tools/registry.js';
import { createToolExecutor } from '../../server/tools/executor.js';
import { hashArgs } from '../../server/tools/contract.js';
import { getArtifactService } from '../../server/artifacts/service.js';
import { listArtifacts } from '../../server/control/artifact-repo.js';

const skip = !canUseTestDatabase();
const callTool = (name, args) => JSON.stringify({ type: 'call_tool', tool_name: name, arguments: args });

test('P0-5 恢复语义：带幂等键的成果写崩溃后重领，不进入人工对账', { skip }, async t => {
  await ensureSchema();
  const tenantId = await createTenant('p05-recovery');
  const ownerId = 'recovery-owner';
  const service = new TaskService({ resolveTools });
  t.after(async () => { await closeTestDb(); });

  const task = await service.createTask({
    tenantId, ownerId, goal: '写入成果后 Worker 崩溃',
    input: { tools: ['document.write'] },
  });
  const claimed = await claimNextTask({ workerId: 'dead-w', leaseTtlMs: 5000 });
  assert.equal(claimed.id, task.id);

  const { step } = await startStep({
    tenantId, taskId: task.id, workerId: 'dead-w',
    leaseEpoch: claimed.lease_epoch, expectVersion: claimed.version,
  });
  const args = { name: '结果.md', content: '同一份内容' };
  const argsHash = hashArgs(args);
  const call = await createToolCall({
    tenantId, taskId: task.id, stepId: step.id,
    toolName: 'document.write', toolVersion: '1.0.0', source: 'builtin',
    args, argsHash, sideEffect: 'write_workspace', status: 'running',
    idempotencyKey: `document.write:${argsHash}:${step.id}:0`,
  });
  await startToolAttempt({
    tenantId, toolCallId: call.id, attemptNo: 1,
    workerId: 'dead-w', leaseEpoch: claimed.lease_epoch,
  });
  const written = await getArtifactService().ingest({
    tenantId, taskId: task.id, stepId: step.id, toolCallId: call.id,
    workerId: 'dead-w', leaseEpoch: claimed.lease_epoch,
    name: '结果.md', buffer: Buffer.from('同一份内容'), mime: 'text/markdown',
    createdBy: `tool:${call.id}`,
  });
  assert.equal(written.version, 1);

  // Worker 在写入后、上报前死亡。
  await getPool().query(
    `UPDATE agent_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [task.id],
  );
  const stats = await service.reapExpired({ workerId: 'reaper' });
  assert.ok(stats.recovered >= 1);

  let row = await getTaskRow(tenantId, task.id);
  assert.equal(row.status, 'queued', '带幂等键的写应直接重领');
  assert.equal(row.recovery_count, 1);
  const approvals = await getPool().query(
    `SELECT COUNT(*)::int AS n FROM agent_approvals WHERE tenant_id = $1 AND task_id = $2 AND kind = 'reconciliation'`,
    [tenantId, task.id],
  );
  assert.equal(approvals.rows[0].n, 0, '不得进入人工对账');
  const recoveredCall = await getPool().query('SELECT status, error_code FROM agent_tool_calls WHERE id = $1', [call.id]);
  assert.equal(recoveredCall.rows[0].status, 'failed');
  assert.equal(recoveredCall.rows[0].error_code, 'worker_lost');
  const recoveredEvent = (await getEvents(tenantId, task.id)).find(e => e.type === 'task.recovered');
  assert.equal(recoveredEvent.payload.resolution, 'requeued');

  // 重领后模型重写同一文件：内容寻址去重，不产生新版本。
  const model = await startFakeModel(({ body, call: n }) => {
    if (n === 1) return callTool('document.write', args);
    const text = [...body.messages].reverse().map(m => String(m.content || ''))
      .find(x => x.includes(JSON.stringify('结果.md')));
    assert.ok(text, '应能在工具结果或成果目录中找到 artifact_id');
    const id = [...text.matchAll(/"artifact_id"\s*:\s*"([0-9a-f-]{36})"/gi)].at(-1)?.[1]
      || [...text.matchAll(/- ([0-9a-f-]{36}) \[output/g)].at(-1)?.[1];
    assert.ok(id);
    return JSON.stringify({ type: 'finish', summary: '恢复后完成', artifact_refs: [id], citations: [] });
  });
  t.after(() => model.close());

  const worker = new TaskWorker({
    workerId: 'w-recover', model,
    service: new TaskService({ resolveTools }),
    toolFactory: ({ task: current, knowledge, signal }) => createToolExecutor({
      task: current, knowledge, signal, artifacts: getArtifactService(), workerId: 'w-recover',
    }),
    log: () => {},
    leaseTtlMs: 5000, heartbeatIntervalMs: 1000, reaperIntervalMs: 0, pollIntervalMs: 10,
    retryBaseMs: 10, maxRetryDelayMs: 20,
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'completed');

  row = await getTaskRow(tenantId, task.id);
  assert.equal(row.status, 'completed');
  const artifacts = await listArtifacts({ tenantId, taskId: task.id });
  assert.equal(artifacts.length, 1, '同名同内容重试不得新增成果');
  assert.equal(artifacts[0].version, 1);
  assert.equal(artifacts[0].id, written.id, '重试应复用同一 artifact');

  const calls = await getPool().query(
    'SELECT status, idempotency_key FROM agent_tool_calls WHERE tenant_id = $1 AND task_id = $2 ORDER BY created_at',
    [tenantId, task.id],
  );
  assert.equal(calls.rowCount, 2);
  assert.equal(calls.rows[0].status, 'failed');
  assert.equal(calls.rows[1].status, 'succeeded');
  assert.ok(calls.rows[1].idempotency_key, '重试写同样带幂等键');

  const completed = (await getEvents(tenantId, task.id)).find(e => e.type === 'task.completed');
  assert.deepEqual(completed.payload.artifact_ids, [written.id]);
  void finish;
});
