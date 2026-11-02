import '../helpers/sqlite-env.js';

process.env.AGENT_PLATFORM_ENABLED = '1';
process.env.PLATFORM_ADMIN_EMAILS = 'svc-admin@example.com';
process.env.EKH_SERVICE_LEGACY_TOKEN_ENABLED = '0';

import test from 'node:test';
import assert from 'node:assert/strict';

const { ensureSchema, canUseTestDatabase, closeTestDb } = await import('../helpers/pg.js');
const { startApp } = await import('../helpers/app.js');
const { getPool } = await import('../../server/control/pg.js');
const { hashToken } = await import('../../server/control/service-principal-repo.js');

const skip = !canUseTestDatabase();

test('S-05：服务主体 scope、吊销、过期与明文 token 一次性', { skip }, async t => {
  await ensureSchema();
  const app = await startApp({ AGENT_PLATFORM_ENABLED: '1', PLATFORM_ADMIN_EMAILS: 'svc-admin@example.com' });
  t.after(async () => { await app.close(); await closeTestDb(); });

  const { db } = await import('../../server/db.js');
  const ts = Date.now();
  db.prepare('INSERT INTO knowledge_bases(id, name, description, owner_id, created_at, updated_at) VALUES(?,?,?,?,?,?)')
    .run('kb-allowed', '允许库', '', 'admin', ts, ts);
  db.prepare('INSERT INTO knowledge_bases(id, name, description, owner_id, created_at, updated_at) VALUES(?,?,?,?,?,?)')
    .run('kb-denied', '拒绝库', '', 'admin', ts, ts);

  const admin = await app.register('svc-admin@example.com', '管理员');
  const user = await app.register('svc-user@example.com', '普通用户');

  // 普通用户不能管理服务主体。
  assert.equal((await app.request('GET', '/api/service-principals', { token: user.token })).status, 403);
  assert.equal((await app.request('POST', '/api/service-principals', {
    token: user.token, body: { name: 'x', scopes: { all_kbs: true } },
  })).status, 403);

  const created = await app.request('POST', '/api/service-principals', {
    token: admin.token,
    body: { name: '检索机器人', scopes: { kb_ids: ['kb-allowed'], tools: ['search_knowledge'] } },
  });
  assert.equal(created.status, 201);
  const { principal, token } = created.data;
  assert.match(token, /^ekh_/);
  assert.equal(JSON.stringify(created.data).includes(hashToken(token)), false, '不得回显 hash');

  const listed = await app.request('GET', '/api/service-principals', { token: admin.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.principals.length, 1);
  assert.equal(JSON.stringify(listed.data).includes(token), false, '列表不得回显明文');
  assert.equal('token_hash' in listed.data.principals[0], false);

  // 允许的 KB：进入检索；未授权 KB：403；未知 KB：404。
  const ok = await app.request('POST', '/api/retrieve', {
    token, body: { query: 'ping', kb_ids: ['kb-allowed'] },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.kb_ids, ['kb-allowed']);
  const denied = await app.request('POST', '/api/retrieve', {
    token, body: { query: 'ping', kb_ids: ['kb-denied'] },
  });
  assert.equal(denied.status, 403);
  const unknown = await app.request('POST', '/api/retrieve', {
    token, body: { query: 'ping', kb_ids: ['kb-nope'] },
  });
  assert.equal(unknown.status, 404);
  const implicit = await app.request('POST', '/api/retrieve', {
    token, body: { query: 'ping' },
  });
  assert.equal(implicit.status, 200);
  assert.deepEqual(implicit.data.kb_ids, ['kb-allowed']);

  // 轮换后旧 token 失效，新 token 可用。
  const rotated = await app.request('POST', `/api/service-principals/${principal.id}/rotate`, { token: admin.token });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.data.token, token);
  assert.equal((await app.request('POST', '/api/retrieve', { token, body: { query: 'ping' } })).status, 401);
  assert.equal((await app.request('POST', '/api/retrieve', {
    token: rotated.data.token, body: { query: 'ping' },
  })).status, 200);

  // 过期：即使 token 未吊销也不能通过。
  await getPool().query(
    `UPDATE service_principals SET expires_at = now() - interval '1 second' WHERE id = $1`,
    [principal.id],
  );
  assert.equal((await app.request('POST', '/api/retrieve', {
    token: rotated.data.token, body: { query: 'ping' },
  })).status, 401);

  // 恢复有效期后吊销，立即失效。
  await getPool().query('UPDATE service_principals SET expires_at = NULL WHERE id = $1', [principal.id]);
  assert.equal((await app.request('POST', '/api/retrieve', {
    token: rotated.data.token, body: { query: 'ping' },
  })).status, 200);
  assert.equal((await app.request('DELETE', `/api/service-principals/${principal.id}`, { token: admin.token })).status, 200);
  assert.equal((await app.request('POST', '/api/retrieve', {
    token: rotated.data.token, body: { query: 'ping' },
  })).status, 401);
  const after = await app.request('GET', '/api/service-principals', { token: admin.token });
  assert.ok(after.data.principals[0].revoked_at);
});
