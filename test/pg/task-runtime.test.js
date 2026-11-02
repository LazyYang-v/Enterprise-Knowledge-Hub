import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureSchema, createTenant, canUseTestDatabase, getTaskRow, getEvents, closeTestDb, waitFor,
} from '../helpers/pg.js';
import { startFakeModel, finish, plan, askUser } from '../helpers/fake-model.js';
import { TaskService } from '../../server/control/task-service.js';
import { TaskWorker } from '../../server/control/worker.js';
import { executeTask } from '../../server/control/task-executor.js';
import {
  claimNextTask, releaseTask, getTask, transitionTaskTx, renewLease,
  createToolCall, startToolAttempt, startStep, appendMessage, saveCheckpoint, completeTask,
} from '../../server/control/task-repo.js';
import { insertEvidenceSnapshots } from '../../server/control/evidence-repo.js';
import { getPool } from '../../server/control/pg.js';

const skip = !canUseTestDatabase();
const leaseLost = e => e.code === 'lease_lost';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function workerFor(model, options = {}){
  return new TaskWorker({
    workerId: 'test-worker',
    model,
    service: new TaskService(),
    log: () => {},
    leaseTtlMs: 5000,
    heartbeatIntervalMs: 1000,
    reaperIntervalMs: 0,
    pollIntervalMs: 10,
    retryBaseMs: 10,
    maxRetryDelayMs: 20,
    ...options,
  });
}

async function cleanTasks(){
  // 事件表 append-only，不能级联删除任务；把未结束任务统一置为 cancelled 即可隔离队列。
  await getPool().query(
    `UPDATE agent_tasks
        SET status = 'cancelled', cancelled_by = 'test_cleanup',
            lease_owner = NULL, lease_expires_at = NULL, version = version + 1
      WHERE status NOT IN ('completed', 'failed', 'cancelled')`,
  );
}

async function createTask(service, tenantId, extra = {}){
  return service.createTask({ tenantId, ownerId: 'owner-1', goal: '完成测试任务', ...extra });
}

