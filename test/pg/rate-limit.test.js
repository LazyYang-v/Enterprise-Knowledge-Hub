// per-tenant 固定窗口限流：原子计数、租户隔离、覆盖配置与清理。
import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureSchema, createTenant, canUseTestDatabase, getPool, closeTestDb,
} from '../helpers/pg.js';
import {
  consumeTenantRate, enforceTenantRate, cleanupRateLimitCounters,
  RateLimitExceededError, RATE_BUCKETS,
} from '../../server/control/rate-limit.js';

const skip = !canUseTestDatabase();

async function override(tenantId, bucket, limit, windowMs){
  await getPool().query(
    `INSERT INTO tenant_rate_limits (tenant_id, bucket, max_requests, window_ms)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, bucket) DO UPDATE SET
       max_requests = EXCLUDED.max_requests, window_ms = EXCLUDED.window_ms, updated_at = now()`,
    [tenantId, bucket, limit, windowMs],
  );
}

test('限流：固定窗口原子消费、租户隔离与 429', { skip, timeout: 30000 }, async t => {
  await ensureSchema();
  const a = await createTenant('rl-a');
  const b = await createTenant('rl-b');
  t.after(() => closeTestDb());

  await override(a, 'task_create', 2, 60000);
  const first = await consumeTenantRate({ tenantId: a, bucket: 'task_create' });
  const second = await consumeTenantRate({ tenantId: a, bucket: 'task_create' });
  const third = await consumeTenantRate({ tenantId: a, bucket: 'task_create' });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);
  assert.equal(third.allowed, false);
  assert.ok(third.retry_after_seconds >= 1 && third.retry_after_seconds <= 61);

  await assert.rejects(
    () => enforceTenantRate({ tenantId: a, bucket: 'task_create', audit: false }),
    e => e instanceof RateLimitExceededError && e.status === 429 && e.retry_after_seconds >= 1,
  );

  const other = await consumeTenantRate({ tenantId: b, bucket: 'task_create' });
  assert.equal(other.allowed, true, 'A 租户限流不影响 B');
  assert.equal(other.count, 1);
});

test('限流：并发消费恰好放行 limit 个', { skip, timeout: 30000 }, async t => {
  await ensureSchema();
  const tenantId = await createTenant('rl-concurrent');
  t.after(() => closeTestDb());
  await override(tenantId, 'tool_call', 5, 60000);

  const results = await Promise.all(
    Array.from({ length: 20 }, () => consumeTenantRate({ tenantId, bucket: 'tool_call' })),
  );
  assert.equal(results.filter(r => r.allowed).length, 5);
  assert.equal(results.filter(r => !r.allowed).length, 15);
  assert.equal(results.reduce((m, r) => Math.max(m, r.count), 0), 20);
});

test('限流：窗口滚动后重新放行', { skip, timeout: 30000 }, async t => {
  await ensureSchema();
  const tenantId = await createTenant('rl-window');
  t.after(() => closeTestDb());
  await override(tenantId, 'model_call', 1, 1000);

  assert.equal((await consumeTenantRate({ tenantId, bucket: 'model_call' })).allowed, true);
  assert.equal((await consumeTenantRate({ tenantId, bucket: 'model_call' })).allowed, false);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal((await consumeTenantRate({ tenantId, bucket: 'model_call' })).allowed, true);
});

test('限流：清理只删除超出保留期的窗口', { skip, timeout: 30000 }, async t => {
  await ensureSchema();
  const tenantId = await createTenant('rl-cleanup');
  t.after(() => closeTestDb());
  await getPool().query(
    `INSERT INTO rate_limit_counters (tenant_id, bucket, window_start, count)
     VALUES ($1, 'task_create', now() - interval '1 hour', 1),
            ($1, 'task_create', now(), 1)`,
    [tenantId],
  );
  const removed = await cleanupRateLimitCounters({ retentionMs: 10 * 60 * 1000 });
  assert.equal(removed, 1);
  const left = await getPool().query(
    'SELECT COUNT(*)::int AS n FROM rate_limit_counters WHERE tenant_id = $1',
    [tenantId],
  );
  assert.equal(left.rows[0].n, 1);
});

test('限流：桶名白名单', () => {
  assert.deepEqual([...RATE_BUCKETS], ['task_create', 'model_call', 'tool_call']);
  return assert.rejects(() => consumeTenantRate({ tenantId: 'x', bucket: 'unknown' }), TypeError);
});
