// R-01 / P0-2 门禁：20 次 kill -9 Worker 后，租约回收并完成任务，且不重复已完成 Step。
process.env.AGENT_PLATFORM_ENABLED = '1';

import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { ensureSchema, canUseTestDatabase, createTenant, getPool, closeTestDb, waitFor } = await import('../helpers/pg.js');
const { startFakeModel } = await import('../helpers/fake-model.js');
const { TaskService } = await import('../../server/control/task-service.js');
const { workerNodeId } = await import('../../server/control/task-repo.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ITERATIONS = Number(process.env.EKH_KILL_ITERATIONS || 20);
const skip = !canUseTestDatabase();

function spawnWorker(env, tag, args = ['--once']){
  const child = spawn(process.execPath, ['scripts/worker.js', ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env, AGENT_PLATFORM_ENABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const output = [];
  child.stdout.on('data', d => output.push(String(d)));
  child.stderr.on('data', d => output.push(String(d)));
  child.tag = tag;
  child.output = output;
  child.exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  return child;
}

async function taskRow(tenantId, taskId){
  const r = await getPool().query(
    'SELECT status, lease_expires_at < now() AS lease_expired, recovery_count, last_error_code FROM agent_tasks WHERE tenant_id = $1 AND id = $2',
    [tenantId, taskId],
  );
  return r.rows[0] || null;
}

test(`R-01：${ITERATIONS} 次 kill -9 Worker 后可恢复并完成`, { skip, timeout: 240000 }, async t => {
  await ensureSchema();
  const tenantId = await createTenant('kill-recovery');
  const service = new TaskService();
  const children = new Set();
  t.after(async () => {
    for (const child of children){
      if (child.exitCode == null && child.signalCode == null){
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    }
    await closeTestDb();
  });

  const slowModel = await startFakeModel(({ body }) => {
    if (body.model === 'slow-model') return { hang: true };
    return { delayMs: 20, content: JSON.stringify({ type: 'finish', summary: 'kill 恢复完成' }) };
  });
  t.after(() => slowModel.close());

  const baseEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    EKH_AGENT_MODEL_BASE_URL: slowModel.base_url,
    EKH_WORKER_LEASE_TTL_MS: '700',
    EKH_WORKER_HEARTBEAT_MS: '100',
    EKH_WORKER_REAPER_MS: '50',
    EKH_WORKER_POLL_MS: '20',
    EKH_TASK_RETRY_BASE_MS: '20',
  };

  for (let i = 1; i <= ITERATIONS; i++){
    const created = await service.createTask({
      tenantId, ownerId: 'owner-kill', goal: `kill 恢复第 ${i} 次`,
    });

    const slow = spawnWorker({ ...baseEnv, EKH_AGENT_MODEL_NAME: 'slow-model', EKH_WORKER_ID: `slow-${i}` }, 'slow');
    children.add(slow);
    await waitFor(async () => (await taskRow(tenantId, created.id))?.status === 'running', { timeout: 10000, interval: 25 });
    try { process.kill(-slow.pid, 'SIGKILL'); } catch { slow.kill('SIGKILL'); }
    await slow.exited;
    children.delete(slow);

    // 等待租约过期，再由另一个进程回收（模拟 Reaper/其他 Worker）。
    await waitFor(async () => (await taskRow(tenantId, created.id))?.lease_expired === true, { timeout: 5000, interval: 25 });
    const stats = await service.reapExpired({ workerId: 'test-reaper' });
    assert.ok(stats.recovered >= 1, `第 ${i} 次应回收到任务`);
    let row = await taskRow(tenantId, created.id);
    assert.equal(row.status, 'queued');
    assert.equal(row.recovery_count, 1);

    const fast = spawnWorker({ ...baseEnv, EKH_AGENT_MODEL_NAME: 'fast-model', EKH_WORKER_ID: `fast-${i}` }, 'fast');
    children.add(fast);
    const exit = await Promise.race([
      fast.exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`第 ${i} 次恢复 Worker 超时\n${fast.output.join('')}`)), 15000)),
    ]);
    children.delete(fast);
    assert.equal(exit.code, 0, `第 ${i} 次 Worker 退出码非 0\n${fast.output.join('')}`);

    row = await taskRow(tenantId, created.id);
    if (row.status !== 'completed'){
      const detail = await getPool().query(
        `SELECT status, lease_owner, attempt_count, version, last_error_code, last_error_detail
           FROM agent_tasks WHERE tenant_id = $1 AND id = $2`, [tenantId, created.id],
      );
      const steps = await getPool().query(
        'SELECT seq, status, error_code FROM agent_steps WHERE tenant_id = $1 AND task_id = $2 ORDER BY seq',
        [tenantId, created.id],
      );
      assert.fail(`第 ${i} 次任务未完成：${JSON.stringify(detail.rows[0])} steps=${JSON.stringify(steps.rows)} worker=${fast.output.join('')}`);
    }
    assert.equal(row.recovery_count, 1);

    const steps = await getPool().query(
      'SELECT status, seq FROM agent_steps WHERE tenant_id = $1 AND task_id = $2 ORDER BY seq',
      [tenantId, created.id],
    );
    const completed = steps.rows.filter(s => s.status === 'completed');
    assert.equal(completed.length, 1, `第 ${i} 次已完成 Step 被重复执行`);
    const events = await getPool().query(
      'SELECT seq FROM agent_events WHERE tenant_id = $1 AND task_id = $2 ORDER BY seq',
      [tenantId, created.id],
    );
    const seqs = events.rows.map(r => Number(r.seq));
    assert.deepEqual(seqs, seqs.map((_, idx) => idx + 1), `第 ${i} 次事件序号有缺口`);
    assert.ok((await getPool().query(
      "SELECT 1 FROM agent_events WHERE task_id = $1 AND type = 'task.recovered'", [created.id],
    )).rowCount === 1);
    console.log(`kill 恢复 ${i}/${ITERATIONS} 通过`);
  }
});

