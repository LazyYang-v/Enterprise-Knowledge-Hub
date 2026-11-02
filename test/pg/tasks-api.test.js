// 任务 API + SSE（需要 PostgreSQL）。先设置开关，再动态导入 app 以读取配置。
process.env.AGENT_PLATFORM_ENABLED = '1';

import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { ensureSchema, canUseTestDatabase, closeTestDb } = await import('../helpers/pg.js');
const { startApp } = await import('../helpers/app.js');
const { startFakeModel, finish, askUser } = await import('../helpers/fake-model.js');
const { TaskWorker } = await import('../../server/control/worker.js');

const skip = !canUseTestDatabase();

function workerFor(model){
  return new TaskWorker({
    workerId: 'api-worker', model, log: () => {},
    leaseTtlMs: 5000, heartbeatIntervalMs: 1000, reaperIntervalMs: 0,
    pollIntervalMs: 10, retryBaseMs: 10, maxRetryDelayMs: 20,
  });
}

async function readSse(url, token, lastEventId = null){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(lastEventId != null ? { 'Last-Event-ID': String(lastEventId) } : {}),
      },
      signal: controller.signal,
    });
    const text = await res.text();
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));
    return { status: res.status, text, ids };
  } finally {
    clearTimeout(timer);
  }
}

test('P0-2 任务 API、SSE 续传与取消', { skip }, async t => {
  await ensureSchema();
  const app = await startApp({ AGENT_PLATFORM_ENABLED: '1' });
  t.after(async () => { await app.close(); await closeTestDb(); });

  const user = await app.register('task-user@example.com', '任务用户');
  const other = await app.register('task-other@example.com', '其他用户');

  let model;
  const created = await app.request('POST', '/api/tasks', {
    token: user.token,
    body: { goal: '生成一份测试报告', title: '测试报告' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.task.status, 'queued');
  assert.equal(created.data.task.title, '测试报告');
  assert.equal(created.data.events_url, `/api/tasks/${created.data.task.id}/events`);
  assert.ok(created.data.request_id);
  const taskId = created.data.task.id;

  // 列表与快照
  const list = await app.request('GET', '/api/tasks', { token: user.token });
  assert.equal(list.status, 200);
  assert.equal(list.data.tasks.length, 1);
  assert.equal(list.data.tasks[0].id, taskId);

  const otherSnapshot = await app.request('GET', `/api/tasks/${taskId}`, { token: other.token });
  assert.equal(otherSnapshot.status, 404, '他人任务不可见');

  // 未执行时 SSE 保持连接；这里直接先执行完，验证 F-03：无 SSE 也能继续并回放。
  model = await startFakeModel(() => finish('报告已生成'));
  t.after(() => model.close());
  const result = await workerFor(model).runOnce();
  assert.equal(result.status, 'completed');

  const snapshot = await app.request('GET', `/api/tasks/${taskId}`, { token: user.token });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.task.status, 'completed');
  assert.equal(snapshot.data.task.usage.steps, 1);
  const lastSeq = snapshot.data.task.last_event_seq;
  assert.ok(lastSeq >= 4);

  // SSE：从 seq=1 续传，事件序号无缺口
  const sse = await readSse(`${app.base}/api/tasks/${taskId}/events`, user.token, 1);
  assert.equal(sse.status, 200);
  assert.deepEqual(sse.ids, Array.from({ length: sse.ids.length }, (_, i) => i + 2));
  assert.ok(sse.text.includes('event: task.completed'));
  assert.ok(sse.text.includes('event: end'));
  assert.ok(!sse.text.includes('event: gap'));

  // R-05：断线后从 Last-Event-ID 续传，不重复
  const replay = await readSse(`${app.base}/api/tasks/${taskId}/events`, user.token, lastSeq - 1);
  assert.deepEqual(replay.ids, [lastSeq]);
  assert.ok(replay.text.includes('event: task.completed'));

  const history = await app.request('GET', `/api/tasks/${taskId}/events/history?after=0`, { token: user.token });
  assert.equal(history.status, 200);
  const historySeqs = history.data.events.map(e => e.seq);
  assert.deepEqual(historySeqs, historySeqs.map((_, i) => i + 1));
  assert.equal(history.data.latest_seq, lastSeq);
  assert.equal(history.data.gap, null);

  const historyGap = await app.request('GET', `/api/tasks/${taskId}/events/history?after=2`, { token: user.token });
  assert.equal(historyGap.data.events[0].seq, 3);
  assert.equal(historyGap.data.gap, null);

  // 取消 queued 任务
  const second = await app.request('POST', '/api/tasks', {
    token: user.token, body: { goal: '待取消任务' },
  });
  const cancelled = await app.request('POST', `/api/tasks/${second.data.task.id}/cancel`, {
    token: user.token, body: { reason: 'user_test' },
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.task.status, 'cancelled');

  // 幂等创建：相同 key 返回同一任务；不同请求 409
  const idemHeaders = { 'Idempotency-Key': 'idem-1' };
  const idem1 = await app.request('POST', '/api/tasks', {
    token: user.token, headers: idemHeaders, body: { goal: '幂等任务' },
  });
  const idem2 = await app.request('POST', '/api/tasks', {
    token: user.token, headers: idemHeaders, body: { goal: '幂等任务' },
  });
  assert.equal(idem1.status, 201);
  assert.equal(idem2.status, 200);
  assert.equal(idem1.data.task.id, idem2.data.task.id);
  const conflict = await app.request('POST', '/api/tasks', {
    token: user.token, headers: idemHeaders, body: { goal: '不同目标' },
  });
  assert.equal(conflict.status, 409);
  // 清空队列，避免后续 Worker 领取到幂等任务。
  await app.request('POST', `/api/tasks/${idem1.data.task.id}/cancel`, { token: user.token });

  // 输入 API
  let call = 0;
  const inputModel = await startFakeModel(() => {
    call += 1;
    if (call === 1) return askUser('请输入天数', { days: { type: 'integer', required: true } });
    return finish('输入完成');
  });
  t.after(() => inputModel.close());
  const inputTask = await app.request('POST', '/api/tasks', {
    token: user.token, body: { goal: '需要输入的任务' },
  });
  const waiting = await workerFor(inputModel).runOnce();
  assert.equal(waiting.status, 'waiting_input');
  const pending = await app.request('GET', `/api/tasks/${inputTask.data.task.id}`, { token: user.token });
  assert.equal(pending.data.task.pending.input.question, '请输入天数');

  const badInput = await app.request('POST', `/api/tasks/${inputTask.data.task.id}/input`, {
    token: user.token, body: { values: { days: 'x' } },
  });
  assert.equal(badInput.status, 400);
  const goodInput = await app.request('POST', `/api/tasks/${inputTask.data.task.id}/input`, {
    token: user.token, body: { values: { days: 3 } },
  });
  assert.equal(goodInput.status, 200);
  assert.equal(goodInput.data.task.status, 'queued');

  // 新端点不接受 query token
  const queryToken = await app.request('GET', '/api/tasks?token=' + encodeURIComponent(user.token), {});
  assert.equal(queryToken.status, 401);
});
