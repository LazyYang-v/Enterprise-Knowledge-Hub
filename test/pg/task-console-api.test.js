// 任务控制台 API：列表字段、搜索、状态筛选、计数与游标分页。
process.env.AGENT_PLATFORM_ENABLED = '1';

import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { ensureSchema, canUseTestDatabase, closeTestDb } = await import('../helpers/pg.js');
const { startApp } = await import('../helpers/app.js');
const { getPool } = await import('../../server/control/pg.js');

const skip = !canUseTestDatabase();

test('任务列表返回 goal/错误/结果摘要、搜索、状态筛选、计数与游标', { skip }, async t => {
  await ensureSchema();
  const app = await startApp({ AGENT_PLATFORM_ENABLED: '1' });
  t.after(async () => { await app.close(); await closeTestDb(); });

  const user = await app.register('console-user@example.com', '控制台用户');
  const created = [];
  for (const goal of ['Alpha 季度报告', 'Beta 项目计划', 'Gamma 季度报告', 'Delta 运行中']){
    const r = await app.request('POST', '/api/tasks', {
      token: user.token, body: { goal, title: goal.slice(0, 12) },
    });
    assert.equal(r.status, 201);
    created.push(r.data.task);
  }

  const tenantId = (await getPool().query(
    'SELECT tenant_id FROM agent_tasks WHERE id = $1', [created[0].id],
  )).rows[0].tenant_id;
  await getPool().query(
    `UPDATE agent_tasks SET status = 'waiting_approval' WHERE tenant_id = $1 AND id = $2`,
    [tenantId, created[0].id],
  );
  await getPool().query(
    `UPDATE agent_tasks SET status = 'completed', result_summary = '已生成季度报告'
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, created[1].id],
  );
  await getPool().query(
    `UPDATE agent_tasks SET status = 'failed', last_error_code = 'model_timeout',
            last_error_detail = '模型超时'
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, created[2].id],
  );

  const all = await app.request('GET', '/api/tasks', { token: user.token });
  assert.equal(all.status, 200);
  assert.equal(all.data.tasks.length, 4);
  assert.ok(all.data.tasks.every(x => typeof x.goal === 'string' && x.goal.length > 0));
  const completed = all.data.tasks.find(x => x.id === created[1].id);
  assert.equal(completed.result_summary, '已生成季度报告');
  const failed = all.data.tasks.find(x => x.id === created[2].id);
  assert.equal(failed.last_error_code, 'model_timeout');
  assert.deepEqual(all.data.counts, {
    all: 4, running: 1, waiting_approval: 1, finished: 2,
  });
  assert.ok(all.data.tasks[0].budget, '列表应包含预算快照');

  const searching = await app.request('GET', '/api/tasks?q=季度', { token: user.token });
  assert.equal(searching.status, 200);
  assert.equal(searching.data.tasks.length, 2);
  assert.deepEqual(searching.data.counts, {
    all: 2, running: 0, waiting_approval: 1, finished: 1,
  });

  const filtered = await app.request('GET', '/api/tasks?status=waiting_approval', { token: user.token });
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.data.tasks.map(x => x.id), [created[0].id]);

  const invalid = await app.request('GET', '/api/tasks?status=nope', { token: user.token });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error.code, 'validation_error');

  const first = await app.request('GET', '/api/tasks?limit=1', { token: user.token });
  assert.equal(first.data.tasks.length, 1);
  assert.ok(first.data.next_cursor);
  const second = await app.request(
    'GET', `/api/tasks?limit=1&cursor=${encodeURIComponent(first.data.next_cursor)}`,
    { token: user.token },
  );
  assert.equal(second.status, 200);
  assert.equal(second.data.tasks.length, 1);
  assert.notEqual(second.data.tasks[0].id, first.data.tasks[0].id);

  const snapshot = await app.request('GET', `/api/tasks/${created[1].id}`, { token: user.token });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.task.result_summary, '已生成季度报告');
});