test('优雅停机：SIGTERM 释放任务回队列', { skip, timeout: 30000 }, async t => {
  await ensureSchema();
  const tenantId = await createTenant('graceful-drain');
  const service = new TaskService();
  const children = new Set();
  t.after(async () => {
    for (const child of children){
      if (child.exitCode == null && child.signalCode == null){
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    }
    await closeTestDb();
  });

  const model = await startFakeModel(() => ({ hang: true }));
  t.after(() => model.close());

  const created = await service.createTask({ tenantId, ownerId: 'owner-drain', goal: '优雅停机任务' });
  const worker = spawnWorker({
    DATABASE_URL: process.env.DATABASE_URL,
    EKH_AGENT_MODEL_BASE_URL: model.base_url,
    EKH_AGENT_MODEL_NAME: 'slow-model',
    EKH_WORKER_LEASE_TTL_MS: '5000',
    EKH_WORKER_HEARTBEAT_MS: '200',
    EKH_WORKER_REAPER_MS: '1000',
    EKH_WORKER_POLL_MS: '20',
    EKH_WORKER_SHUTDOWN_GRACE_MS: '300',
    EKH_WORKER_ID: 'drain-worker',
  }, 'drain', []);
  children.add(worker);
  await waitFor(async () => (await taskRow(tenantId, created.id))?.status === 'running', { timeout: 10000, interval: 25 });

  worker.kill('SIGTERM');
  const exit = await Promise.race([
    worker.exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`停机超时\n${worker.output.join('')}`)), 15000)),
  ]);
  children.delete(worker);
  assert.equal(exit.code, 0, `停机退出码非 0\n${worker.output.join('')}`);

  const row = await taskRow(tenantId, created.id);
  assert.equal(row.status, 'queued', '停机后任务应回到队列');
  const events = await getPool().query(
    `SELECT type, payload FROM agent_events WHERE tenant_id = $1 AND task_id = $2 ORDER BY seq`,
    [tenantId, created.id],
  );
  assert.ok(events.rows.some(e => e.type === 'task.queued' && e.payload?.reason === 'worker_interrupted'));
  const workerNode = await getPool().query('SELECT status FROM worker_nodes WHERE id = $1', [workerNodeId('drain-worker')]);
  assert.equal(workerNode.rows[0]?.status, 'stopped');
});

