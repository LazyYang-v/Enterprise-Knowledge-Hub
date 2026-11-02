// S-09：成果 ACL —— 仅任务所有者或同租户管理员可列表/下载/上传/删除（需要 PostgreSQL）。
process.env.AGENT_PLATFORM_ENABLED = '1';
process.env.PLATFORM_ADMIN_EMAILS = 'admin@example.com';

import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { ensureSchema, canUseTestDatabase, closeTestDb } = await import('../helpers/pg.js');
const { startApp } = await import('../helpers/app.js');

const skip = !canUseTestDatabase();
const FILE = Buffer.from('权限测试附件', 'utf8');

async function attemptAll(app, taskId, artifactId, token){
  return {
    list: await app.request('GET', `/api/tasks/${taskId}/artifacts`, { token }),
    download: await app.requestRaw('GET', `/api/tasks/${taskId}/artifacts/${artifactId}/download`, { token }),
    upload: await app.uploadForm(`/api/tasks/${taskId}/attachments`, {
      token, filename: '越权.txt', data: FILE, contentType: 'text/plain',
    }),
    remove: await app.request('DELETE', `/api/tasks/${taskId}/artifacts/${artifactId}`, { token }),
  };
}

test('S-09 成果 ACL：跨用户/跨租户一律 404，同租户管理员放行', { skip }, async t => {
  await ensureSchema();
  const app = await startApp({
    AGENT_PLATFORM_ENABLED: '1',
    PLATFORM_ADMIN_EMAILS: 'admin@example.com',
  });
  t.after(async () => { await app.close(); await closeTestDb(); });

  const owner = await app.register('owner-acl@example.com', '任务所有者');
  const member = await app.register('member-acl@example.com', '同租户成员');
  const admin = await app.register('admin@example.com', '租户管理员');
  const stranger = await app.register('stranger-acl@example.com', '其他租户用户');

  // owner/member/admin 同属一个组织（= 同一租户）；stranger 停留在个人租户。
  const org = await app.request('POST', '/api/orgs', {
    token: owner.token, body: { name: '成果权限空间' },
  });
  assert.equal(org.status, 200, JSON.stringify(org.data));
  const code = org.data.org.invite_code;
  assert.equal((await app.request('POST', '/api/orgs/join', { token: member.token, body: { code } })).status, 200);
  assert.equal((await app.request('POST', '/api/orgs/join', { token: admin.token, body: { code } })).status, 200);

  const created = await app.request('POST', '/api/tasks', {
    token: owner.token, body: { goal: '成果权限测试' },
  });
  const taskId = created.data.task.id;
  const uploaded = await app.uploadForm(`/api/tasks/${taskId}/attachments`, {
    token: owner.token, filename: '输入.txt', data: FILE, contentType: 'text/plain',
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
  const artifactId = uploaded.data.artifact.id;

  await t.test('同租户非所有者：看不到、下不了、传不了、删不了', async () => {
    const r = await attemptAll(app, taskId, artifactId, member.token);
    assert.equal(r.list.status, 404);
    assert.equal(r.download.status, 404);
    assert.equal(r.upload.status, 404);
    assert.equal(r.remove.status, 404);
    // 任务详情沿用既有语义（同租户仍是 403）；成果接口才统一 404。
    assert.equal((await app.request('GET', `/api/tasks/${taskId}`, { token: member.token })).status, 403);
  });

  await t.test('跨租户用户：即使有自己的任务也一律 404', async () => {
    assert.equal((await app.request('POST', '/api/tasks', {
      token: stranger.token, body: { goal: '陌生人的任务' },
    })).status, 201);
    const r = await attemptAll(app, taskId, artifactId, stranger.token);
    assert.equal(r.list.status, 404);
    assert.equal(r.download.status, 404);
    assert.equal(r.upload.status, 404);
    assert.equal(r.remove.status, 404);
  });

  await t.test('同租户管理员：可列表与下载，下载后文件仍归所有者', async () => {
    const list = await app.request('GET', `/api/tasks/${taskId}/artifacts`, { token: admin.token });
    assert.equal(list.status, 200);
    assert.equal(list.data.artifacts.length, 1);
    assert.equal(list.data.artifacts[0].id, artifactId);

    const download = await app.requestRaw('GET', `/api/tasks/${taskId}/artifacts/${artifactId}/download`, {
      token: admin.token,
    });
    assert.equal(download.status, 200);
    assert.deepEqual(download.buffer, FILE);

    const snapshot = await app.request('GET', `/api/tasks/${taskId}`, { token: admin.token });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.data.task.permissions.can_download, true);

    // 删除后对所有者也不可见、不可下载。
    assert.equal((await app.request('DELETE', `/api/tasks/${taskId}/artifacts/${artifactId}`, {
      token: owner.token,
    })).status, 200);
    assert.equal((await app.request('GET', `/api/tasks/${taskId}/artifacts`, { token: owner.token })).data.artifacts.length, 0);
    assert.equal((await app.requestRaw('GET', `/api/tasks/${taskId}/artifacts/${artifactId}/download`, {
      token: owner.token,
    })).status, 404);
  });
});
