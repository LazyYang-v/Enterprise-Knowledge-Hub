// PostgreSQL 迁移测试：仅允许对名称以 _test 结尾的数据库执行 schema 重建。
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate, status } from '../../server/control/migrate.js';

const connectionString = process.env.DATABASE_URL || '';
let databaseName = '';
try { databaseName = new URL(connectionString).pathname.replace(/^\//, ''); } catch {}
const skip = !databaseName.endsWith('_test')
  ? '需要 DATABASE_URL 指向名称以 _test 结尾的数据库（例如 ekh_test）'
  : false;

const CORE_TABLES = [
  'tenants', 'model_profiles', 'agent_presets', 'skills', 'agent_preset_skills',
  'tool_registry', 'tool_policies', 'mcp_connections', 'mcp_tool_cache', 'service_principals',
  'agent_tasks', 'agent_messages', 'agent_plan_items', 'agent_steps', 'agent_tool_calls',
  'agent_tool_attempts', 'agent_approvals', 'agent_input_requests', 'agent_checkpoints',
  'agent_events', 'agent_evidence', 'artifact_blobs', 'artifacts', 'task_attachments',
  'audit_log', 'idempotency_keys', 'worker_nodes',
];

async function withClient(fn){
  const client = new pg.Client({ connectionString });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

test('控制面迁移可重复执行且结构完整', { skip }, async () => {
  // 安全护栏：再次确认不是生产/开发库。
  assert.ok(databaseName.endsWith('_test'), `拒绝在 ${databaseName} 上执行迁移测试`);

  await withClient(c => c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'));

  // dry-run 不创建 tracking 表，也不写业务表。
  const dry = await migrate({ connectionString, dryRun: true, log: () => {} });
  assert.deepEqual(dry.pending, ['0001_control_plane', '0002_p0_2_task_runtime', '0003_p0_3_knowledge_evidence', '0004_p0_4_tools_approvals', '0005_p0_4_fencing']);
  assert.deepEqual(dry.applied, []);
  await withClient(async c => {
    const r = await c.query("SELECT to_regclass('public.schema_migrations') AS t");
    assert.equal(r.rows[0].t, null, 'dry-run 不应创建 schema_migrations');
  });

  // 首次执行。
  const first = await migrate({ connectionString, log: () => {} });
  assert.deepEqual(first.applied, ['0001_control_plane', '0002_p0_2_task_runtime', '0003_p0_3_knowledge_evidence', '0004_p0_4_tools_approvals', '0005_p0_4_fencing']);
  assert.deepEqual(first.skipped, []);

  // 第二次执行幂等。
  const second = await migrate({ connectionString, log: () => {} });
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, ['0001_control_plane', '0002_p0_2_task_runtime', '0003_p0_3_knowledge_evidence', '0004_p0_4_tools_approvals', '0005_p0_4_fencing']);

  const s = await status({ connectionString });
  assert.deepEqual(s.applied, ['0001_control_plane', '0002_p0_2_task_runtime', '0003_p0_3_knowledge_evidence', '0004_p0_4_tools_approvals', '0005_p0_4_fencing']);
  assert.deepEqual(s.pending, []);

  await withClient(async c => {
    const tables = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    const names = new Set(tables.rows.map(r => r.table_name));
    for (const t of CORE_TABLES) assert.ok(names.has(t), `缺少表 ${t}`);
    assert.ok(names.has('schema_migrations'));

    const indexes = await c.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'");
    const indexNames = new Set(indexes.rows.map(r => r.indexname));
    for (const idx of [
      'idx_agent_tasks_queue', 'idx_agent_tasks_lease', 'idx_agent_events_task_seq',
      'uq_agent_approvals_pending', 'uq_agent_presets_active_name',
      'uq_agent_tool_calls_idem', 'uq_agent_inputs_pending', 'idx_agent_tasks_retry_due',
      'uq_agent_evidence_chunk', 'idx_agent_evidence_task_time', 'idx_agent_evidence_doc_version',
      'idx_skills_tenant_name', 'idx_agent_tool_calls_task_tool', 'idx_tool_registry_owner',
      'idx_agent_approvals_consumed', 'idx_service_principals_active', 'idx_agent_evidence_claim',
    ]) assert.ok(indexNames.has(idx), `缺少索引 ${idx}`);

    const evidenceCols = await c.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='agent_evidence'",
    );
    const evidenceNames = new Set(evidenceCols.rows.map(r => r.column_name));
    assert.ok(evidenceNames.has('title'));
    assert.ok(evidenceNames.has('kb_name'));
    assert.ok(evidenceNames.has('lease_epoch'));

    const cols = async table => {
      const r = await c.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
        [table],
      );
      return new Set(r.rows.map(x => x.column_name));
    };
    assert.ok((await cols('tool_registry')).has('owner_id'));
    assert.ok((await cols('agent_tool_calls')).has('code_hash'));
    assert.ok((await cols('agent_tool_calls')).has('result_hash'));
    assert.ok((await cols('agent_approvals')).has('consumed_at'));
    assert.ok((await cols('agent_approvals')).has('consumed_by'));
    assert.ok((await cols('service_principals')).has('revoked_at'));
    assert.ok((await cols('agent_tasks')).has('lease_epoch'));

    const triggers = await c.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal");
    const triggerNames = new Set(triggers.rows.map(r => r.tgname));
    assert.ok(triggerNames.has('agent_events_append_only'));
    assert.ok(triggerNames.has('audit_log_append_only'));
  });
});

test('事件与审计日志拒绝 UPDATE/DELETE', { skip }, async () => {
  const ids = await withClient(async c => {
    const tenant = await c.query("INSERT INTO tenants (name) VALUES ('测试租户') RETURNING id");
    const tenantId = tenant.rows[0].id;
    const task = await c.query(
      "INSERT INTO agent_tasks (tenant_id, owner_id, goal) VALUES ($1, 'user-1', '测试任务') RETURNING id",
      [tenantId],
    );
    const taskId = task.rows[0].id;
    const event = await c.query(
      "INSERT INTO agent_events (tenant_id, task_id, seq, type) VALUES ($1, $2, 1, 'task.created') RETURNING id",
      [tenantId, taskId],
    );
    const audit = await c.query(
      "INSERT INTO audit_log (tenant_id, actor_type, actor_id, action) VALUES ($1, 'user', 'user-1', 'test.action') RETURNING id",
      [tenantId],
    );
    return { eventId: event.rows[0].id, auditId: audit.rows[0].id };
  });

  await withClient(async c => {
    await assert.rejects(
      () => c.query('UPDATE agent_events SET type = $1 WHERE id = $2', ['tampered', ids.eventId]),
      /append-only/,
    );
    await assert.rejects(
      () => c.query('DELETE FROM agent_events WHERE id = $1', [ids.eventId]),
      /append-only/,
    );
    await assert.rejects(
      () => c.query("UPDATE audit_log SET action = 'tampered' WHERE id = $1", [ids.auditId]),
      /append-only/,
    );
  });
});
