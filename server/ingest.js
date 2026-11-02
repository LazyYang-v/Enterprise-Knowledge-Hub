// 文档摄取管线：解析 → 分块 → 向量化（可配置）→ 版本化入库；进程内串行队列
import fs from 'node:fs';
import { db } from './db.js';
import { $uuid, now } from './util.js';
import { extractText, chunkText } from './parse.js';
import { embed } from './llm.js';
import { getModel } from './model-registry.js';
import { documentContentHash, chunkContentHash, buildLocators } from './knowledge/versioning.js';

const queue = [];
let running = false;

export function enqueue(docId, { force = false } = {}){
  const item = queue.find(q => q.docId === docId);
  if (item) item.force = item.force || !!force;
  else queue.push({ docId, force: !!force });
  process.nextTick(run);
}

async function run(){
  if (running) return;
  running = true;
  try {
    while (queue.length){
      const { docId, force } = queue.shift();
      try { await processDoc(docId, { force }); } catch (e){ console.error('[ingest]', docId, e.message); }
    }
  } finally { running = false; }
}

function markFailed(docId, message){
  db.prepare("UPDATE documents SET status = 'failed', progress = 0, error = ?, updated_at = ? WHERE id = ?")
    .run(message, now(), docId);
}

export async function processDoc(docId, { force = false } = {}){
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
  if (!doc || doc.deleted_at) return;
  db.prepare("UPDATE documents SET status = 'processing', progress = 5, error = '', updated_at = ? WHERE id = ?").run(now(), docId);

  let text = '', note = '';
  try {
    if (doc.kind === 'qa'){
      // 问答对文档：name 为问题，answer 列存答案
      text = `问题：${doc.name}\n回答：${doc.answer || ''}`;
    } else if (doc.path && fs.existsSync(doc.path)){
      db.prepare("UPDATE documents SET progress = 20 WHERE id = ?").run(docId);
      ({ text, note } = await extractText(doc.path, doc.ext));
    }
  } catch (e){
    markFailed(docId, e.message || '解析失败');
    throw e;
  }

  const chunks = doc.kind === 'qa' ? [text] : chunkText(text);
  const contentHash = documentContentHash(doc, text);

  // 内容未变：不重建，避免无意义地产生新版本。
  if (!force && doc.status === 'ready' && doc.content_hash && doc.content_hash === contentHash && Number(doc.chunk_count) > 0){
    db.prepare("UPDATE documents SET status = 'ready', progress = 100, updated_at = ? WHERE id = ?").run(now(), docId);
    return;
  }

  const maxRow = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM document_versions WHERE document_id = ?').get(docId);
  const maxVersion = Number(maxRow?.v) || 0;
  const baseVersion = Math.max(Number(doc.current_version) || 1, maxVersion);
  const changed = !!(doc.content_hash && doc.content_hash !== contentHash);
  const version = changed ? baseVersion + 1 : baseVersion;
  const startedAt = now();

  db.prepare(`
    INSERT INTO document_versions
      (id, document_id, version, content_hash, source_path, source_mtime, size_bytes,
       status, error, note, created_by, created_at, ready_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', '', '', ?, ?, NULL)
    ON CONFLICT(document_id, version) DO UPDATE SET
      content_hash = excluded.content_hash, source_path = excluded.source_path,
      source_mtime = excluded.source_mtime, size_bytes = excluded.size_bytes,
      status = 'processing', error = '', note = '', ready_at = NULL
  `).run(
    `${doc.id}:${version}`, doc.id, version, contentHash, doc.path || '',
    doc.path && fs.existsSync(doc.path) ? Math.floor(fs.statSync(doc.path).mtimeMs) : null,
    Number(doc.size) || 0, doc.owner_id || '', startedAt,
  );

  if (!chunks.length){
    const failed = doc.kind !== 'qa' && !note;
    const status = failed ? 'failed' : 'ready';
    const message = failed ? '未抽取到文本内容' : note;
    const ts = now();
    db.prepare("UPDATE document_versions SET status = ?, error = ?, note = ?, ready_at = ? WHERE document_id = ? AND version = ?")
      .run(status, message, note, status === 'ready' ? ts : null, docId, version);
    if (failed){
      db.prepare("UPDATE documents SET status = 'failed', progress = 0, error = ?, updated_at = ? WHERE id = ?")
        .run(message, ts, docId);
    } else {
      db.prepare("UPDATE documents SET current_version = ?, content_hash = ?, status = 'ready', progress = 100, chunk_count = 0, error = ?, updated_at = ? WHERE id = ?")
        .run(version, contentHash, note, ts, docId);
    }
    return;
  }

  // 向量化（若配置了 embedding 模型）
  let vectors = null;
  if (doc.kind !== 'qa'){
    const embedModel = getModel('embedding');
    if (embedModel){
      try {
        db.prepare("UPDATE documents SET progress = 60, error = '向量化中…' WHERE id = ?").run(docId);
        vectors = await embed(embedModel, chunks);
      } catch (e){
        console.error('[ingest] embedding failed:', e.message);
        vectors = null;
      }
    }
  }

  const locators = buildLocators(text, chunks);
  db.exec('BEGIN IMMEDIATE');
  try {
    // 只清理目标版本；旧版本 chunks 保留，供证据/引用回读。
    const old = db.prepare('SELECT id FROM chunks WHERE document_id = ? AND document_version = ?').all(docId, version);
    for (const c of old) db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(c.id);
    db.prepare('DELETE FROM chunks WHERE document_id = ? AND document_version = ?').run(docId, version);

    insertChunks(doc, chunks, { version, vectors, locators });
    const ts = now();
    db.prepare(`
      UPDATE documents SET current_version = ?, content_hash = ?, status = 'ready',
        progress = 100, chunk_count = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(version, contentHash, chunks.length, note, ts, docId);
    db.prepare("UPDATE document_versions SET content_hash = ?, status = 'ready', error = '', note = ?, ready_at = ? WHERE document_id = ? AND version = ?")
      .run(contentHash, note, ts, docId, version);
    db.exec('COMMIT');
  } catch (e){
    db.exec('ROLLBACK');
    markFailed(docId, e.message || '入库失败');
    throw e;
  }
}

export function insertChunks(doc, contents, { version = 1, startIdx = 0, vectors = null, locators = [] } = {}){
  const ts = now();
  const ins = db.prepare(`
    INSERT INTO chunks
      (id, document_id, kb_id, session_id, idx, content, embedding, created_at,
       document_version, content_hash, locator_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insFts = db.prepare('INSERT INTO chunks_fts(content, chunk_id) VALUES(?, ?)');
  for (let i = 0; i < contents.length; i++){
    const id = $uuid();
    const content = contents[i];
    const emb = vectors && vectors[i] ? JSON.stringify(vectors[i]) : '';
    const locator = locators[i] || { chunk_index: startIdx + i };
    ins.run(id, doc.id, doc.kb_id || null, doc.session_id || null, startIdx + i, content,
      emb, ts, version, chunkContentHash(content), JSON.stringify(locator));
    insFts.run(content, id);
  }
}
