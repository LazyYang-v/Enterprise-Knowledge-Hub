import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.EKH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-migrate-test-'));
const { applyBaseSchema } = await import('../../server/db.js');
const { runSqliteMigrations, SQLITE_SCHEMA_VERSION } = await import('../../server/sqlite-migrations.js');

function legacyDb(file){
  const db = new DatabaseSync(file);
  applyBaseSchema(db);
  db.exec(`
    INSERT INTO documents(id, owner_id, kind, name, status, chunk_count, created_at, updated_at)
    VALUES ('d1', 'u1', 'file', 'legacy.txt', 'ready', 1, 1, 1);
    INSERT INTO chunks(id, document_id, kb_id, idx, content, created_at)
    VALUES ('c1', 'd1', NULL, 0, '旧数据', 1);
  `);
  return db;
}

test('SQLite 迁移只增列/表并回填，第二次执行幂等', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-legacy-')), 'legacy.db');
  const db = legacyDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);

  const first = runSqliteMigrations(db);
  assert.equal(first, SQLITE_SCHEMA_VERSION);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SQLITE_SCHEMA_VERSION);

  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get('d1');
  assert.equal(doc.current_version, 1);
  assert.equal(doc.content_hash, '');
  assert.equal(doc.deleted_at, null);

  const version = db.prepare('SELECT * FROM document_versions WHERE document_id = ?').get('d1');
  assert.equal(version.version, 1);
  assert.equal(version.status, 'ready');

  const chunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get('c1');
  assert.equal(chunk.document_version, 1);
  assert.deepEqual(JSON.parse(chunk.locator_json), { chunk_index: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM chunks_fts').get().c, 0);

  const second = runSqliteMigrations(db);
  assert.equal(second, SQLITE_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM document_versions').get().c, 1);
  db.close();
});

test('v2 自定义工具版本：回填版本 1、代码哈希与幂等', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-tools-')), 'legacy.db');
  const db = legacyDb(file);
  db.exec(`
    INSERT INTO custom_tools(id, owner_id, name, description, parameters, code, enabled, created_at, updated_at)
    VALUES ('t1', 'u1', '加法', '计算和', '{"type":"object"}', 'export default { execute: () => "1" }', 1, 5, 5);
  `);
  assert.equal(SQLITE_SCHEMA_VERSION, 2);
  assert.equal(runSqliteMigrations(db), 2);
  const tool = db.prepare('SELECT * FROM custom_tools WHERE id = ?').get('t1');
  assert.equal(tool.current_version, 1);
  assert.match(tool.code_hash, /^[0-9a-f]{64}$/);
  assert.equal(tool.deleted_at, null);
  const version = db.prepare('SELECT * FROM custom_tool_versions WHERE tool_id = ? AND version = 1').get('t1');
  assert.equal(version.code_hash, tool.code_hash);
  assert.equal(version.name, '加法');
  assert.equal(JSON.parse(version.parameters).type, 'object');

  // 再次执行不重复插入版本。
  assert.equal(runSqliteMigrations(db), 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM custom_tool_versions WHERE tool_id = ?').get('t1').c, 1);
  db.close();
});

test('迁移失败回滚且不推进 user_version', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-legacy-bad-')), 'legacy.db');
  const db = legacyDb(file);
  // 同名对象占位，让 CREATE INDEX 失败，验证事务回滚。
  db.exec('CREATE TABLE idx_chunks_doc_version (x INTEGER)');
  assert.throws(() => runSqliteMigrations(db));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
  const cols = db.prepare('PRAGMA table_info(documents)').all().map(r => r.name);
  assert.equal(cols.includes('current_version'), false);
  db.close();
});
