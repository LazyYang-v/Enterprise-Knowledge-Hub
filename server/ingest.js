// 文档摄取管线：解析 → 分块 → 向量化（可配置）→ 入库；进程内串行队列
import fs from 'node:fs';
import { db, getSetting } from './db.js';
import { $uuid, now } from './util.js';
import { extractText, chunkText } from './parse.js';
import { embed } from './llm.js';
import { getModel } from './model-registry.js';

const queue = [];
let running = false;

export function enqueue(docId){
  if (!queue.includes(docId)) queue.push(docId);
  process.nextTick(run);
}

async function run(){
  if (running) return;
  running = true;
  try {
    while (queue.length){
      const docId = queue.shift();
      try { await processDoc(docId); } catch (e){ console.error('[ingest]', docId, e.message); }
    }
  } finally { running = false; }
}

export async function processDoc(docId){
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
  if (!doc) return;
  db.prepare("UPDATE documents SET status = 'processing', progress = 5, error = '', updated_at = ? WHERE id = ?").run(now(), docId);

  // 清理旧 chunks（重建知识）
  const old = db.prepare('SELECT id FROM chunks WHERE document_id = ?').all(docId);
  for (const c of old){
    db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(c.id);
  }
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(docId);

  let text = '', note = '';
  if (doc.kind === 'qa'){
    // 问答对文档：name 为问题，answer 列存答案
    text = `问题：${doc.name}\n回答：${doc.answer || ''}`;
  } else if (doc.path && fs.existsSync(doc.path)){
    db.prepare("UPDATE documents SET progress = 20 WHERE id = ?").run(docId);
    ({ text, note } = await extractText(doc.path, doc.ext));
  }

  const chunks = doc.kind === 'qa' ? [text] : chunkText(text);
  if (!chunks.length){
    const failed = doc.kind !== 'qa' && !note;
    db.prepare("UPDATE documents SET status = ?, progress = ?, error = ?, chunk_count = 0, updated_at = ? WHERE id = ?")
      .run(failed ? 'failed' : 'ready', failed ? 0 : 100, failed ? '未抽取到文本内容' : note, now(), docId);
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

  insertChunks(doc, chunks, 0, vectors);
  db.prepare("UPDATE documents SET status = 'ready', progress = 100, chunk_count = ?, error = ?, updated_at = ? WHERE id = ?")
    .run(chunks.length, note, now(), docId);
}

export function insertChunks(doc, contents, startIdx = 0, vectors = null){
  const ts = now();
  const ins = db.prepare('INSERT INTO chunks(id, document_id, kb_id, session_id, idx, content, embedding, created_at) VALUES(?,?,?,?,?,?,?,?)');
  const insFts = db.prepare('INSERT INTO chunks_fts(content, chunk_id) VALUES(?, ?)');
  for (let i = 0; i < contents.length; i++){
    const id = $uuid();
    const emb = vectors && vectors[i] ? JSON.stringify(vectors[i]) : '';
    ins.run(id, doc.id, doc.kb_id || null, doc.session_id || null, startIdx + i, contents[i], emb, ts);
    insFts.run(contents[i], id);
  }
}
