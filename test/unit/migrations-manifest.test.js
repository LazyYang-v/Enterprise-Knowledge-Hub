import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listMigrations } from '../../server/control/migrate.js';

const migrations = listMigrations();

test('迁移文件按版本排序且校验和稳定', () => {
  assert.ok(migrations.length >= 1);
  const versions = migrations.map(m => m.version);
  assert.deepEqual(versions, [...versions].sort());
  for (const m of migrations){
    assert.match(m.version, /^\d{4}_[a-z0-9_]+$/);
    assert.match(m.checksum, /^[a-f0-9]{64}$/);
  }
});

test('迁移文件不含事务控制或非事务 DDL', () => {
  for (const m of migrations){
    assert.doesNotMatch(m.sql, /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im, `${m.file} 不应包含事务控制`);
    assert.doesNotMatch(m.sql, /CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i, `${m.file} 使用了非事务 DDL`);
  }
});

test('控制面核心表与 append-only 保护已定义', () => {
  const sql = migrations.map(m => m.sql).join('\n');
  for (const table of [
    'tenants', 'model_profiles', 'agent_presets', 'skills', 'tool_registry', 'tool_policies',
    'mcp_connections', 'mcp_tool_cache', 'service_principals', 'agent_tasks', 'agent_messages',
    'agent_plan_items', 'agent_steps', 'agent_tool_calls', 'agent_tool_attempts', 'agent_approvals',
    'agent_input_requests', 'agent_checkpoints', 'agent_events', 'agent_evidence', 'artifact_blobs',
    'artifacts', 'task_attachments', 'audit_log', 'idempotency_keys', 'worker_nodes',
  ]){
    assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`), `缺少表 ${table}`);
  }
  assert.match(sql, /CREATE TRIGGER agent_events_append_only/);
  assert.match(sql, /CREATE TRIGGER audit_log_append_only/);
});
