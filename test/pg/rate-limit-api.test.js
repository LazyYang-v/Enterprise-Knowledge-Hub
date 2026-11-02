// 任务创建 API 的租户级限流：第 N+1 次 429、Retry-After、租户隔离与审计。
process.env.AGENT_PLATFORM_ENABLED = '1';

import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { ensureSchema, canUseTestDatabase, closeTestDb, getPool } = await import('../helpers/pg.js');
const { startApp } = await import('../helpers/app.js');
const { db } = await import('../../server/db.js');

const skip = !canUseTestDatabase();

async function tenantFor(email){
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (!user) return null;
  const r = await getPool().query(
    'SELECT id FROM tenants WHERE source_org_id = $1 LIMIT 1',
    [`user:${user.id}`],
  );
  return r.rows[0]?.id || null;
}

test('任务创建限流：429 + Retry-After，租户隔离并审计', { skip, timeout: 60000 }, async t => {
  await ensureSchema();
  const app = await startApp({ AGENT_PLATFORM_ENABLED: '1' });
  t.after(async () => { await app.close(); await closeTestDb(); });

  const user = await app.register('rl-user@example.com', '限流用户');
  const other = await app.register('rl-other@example.com', '其他租户');

  const first = await app.request('POST', '/api/tasks', {
    token: user.token, body: { goal: '第一次任务' },
  });
  assert.equal(first.status, 201);

  const tenantId = await tenantFor('rl-user@example.com');
  assert.ok(tenantId);
  await getPool().query(
    `INSERT INTO tenant_rate_limits (tenant_id, bucket, max_requests, window_ms)
     VALUES ($1, 'task_create', 1, 60000)`,
    [tenantId],
  );

  const limited = await app.request('POST', '/api/tasks', {
    token: user.token, body: { goal: '包含敏感目标的任务' },
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal(limited.data.error.code, 'rate_limited');
  assert.equal(limited.data.error.retryable, true);
  assert.equal(limited.data.error.details.bucket, 'task_create');
  assert.equal(limited.data.error.details.limit, 1);
  assert.ok(!limited.text.includes('包含敏感目标'), '429 响应不得回显 goal');

  const otherTenant = await app.request('POST', '/api/tasks', {
    token: other.token, body: { goal: '其他租户任务' },
  });
  assert.equal(otherTenant.status, 201, 'A 租户限流不影响 B');

  const audit = await getPool().query(
    `SELECT detail_json FROM audit_log
      WHERE tenant_id = $1 AND action = 'rate_limit.exceeded'
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].detail_json.bucket, 'task_create');
  assert.equal(audit.rows[0].detail_json.limit, 1);

  // 限流记录存在时，幂等键不会绕过限流。
  const withIdem = await app.request('POST', '/api/tasks', {
    token: user.token, headers: { 'Idempotency-Key': 'rl-1' }, body: { goal: '幂等任务' },
  });
  assert.equal(withIdem.status, 429);
});
