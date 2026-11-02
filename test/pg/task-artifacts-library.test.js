// 跨任务产物库 API：ACL、过滤、游标与字段最小化。
process.env.AGENT_PLATFORM_ENABLED = '1';

import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { ensureSchema, canUseTestDatabase, closeTestDb } = await import('../helpers/pg.js');
const { startApp } = await import('../helpers/app.js');

const skip = !canUseTestDatabase();

async function createTask(app, token, goal){
  const r = await app.request('POST', '/api/tasks', { token, body: { goal, title: goal } });
  assert.equal(r.status, 201);
  return r.data.task;
}

async function upload(app, token, taskId, filename, content){
  const r = await app.uploadForm(`/api/tasks/${taskId}/attachments`, {
    token, filename, data: Buffer.from(content), contentType: 'text/plain',
  });
  assert.equal(r.status, 201, r.buffer.toString('utf8'));
  return r.data.artifact;
}

test('产物库只返回本人任务成果，并支持任务/名称/类型过滤和游标', { skip }, async t => {
  await ensureSchema();
  const app = await startApp({ AGENT_PLATFORM_ENABLED: '1' });
  t.after(async () => { await app.close(); await closeTestDb(); });

  const user = await app.register('library-user@example.com', '产物用户');
  const stranger = await app.register('library-stranger@example.com', '陌生人');

  const taskA = await createTask(app, user.token, '任务 A');
  const taskB = await createTask(app, user.token, '任务 B');
  const foreignTask = await createTask(app, stranger.token, '他人任务');

  const a = await upload(app, user.token, taskA.id, 'report.txt', 'alpha report');
  const b = await upload(app, user.token, taskB.id, 'plan.json', '{"ok":true}');
  const foreign = await upload(app, stranger.token, foreignTask.id, 'secret.txt', 'secret');

  const all = await app.request('GET', '/api/task-artifacts?limit=50', { token: user.token });
  assert.equal(all.status, 200);
  const ids = all.data.artifacts.map(x => x.id);
  assert.ok(ids.includes(a.id));
  assert.ok(ids.includes(b.id));
  assert.ok(!ids.includes(foreign.id), '不得看到他人任务产物');
  assert.equal(all.data.artifacts.find(x => x.id === a.id).task_title, '任务 A');
  assert.equal(all.data.artifacts.find(x => x.id === a.id).task_status, 'queued');
  assert.equal(all.data.artifacts.find(x => x.id === a.id).kind, 'input');
  assert.equal(all.data.artifacts.find(x => x.id === a.id).storage_key, undefined);
  assert.equal(all.data.artifacts.find(x => x.id === a.id).sha256.length, 64);

  const byTask = await app.request('GET', `/api/task-artifacts?task_id=${taskB.id}`, { token: user.token });
  assert.equal(byTask.status, 200);
  assert.deepEqual(byTask.data.artifacts.map(x => x.id), [b.id]);

  const byName = await app.request('GET', '/api/task-artifacts?q=report', { token: user.token });
  assert.equal(byName.status, 200);
  assert.deepEqual(byName.data.artifacts.map(x => x.id), [a.id]);

  const byKind = await app.request('GET', '/api/task-artifacts?kind=output', { token: user.token });
  assert.equal(byKind.status, 200);
  assert.equal(byKind.data.artifacts.length, 0);

  const invalidKind = await app.request('GET', '/api/task-artifacts?kind=nope', { token: user.token });
  assert.equal(invalidKind.status, 400);
  assert.equal(invalidKind.data.error.code, 'validation_error');

  const first = await app.request('GET', '/api/task-artifacts?limit=1', { token: user.token });
  assert.equal(first.status, 200);
  assert.equal(first.data.artifacts.length, 1);
  assert.ok(first.data.next_cursor);
  const second = await app.request(
    'GET', `/api/task-artifacts?limit=1&cursor=${encodeURIComponent(first.data.next_cursor)}`,
    { token: user.token },
  );
  assert.equal(second.status, 200);
  assert.equal(second.data.artifacts.length, 1);
  assert.notEqual(second.data.artifacts[0].id, first.data.artifacts[0].id);

  const anonymous = await app.request('GET', '/api/task-artifacts');
  assert.equal(anonymous.status, 401);
});
