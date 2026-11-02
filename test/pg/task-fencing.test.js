// 领取级 fencing：回收前到期、回收后旧领取、Step 归属与原子完成。
// 与 task-runtime.test.js 分文件，避免共享进程内 schema 重置互相影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureSchema, createTenant, canUseTestDatabase, getTaskRow, getEvents, closeTestDb,
} from '../helpers/pg.js';
import {
  claimNextTask, renewLease, releaseTask, startStep, finishStep, appendMessage, saveCheckpoint, completeTask,
  createToolCall, startToolAttempt, finishToolAttempt, finishToolCall,
} from '../../server/control/task-repo.js';
import { insertEvidenceSnapshots } from '../../server/control/evidence-repo.js';
import { TaskService } from '../../server/control/task-service.js';
import { getPool } from '../../server/control/pg.js';

const skip = !canUseTestDatabase();
const leaseLost = e => e.code === 'lease_lost';

async function cleanTasks(){
  await getPool().query(
    `UPDATE agent_tasks
        SET status = 'cancelled', cancelled_by = 'test_cleanup',
            lease_owner = NULL, lease_expires_at = NULL, version = version + 1
      WHERE status NOT IN ('completed', 'failed', 'cancelled')`,
  );
}

async function createTask(service, tenantId, goal = 'fencing 测试'){
  return service.createTask({ tenantId, ownerId: 'owner-1', goal });
}

