// PostgreSQL 测试接缝：仅允许对名称以 _test 结尾的数据库重建 schema。
import { getPool, closePool } from '../../server/control/pg.js';
import { migrate } from '../../server/control/migrate.js';

export { getPool };

export function databaseUrl(){
  return process.env.DATABASE_URL || '';
}

export function canUseTestDatabase(){
  const url = databaseUrl();
  if (!url) return false;
  try {
    const name = new URL(url).pathname.replace(/^\//, '');
    return name.endsWith('_test');
  } catch { return false; }
}

export async function resetSchema(){
  if (!canUseTestDatabase()) throw new Error('拒绝在非 *_test 数据库上重建 schema');
  const pool = getPool();
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
}

export async function migrateTestDb(){
  return migrate({ connectionString: databaseUrl() });
}

export async function ensureSchema(){
  await resetSchema();
  await migrateTestDb();
}

export async function createTenant(name = '测试租户'){
  const r = await getPool().query(
    `INSERT INTO tenants (name, source_org_id) VALUES ($1, $2) RETURNING id`,
    [name, `test:${name}:${Date.now()}`],
  );
  return r.rows[0].id;
}

export async function closeTestDb(){
  await closePool();
}

export async function getTaskRow(tenantId, taskId){
  const r = await getPool().query('SELECT * FROM agent_tasks WHERE tenant_id = $1 AND id = $2', [tenantId, taskId]);
  return r.rows[0] || null;
}

export async function getEvents(tenantId, taskId){
  const r = await getPool().query(
    'SELECT seq, type, payload FROM agent_events WHERE tenant_id = $1 AND task_id = $2 ORDER BY seq',
    [tenantId, taskId],
  );
  return r.rows;
}

export async function waitFor(fn, { timeout = 10000, interval = 25 } = {}){
  const start = Date.now();
  while (Date.now() - start < timeout){
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('waitFor 超时');
}
