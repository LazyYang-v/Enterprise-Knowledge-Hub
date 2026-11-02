// SQLite 知识面最小迁移：只加列/表与回填，不删除业务数据。
// 使用 PRAGMA user_version 记录版本；迁移在单事务内执行，失败回滚。
import crypto from 'node:crypto';
import { now } from './util.js';

export const SQLITE_SCHEMA_VERSION = 2;

function tableColumns(db, table){
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
}

function addColumnIfMissing(db, table, column, definition){
  if (tableColumns(db, table).has(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

function backfill(db){
  const docs = db.prepare('SELECT * FROM documents').all();
  const insVersion = db.prepare(`
    INSERT OR IGNORE INTO document_versions
      (id, document_id, version, content_hash, source_path, source_mtime, size_bytes,
       status, error, note, created_by, created_at, ready_at)
    VALUES (?, ?, 1, '', ?, NULL, ?, ?, ?, '', ?, ?, ?)
  `);
  for (const doc of docs){
    const status = doc.status === 'ready' ? 'ready' : doc.status === 'failed' ? 'failed' : 'processing';
    const createdAt = Number(doc.created_at) || now();
    insVersion.run(
      `${doc.id}:1`, doc.id, doc.path || '', Number(doc.size) || 0,
      status, doc.error || '', doc.owner_id || '', createdAt,
      status === 'ready' ? (Number(doc.updated_at) || createdAt) : null,
    );
  }
  db.exec("UPDATE chunks SET document_version = 1 WHERE document_version IS NULL OR document_version = 0");
  db.exec("UPDATE chunks SET locator_json = '{\"chunk_index\":' || COALESCE(idx, 0) || '}' WHERE locator_json = '{}'");
}

function migrateV1(db){
  addColumnIfMissing(db, 'documents', 'current_version', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'documents', 'content_hash', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'documents', 'deleted_at', 'INTEGER');

  db.exec(`
    CREATE TABLE IF NOT EXISTS document_versions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      content_hash TEXT NOT NULL DEFAULT '',
      source_path TEXT NOT NULL DEFAULT '',
      source_mtime INTEGER,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'ready', 'failed')),
      error TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER,
      ready_at INTEGER,
      UNIQUE (document_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_document_versions_doc
      ON document_versions(document_id, version DESC);
    CREATE INDEX IF NOT EXISTS idx_document_versions_status
      ON document_versions(status, created_at);
  `);

  addColumnIfMissing(db, 'chunks', 'document_version', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'chunks', 'content_hash', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'chunks', 'locator_json', "TEXT NOT NULL DEFAULT '{}'");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_doc_version ON chunks(document_id, document_version);
    CREATE INDEX IF NOT EXISTS idx_chunks_kb_version ON chunks(kb_id, document_version);
    CREATE INDEX IF NOT EXISTS idx_documents_kb_live ON documents(kb_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_documents_session_live ON documents(session_id, deleted_at);
  `);

  backfill(db);
}

function codeHash(code){
  return crypto.createHash('sha256').update(String(code ?? '')).digest('hex');
}

/**
 * v2：自定义工具不可变版本。
 * 旧 custom_tools 行原地保留，版本 1 回填到 custom_tool_versions；代码哈希用于
 * 任务快照校验，代码变化必须生成新版本而不是覆盖旧版本。
 */
function migrateV2(db){
  addColumnIfMissing(db, 'custom_tools', 'current_version', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'custom_tools', 'code_hash', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'custom_tools', 'deleted_at', 'INTEGER');

  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_tool_versions (
      id TEXT PRIMARY KEY,
      tool_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      code TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      parameters TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER,
      UNIQUE (tool_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_custom_tool_versions
      ON custom_tool_versions(tool_id, version DESC);
    CREATE INDEX IF NOT EXISTS idx_custom_tools_owner
      ON custom_tools(owner_id, deleted_at);
  `);

  const tools = db.prepare('SELECT * FROM custom_tools').all();
  const insVersion = db.prepare(`
    INSERT OR IGNORE INTO custom_tool_versions
      (id, tool_id, version, code, code_hash, name, description, parameters, created_by, created_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateTool = db.prepare(
    'UPDATE custom_tools SET current_version = 1, code_hash = ? WHERE id = ?',
  );
  for (const tool of tools){
    const hash = tool.code_hash || codeHash(tool.code);
    const version = Number(tool.current_version) > 0 ? Number(tool.current_version) : 1;
    insVersion.run(
      `${tool.id}:1`, tool.id, tool.code || '', hash, tool.name || '',
      tool.description || '', tool.parameters || '{}', tool.owner_id || '',
      Number(tool.created_at) || now(),
    );
    updateTool.run(hash, tool.id);
    void version;
  }
}

export function runSqliteMigrations(db){
  const current = Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  if (current >= SQLITE_SCHEMA_VERSION) return current;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (current < 1) migrateV1(db);
    if (current < 2) migrateV2(db);
    db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (e){
    db.exec('ROLLBACK');
    throw e;
  }
  return SQLITE_SCHEMA_VERSION;
}