async function expire(taskId){
  await getPool().query(
    `UPDATE agent_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [taskId],
  );
}

function evidenceItem(chunkId, text){
  return {
    kb_id: 'kb-a', document_id: 'd-a', document_version: 1, chunk_id: chunkId,
    content_hash: String(chunkId).padEnd(64, '0').slice(0, 64),
    locator_json: { chunk_index: 0 }, excerpt: text, score: 0.5,
    title: 'A.txt', kb_name: 'KB A',
  };
}

test('P0-4 领取级 fencing 与原子完成', { skip }, async t => {
  await ensureSchema();
  const service = new TaskService();
  const tenantId = await createTenant('p04-fencing');
  t.after(async () => { await closeTestDb(); });

  await t.test('回收前到期：旧所有者不能续租、追加执行记录或完成', async () => {
    await cleanTasks();
    await createTask(service, tenantId);
    const task = await claimNextTask({ workerId: 'w-exp', leaseTtlMs: 5000 });
    assert.ok(task);
    const { task: startedTask, step } = await startStep({
      tenantId, taskId: task.id, workerId: 'w-exp', leaseEpoch: task.lease_epoch,
      expectVersion: task.version,
    });
    await expire(task.id);
    await assert.rejects(() => renewLease({
      tenantId, taskId: task.id, workerId: 'w-exp', leaseEpoch: task.lease_epoch, leaseTtlMs: 5000,
    }), leaseLost);
    await assert.rejects(() => appendMessage({
      tenantId, taskId: task.id, role: 'assistant', content: '迟到输出',
      actorId: 'w-exp', leaseEpoch: task.lease_epoch,
    }), leaseLost);
    await assert.rejects(() => saveCheckpoint({
      tenantId, taskId: task.id, stepSeq: Number(step.seq), state: { late: true },
      leaseEpoch: task.lease_epoch,
    }), leaseLost);
    await assert.rejects(() => startStep({
      tenantId, taskId: task.id, workerId: 'w-exp', leaseEpoch: task.lease_epoch,
      expectVersion: startedTask.version,
    }), leaseLost);
    await assert.rejects(() => releaseTask({
      tenantId, taskId: task.id, workerId: 'w-exp', leaseEpoch: task.lease_epoch,
      expectVersion: startedTask.version,
    }), leaseLost);
    await assert.rejects(() => completeTask({
      tenantId, taskId: task.id, workerId: 'w-exp', leaseEpoch: task.lease_epoch,
      stepId: step.id, stepSeq: Number(step.seq), summary: '迟到完成',
    }), leaseLost);
  });

  await t.test('回收后同 Worker ID：旧领取的消息、检查点、Step 写入被拒绝', async () => {
    await cleanTasks();
    await createTask(service, tenantId);
    const stale = await claimNextTask({ workerId: 'w-reuse', leaseTtlMs: 5000 });
    await expire(stale.id);
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
  });

  await t.test('工具尝试与调用完成必须属于当前领取', async () => {
    await cleanTasks();
    await createTask(service, tenantId);
    const stale = await claimNextTask({ workerId: 'w-tool', leaseTtlMs: 5000 });
    const call = await createToolCall({
      tenantId, taskId: stale.id, toolName: 'crm.create',
      args: { name: 'x' }, argsHash: 'a'.repeat(64), sideEffect: 'write_business',
      idempotencyKey: 'tool-fence-1',
    });
    const attempt = await startToolAttempt({
      tenantId, toolCallId: call.id, attemptNo: 1,
      workerId: 'w-tool', leaseEpoch: stale.lease_epoch,
    });

    await expire(stale.id);
    await assert.rejects(() => finishToolAttempt({
      tenantId, attemptId: attempt.id, status: 'succeeded',
      workerId: 'w-tool', leaseEpoch: stale.lease_epoch,
    }), leaseLost);
    await assert.rejects(() => finishToolCall({
      tenantId, toolCallId: call.id, status: 'succeeded',
      workerId: 'w-tool', leaseEpoch: stale.lease_epoch, attemptId: attempt.id,
    }), leaseLost);

    // 回收后同 Worker ID 重新领取：新 epoch 也不能替旧尝试收尾。
    await service.reapExpired({ workerId: 'reaper' });
    const fresh = await claimNextTask({ workerId: 'w-tool', leaseTtlMs: 5000 });
    assert.equal(fresh.id, stale.id);
    await assert.rejects(() => finishToolAttempt({
      tenantId, attemptId: attempt.id, status: 'succeeded',
      workerId: 'w-tool', leaseEpoch: fresh.lease_epoch,
    }), leaseLost);
    await assert.rejects(() => finishToolCall({
      tenantId, toolCallId: call.id, status: 'succeeded',
      workerId: 'w-tool', leaseEpoch: fresh.lease_epoch, attemptId: attempt.id,
    }), leaseLost);

    const attemptRow = await getPool().query(
      'SELECT status FROM agent_tool_attempts WHERE tenant_id = $1 AND id = $2', [tenantId, attempt.id],
    );
    assert.notEqual(attemptRow.rows[0].status, 'succeeded', '迟到完成不得改写尝试状态');
    const callRow = await getPool().query(
      'SELECT status FROM agent_tool_calls WHERE tenant_id = $1 AND id = $2', [tenantId, call.id],
    );
    assert.notEqual(callRow.rows[0].status, 'succeeded', '迟到完成不得把调用标记为成功');
  });

  await t.test('Step 完成必须属于当前领取的任务', async () => {
    await cleanTasks();
    const taskA = await createTask(service, tenantId, '任务 A');
    const taskB = await createTask(service, tenantId, '任务 B');
    const claimA = await claimNextTask({ workerId: 'w-a', leaseTtlMs: 5000 });
    const claimB = await claimNextTask({ workerId: 'w-b', leaseTtlMs: 5000 });
    assert.equal(claimA.id, taskA.id);
    assert.equal(claimB.id, taskB.id);
    const { step } = await startStep({
      tenantId, taskId: taskA.id, workerId: 'w-a', leaseEpoch: claimA.lease_epoch,
      expectVersion: claimA.version,
    });

    await assert.rejects(() => finishStep({
      tenantId, taskId: taskB.id, stepId: step.id, workerId: 'w-b', leaseEpoch: claimB.lease_epoch,
    }), leaseLost);
    const stepRow = await getPool().query(
      'SELECT status FROM agent_steps WHERE tenant_id = $1 AND id = $2', [tenantId, step.id],
    );
    assert.equal(stepRow.rows[0].status, 'running', '其他任务的领取不能完成本任务 Step');
    const eventsOnB = await getPool().query(
      "SELECT 1 FROM agent_events WHERE tenant_id = $1 AND task_id = $2 AND type = 'step.completed'",
      [tenantId, taskB.id],
    );
    assert.equal(eventsOnB.rowCount, 0, '事件不得写到其他任务');
  });

  await t.test('完成事务：只接受当前领取证据，失败回滚，成功只接受一次', async () => {
    await cleanTasks();
    const created = await createTask(service, tenantId);
    const claimed = await claimNextTask({ workerId: 'w-done', leaseTtlMs: 5000 });
    const { step } = await startStep({
      tenantId, taskId: claimed.id, workerId: 'w-done', leaseEpoch: claimed.lease_epoch,
      expectVersion: claimed.version,
    });
    const stepSeq = Number(step.seq);
    const legacy = await insertEvidenceSnapshots({
      tenantId, taskId: claimed.id, items: [evidenceItem('c-legacy', '旧领取证据')],
    });
    const completion = {
      tenantId, taskId: claimed.id, workerId: 'w-done', leaseEpoch: claimed.lease_epoch,
      stepId: step.id, stepSeq, summary: '完成', citations: [legacy[0].row.id],
      checkpointState: { finished: true },
    };

    await assert.rejects(() => completeTask(completion), e => e.code === 'evidence_conflict');
    assert.equal((await getTaskRow(tenantId, created.id)).status, 'running', '证据失败必须回滚任务状态');
    const stepAfterFail = await getPool().query(
      'SELECT status FROM agent_steps WHERE tenant_id = $1 AND id = $2', [tenantId, step.id],
    );
    assert.equal(stepAfterFail.rows[0].status, 'running', '证据失败不得提前完成 Step');
    const checkpointAfterFail = await getPool().query(
      'SELECT COUNT(*)::int AS c FROM agent_checkpoints WHERE tenant_id = $1 AND task_id = $2',
      [tenantId, created.id],
    );
    assert.equal(checkpointAfterFail.rows[0].c, 0, '证据失败不得写入检查点');

    const bound = await insertEvidenceSnapshots({
      tenantId, taskId: claimed.id, leaseEpoch: claimed.lease_epoch,
      items: [evidenceItem('c-bound', '当前领取证据')],
    });
    const done = await completeTask({ ...completion, citations: [bound[0].row.id] });
    assert.equal(done.status, 'completed');
    const completed = (await getEvents(tenantId, created.id)).filter(e => e.type === 'task.completed');
    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0].payload.citations, [bound[0].row.id]);

    await assert.rejects(() => completeTask({ ...completion, citations: [bound[0].row.id] }), leaseLost);
    const after = (await getEvents(tenantId, created.id)).filter(e => e.type === 'task.completed');
    assert.equal(after.length, 1, '重复完成不能追加第二个完成事件');
    const checkpoint = await getPool().query(
      'SELECT state_json FROM agent_checkpoints WHERE tenant_id = $1 AND task_id = $2 AND step_seq = $3',
      [tenantId, created.id, stepSeq],
    );
    assert.equal(checkpoint.rowCount, 1);
    assert.equal(checkpoint.rows[0].state_json.finished, true);
  });
});
