import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { $uuid, $token, hashPassword, now } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  theme TEXT DEFAULT 'light',
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER,
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  owner_id TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'contributor',
  joined_at INTEGER,
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  owner_id TEXT NOT NULL,
  org_id TEXT,
  pinned INTEGER DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS kb_favorites (
  user_id TEXT NOT NULL,
  kb_id TEXT NOT NULL,
  PRIMARY KEY (user_id, kb_id)
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  kb_id TEXT,
  session_id TEXT,
  owner_id TEXT NOT NULL,
  kind TEXT DEFAULT 'file',
  name TEXT NOT NULL,
  mime TEXT DEFAULT '',
  ext TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  path TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  error TEXT DEFAULT '',
  answer TEXT DEFAULT '',
  chunk_count INTEGER DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  kb_id TEXT,
  session_id TEXT,
  idx INTEGER,
  content TEXT NOT NULL,
  embedding TEXT DEFAULT '',
  created_at INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, chunk_id UNINDEXED, tokenize='trigram');
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT DEFAULT '新对话',
  agent_id TEXT,
  kb_ids TEXT DEFAULT '[]',
  model TEXT DEFAULT '',
  mode TEXT DEFAULT 'reasoning',
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  think TEXT DEFAULT '',
  refs TEXT DEFAULT '[]',
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  color TEXT DEFAULT '',
  system_prompt TEXT DEFAULT '',
  model TEXT DEFAULT '',
  kb_ids TEXT DEFAULT '[]',
  tools TEXT DEFAULT '[]',
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  name TEXT NOT NULL,
  mime TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  path TEXT NOT NULL,
  source TEXT DEFAULT 'upload',
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS tools (
  key TEXT PRIMARY KEY,
  enabled INTEGER DEFAULT 0,
  config TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT DEFAULT '',
  base_url TEXT DEFAULT '',
  api_key TEXT DEFAULT '',
  model_name TEXT DEFAULT '',
  is_default INTEGER DEFAULT 0,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_docs_kb ON documents(kb_id);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_kb ON chunks(kb_id);
CREATE INDEX IF NOT EXISTS idx_chunks_sess ON chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_msgs_sess ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON chat_sessions(user_id);
`);

export const getSetting = (key, fallback = '') => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
};
export const setSetting = (key, value) => {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
};

export function defaultModel(kind){
  const row = db.prepare('SELECT * FROM models WHERE kind = ? AND is_default = 1 ORDER BY created_at LIMIT 1').get(kind);
  if (row) return row;
  return db.prepare('SELECT * FROM models WHERE kind = ? ORDER BY created_at LIMIT 1').get(kind) || null;
}

export function seed(){
  const hasUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0;
  if (hasUsers) return;
  const ts = now();
  const u1 = $uuid(), u2 = $uuid();
  db.prepare('INSERT INTO users(id, email, name, password_hash, theme, created_at) VALUES(?,?,?,?,?,?)')
    .run(u1, 'lzy@example.com', 'lzy', hashPassword('password'), 'light', ts);
  db.prepare('INSERT INTO users(id, email, name, password_hash, theme, created_at) VALUES(?,?,?,?,?,?)')
    .run(u2, 'zhangwei@example.com', '张伟', hashPassword('password'), 'light', ts);

  const orgId = $uuid(), code = 'ORG-' + $uuid().slice(0, 6).toUpperCase();
  db.prepare('INSERT INTO orgs(id, name, description, owner_id, invite_code, created_at) VALUES(?,?,?,?,?,?)')
    .run(orgId, '产品与研发中心', '跨部门共享知识库与智能体的协作空间', u1, code, ts);
  const insMember = db.prepare('INSERT INTO org_members(org_id, user_id, role, joined_at) VALUES(?,?,?,?)');
  insMember.run(orgId, u1, 'owner', ts);
  insMember.run(orgId, u2, 'admin', ts);

  db.prepare('INSERT INTO tools(key, enabled, config) VALUES(?,?,?)').run('web-search', 0, '{}');
  db.prepare('INSERT INTO tools(key, enabled, config) VALUES(?,?,?)').run('mcp', 0, '{}');
  db.prepare('INSERT INTO tools(key, enabled, config) VALUES(?,?,?)').run('browser', 0, '{}');

  console.log('[seed] 演示数据已初始化：lzy@example.com / password');
}

export { ROOT };