test('P0-2 任务持久化、租约、恢复与恢复对账', { skip }, async t => {
  await ensureSchema();
  const service = new TaskService();
  const tenantId = await createTenant('p02');
  t.after(async () => { await closeTestDb(); });

  await t.test('创建任务写入连续事件', async () => {
    await cleanTasks();
    const task = await createTask(service, tenantId);
    assert.equal(task.status, 'queued');
    assert.equal(task.event_seq, 2);
    const events = await getEvents(tenantId, task.id);
    assert.deepEqual(events.map(e => e.type), ['task.created', 'task.queued']);
    assert.deepEqual(events.map(e => Number(e.seq)), [1, 2]);
  });

  await t.test('R-04：并发领取只有一个 Worker 成功', async () => {
    await cleanTasks();
    await createTask(service, tenantId);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      claimNextTask({ workerId: `w${i}`, leaseTtlMs: 5000 })));
    const claimed = results.filter(Boolean);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].status, 'running');
    assert.equal(claimed[0].attempt_count, 1);
  });

  await t.test('fencing：非持有者续租与旧 version 写入被拒绝', async () => {
    await cleanTasks();
    const created = await createTask(service, tenantId);
    const task = await claimNextTask({ workerId: 'w1', leaseTtlMs: 5000 });
    assert.ok(task);
    await assert.rejects(() => renewLease({
      tenantId, taskId: task.id, workerId: 'w2', leaseEpoch: task.lease_epoch, leaseTtlMs: 5000,
    }), leaseLost);
    await assert.rejects(() => transitionTaskTx({
      tenantId, taskId: task.id, workerId: 'w1', leaseEpoch: task.lease_epoch,
      expectStatus: 'running', expectVersion: task.version - 1,
      to: 'failed', patch: { last_error_code: 'internal_error', lease_owner: null, lease_expires_at: null },
      eventType: 'task.failed', eventPayload: { error_code: 'internal_error' },
    }), leaseLost);
    await releaseTask({
      tenantId, taskId: task.id, workerId: 'w1', leaseEpoch: task.lease_epoch, expectVersion: task.version,
    });
    assert.equal((await getTask(tenantId, created.id)).status, 'queued');
  });

  await t.test('fencing：过期租约在回收前不能续租', async () => {
    await cleanTasks();
    await createTask(service, tenantId);
    const task = await claimNextTask({ workerId: 'w-exp', leaseTtlMs: 5000 });
    assert.ok(task);
    await getPool().query(
      `UPDATE agent_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [task.id],
    );
    await assert.rejects(() => renewLease({
      tenantId, taskId: task.id, workerId: 'w-exp', leaseEpoch: task.lease_epoch, leaseTtlMs: 5000,
    }), leaseLost);
  });

  await t.test('fencing：回收后同 Worker ID 的旧领取写入被拒绝', async () => {
    await cleanTasks();
    await createTask(service, tenantId);
    const stale = await claimNextTask({ workerId: 'w-reuse', leaseTtlMs: 5000 });
    await getPool().query(
      `UPDATE agent_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [stale.id],
    );
    await service.reapExpired({ workerId: 'reaper' });
    const fresh = await claimNextTask({ workerId: 'w-reuse', leaseTtlMs: 5000 });
    assert.equal(fresh.id, stale.id);
    assert.ok(fresh.lease_epoch > stale.lease_epoch, '重新领取必须递增 epoch');

    await assert.rejects(() => appendMessage({
      tenantId, taskId: stale.id, role: 'assistant', content: '迟到输出',
      actorId: 'w-reuse', leaseEpoch: stale.lease_epoch,
    }), leaseLost);
    await assert.rejects(() => saveCheckpoint({
      tenantId, taskId: stale.id, stepSeq: 0, state: { late: true }, leaseEpoch: stale.lease_epoch,
    }), leaseLost);
    await assert.rejects(() => startStep({
      tenantId, taskId: stale.id, workerId: 'w-reuse', leaseEpoch: stale.lease_epoch,
      expectVersion: fresh.version,
    }), leaseLost);

    await releaseTask({
      tenantId, taskId: stale.id, workerId: 'w-reuse', leaseEpoch: fresh.lease_epoch, expectVersion: fresh.version,
    });
  });

  await t.test('fencing：完成事务只接受当前领取的证据且只接受一次', async () => {
    await cleanTasks();
    const created = await createTask(service, tenantId);
    const claimed = await claimNextTask({ workerId: 'w-done', leaseTtlMs: 5000 });
    const { step } = await startStep({
      tenantId, taskId: claimed.id, workerId: 'w-done', leaseEpoch: claimed.lease_epoch,
      expectVersion: claimed.version,
    });
    const legacy = await insertEvidenceSnapshots({
      tenantId, taskId: claimed.id,
      items: [{ chunk_id: 'c-legacy', content_hash: 'a'.repeat(64), excerpt: '旧领取证据' }],
    });
    const completion = {
      tenantId, taskId: claimed.id, workerId: 'w-done', leaseEpoch: claimed.lease_epoch,
      stepId: step.id, stepSeq: Number(step.seq), summary: '完成',
      citations: [legacy[0].row.id],
      checkpointState: { finished: true },
    };
    await assert.rejects(() => completeTask(completion), e => e.code === 'evidence_conflict');
    assert.equal((await getTaskRow(tenantId, created.id)).status, 'running', '证据校验失败必须回滚');

    const bound = await insertEvidenceSnapshots({
      tenantId, taskId: claimed.id, leaseEpoch: claimed.lease_epoch,
      items: [{ chunk_id: 'c-bound', content_hash: 'b'.repeat(64), excerpt: '当前领取证据' }],
    });
    const done = await completeTask({ ...completion, citations: [bound[0].row.id] });
    assert.equal(done.status, 'completed');
    const completedEvents = (await getEvents(tenantId, created.id)).filter(e => e.type === 'task.completed');
    assert.equal(completedEvents.length, 1);
    await assert.rejects(() => completeTask({ ...completion, citations: [bound[0].row.id] }), leaseLost);
    const eventsAfter = (await getEvents(tenantId, created.id)).filter(e => e.type === 'task.completed');
    assert.equal(eventsAfter.length, 1, '重复完成不能追加第二个完成事件');
  });

  await t.test('plan → finish：任务完成且事件序号连续', async () => {
    await cleanTasks();
    let call = 0;
    const model = await startFakeModel(() => {
      call += 1;
      if (call === 1) return plan([
        { item_key: 'a', title: '收集资料', completion_criteria: '资料齐备' },
        { item_key: 'b', title: '输出结论', completion_criteria: '结论清晰', depends_on: ['a'] },
      ]);
      return finish('任务完成');
    });
    t.after(() => model.close());
    const worker = workerFor(model);
    const created = await createTask(service, tenantId);
    const result = await worker.runOnce();
    assert.equal(result.status, 'completed');
    const task = await getTaskRow(tenantId, created.id);
    assert.equal(task.status, 'completed');
    assert.equal(task.result_summary, '任务完成');
    assert.equal(Number(task.usage_json.steps), 2);
    const events = await getEvents(tenantId, created.id);
    const seqs = events.map(e => Number(e.seq));
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), '事件序号必须从 1 连续递增');
    const types = events.map(e => e.type);
    for (const type of ['task.started', 'plan.updated', 'step.completed', 'message.created', 'task.completed']){
      assert.ok(types.includes(type), `缺少事件 ${type}`);
    }
    const planRows = await getPool().query('SELECT * FROM agent_plan_items WHERE task_id = $1 ORDER BY item_key', [created.id]);
    assert.equal(planRows.rowCount, 2);
    const snapshot = await service.snapshot({ tenantId, taskId: created.id, userId: 'owner-1' });
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.plan.length, 2);
    assert.equal(snapshot.permissions.can_resume, false);
  });

  await t.test('ask_user → waiting_input → 输入后完成', async () => {
    await cleanTasks();
    let call = 0;
    const model = await startFakeModel(() => {
      call += 1;
      if (call === 1) return askUser('请输入预算', { budget: { type: 'number', required: true } });
      return finish('收到预算');
    });
    t.after(() => model.close());
    const worker = workerFor(model);
    const created = await createTask(service, tenantId);
    const first = await worker.runOnce();
    assert.equal(first.status, 'waiting_input');
    assert.equal((await getTaskRow(tenantId, created.id)).status, 'waiting_input');

    await assert.rejects(() => service.submitInput({
      tenantId, taskId: created.id, userId: 'owner-1', values: { budget: '100' },
    }), /必须是数字/);
    await service.submitInput({
      tenantId, taskId: created.id, userId: 'owner-1', values: { budget: 100 },
    });
    assert.equal((await getTaskRow(tenantId, created.id)).status, 'queued');
    const second = await worker.runOnce();
    assert.equal(second.status, 'completed');
    const types = (await getEvents(tenantId, created.id)).map(e => e.type);
    assert.ok(types.includes('input.requested'));
    assert.ok(types.includes('input.received'));
  });

  await t.test('F-08：可重试错误进入 retry_wait，退避后恢复完成', async () => {
    await cleanTasks();
    let call = 0;
    const model = await startFakeModel(() => {
      call += 1;
      if (call === 1) return { status: 429, body: 'rate limited' };
      return finish('重试成功');
    });
    t.after(() => model.close());
    const worker = workerFor(model);
    const created = await createTask(service, tenantId);
    const first = await worker.runOnce();
    assert.equal(first.status, 'failed_or_retried');
    let row = await getTaskRow(tenantId, created.id);
    assert.equal(row.status, 'retry_wait');
    assert.equal(row.last_error_code, 'model_rate_limited');

    await sleep(30);
    const stats = await service.reapExpired({ workerId: 'reaper' });
    assert.ok(stats.requeued_retry >= 1);
    row = await getTaskRow(tenantId, created.id);
    assert.equal(row.status, 'queued');
    const second = await worker.runOnce();
    assert.equal(second.status, 'completed');
    assert.equal((await getEvents(tenantId, created.id)).some(e => e.type === 'task.retry_scheduled'), true);
  });

  await t.test('F-07：取消 queued 与 running 任务', async () => {
    await cleanTasks();
    const queued = await createTask(service, tenantId);
    await service.cancelTask({ tenantId, taskId: queued.id, userId: 'owner-1' });
    assert.equal((await getTaskRow(tenantId, queued.id)).status, 'cancelled');

    const running = await createTask(service, tenantId);
    const claimed = await claimNextTask({ workerId: 'w-cancel', leaseTtlMs: 5000 });
    await service.cancelTask({ tenantId, taskId: running.id, userId: 'owner-1' });
    assert.equal((await getTaskRow(tenantId, running.id)).status, 'cancel_requested');
    // Worker 在安全点确认取消，不再调用模型。
    const model = await startFakeModel(() => finish('不应被调用'));
    t.after(() => model.close());
    const result = await executeTask(claimed, { workerId: 'w-cancel', model });
    assert.equal(result.status, 'cancelled');
    assert.equal(model.calls, 0);
    assert.equal((await getTaskRow(tenantId, running.id)).status, 'cancelled');
  });

  await t.test('R-01：租约过期恢复后不重复已完成 Step', async () => {
    await cleanTasks();
    const created = await createTask(service, tenantId);
    const claimed = await claimNextTask({ workerId: 'dead', leaseTtlMs: 5000 });
    assert.ok(claimed);
    // 模拟 Worker 在 Step 开始时被杀
    const { startStep } = await import('../../server/control/task-repo.js');
    const started = await startStep({
      tenantId, taskId: created.id, workerId: 'dead', leaseEpoch: claimed.lease_epoch,
      expectVersion: claimed.version,
    });
    await getPool().query(
      `UPDATE agent_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [created.id],
    );
    const stats = await service.reapExpired({ workerId: 'reaper' });
    assert.ok(stats.recovered >= 1);
    let row = await getTaskRow(tenantId, created.id);
    assert.equal(row.status, 'queued');
    assert.equal(row.recovery_count, 1);
    assert.equal(row.lease_owner, null);
    const stepRows = await getPool().query('SELECT status FROM agent_steps WHERE task_id = $1', [created.id]);
    assert.equal(stepRows.rows[0].status, 'failed');

    const model = await startFakeModel(() => finish('恢复完成'));
    t.after(() => model.close());
    const worker = workerFor(model);
    const result = await worker.runOnce();
    assert.equal(result.status, 'completed');
    row = await getTaskRow(tenantId, created.id);
    assert.equal(row.status, 'completed');
    const completed = await getPool().query(
      `SELECT COUNT(*)::int AS c FROM agent_steps WHERE task_id = $1 AND status = 'completed'`, [created.id],
    );
    assert.equal(completed.rows[0].c, 1, '已完成 Step 不应被重复执行');
    const seqs = (await getEvents(tenantId, created.id)).map(e => Number(e.seq));
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
    void started;
  });

  await t.test('R-02/R-03：未知外部写恢复为 waiting_approval 并要求对账', async () => {
    await cleanTasks();
    const created = await createTask(service, tenantId);
    const claimed = await claimNextTask({ workerId: 'dead-write', leaseTtlMs: 5000 });
    const call = await createToolCall({
      tenantId, taskId: created.id, toolName: 'crm.create', args: { name: 'x' },
      argsHash: 'a'.repeat(64), sideEffect: 'write_business', idempotencyKey: null, status: 'running',
    });
    await startToolAttempt({ tenantId, toolCallId: call.id, attemptNo: 1, workerId: 'dead-write', leaseEpoch: claimed.lease_epoch });
    await getPool().query(
      `UPDATE agent_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [created.id],
    );
    await service.reapExpired({ workerId: 'reaper' });
    const row = await getTaskRow(tenantId, created.id);
    assert.equal(row.status, 'waiting_approval');
    assert.equal(row.recovery_count, 1);
    const approval = await getPool().query(
      `SELECT * FROM agent_approvals WHERE task_id = $1 AND kind = 'reconciliation'`, [created.id],
    );
    assert.equal(approval.rowCount, 1);
    assert.equal(approval.rows[0].status, 'pending');

    const resumed = await service.decideApproval({
      tenantId, approvalId: approval.rows[0].id, userId: 'owner-1',
      decision: 'approve', argsHash: approval.rows[0].args_hash,
    });
    assert.equal(resumed.status, 'queued');
    const model = await startFakeModel(() => finish('对账后完成'));
    t.after(() => model.close());
    const result = await workerFor(model).runOnce();
    assert.equal(result.status, 'completed');
  });

  await t.test('预算耗尽：failed + budget_exhausted，保留已有计划', async () => {
    await cleanTasks();
    const model = await startFakeModel(() => plan([
      { item_key: 'a', title: '步骤一', completion_criteria: '完成' },
    ]));
    t.after(() => model.close());
    const worker = workerFor(model);
    const created = await createTask(service, tenantId, { budget: { max_steps: 1 } });
    const result = await worker.runOnce();
    assert.equal(result.status, 'failed_or_retried');
    const row = await getTaskRow(tenantId, created.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.last_error_code, 'budget_exhausted');
    const plans = await getPool().query('SELECT COUNT(*)::int AS c FROM agent_plan_items WHERE task_id = $1', [created.id]);
    assert.equal(plans.rows[0].c, 1);
  });
});
