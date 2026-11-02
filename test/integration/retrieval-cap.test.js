import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp } from '../helpers/app.js';

process.env.EKH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-retrieval-test-'));

test('P-02/C7：候选上限、topK 上限、FTS 范围与删除/状态过滤', async t => {
  const app = await startApp();
  t.after(() => app.close());
  const { db } = await import('../../server/db.js');
  const { retrieveScoped } = await import('../../server/knowledge/retrieval.js');

  const alice = await app.register('alice-cap@example.com', 'Alice');
  const kb1 = (await app.request('POST', '/api/kbs', { token: alice.token, body: { name: 'KB1' } })).data.kb;
  const kb2 = (await app.request('POST', '/api/kbs', { token: alice.token, body: { name: 'KB2' } })).data.kb;
  const bucket = fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-chunks-'));
  const ts = Date.now();

  function seedDoc(id, kbId, name, status = 'ready', deletedAt = null){
    db.prepare(`INSERT INTO documents(id, kb_id, owner_id, kind, name, status, chunk_count, current_version, content_hash, deleted_at, created_at, updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, kbId, alice.user.id, 'file', name, status, 0, 1, '', deletedAt, ts, ts);
  }
  function seedChunk(id, docId, kbId, idx, content){
    db.prepare('INSERT INTO chunks(id, document_id, kb_id, session_id, idx, content, embedding, created_at, document_version, content_hash, locator_json) VALUES(?,?,?,NULL,?,?,\'\',?,1,?,?)')
      .run(id, docId, kbId, idx, content, ts, '', JSON.stringify({ chunk_index: idx }));
    db.prepare('INSERT INTO chunks_fts(content, chunk_id) VALUES(?,?)').run(content, id);
  }

  // 100 条 KB1 候选；其中 30 条含检索词 common。
  seedDoc('d-bulk', kb1.id, 'bulk.txt');
  for (let i = 0; i < 100; i++){
    seedChunk(`c-bulk-${i}`, 'd-bulk', kb1.id, i, `common 片段 ${i} ${'x'.repeat(20)}`);
  }
  // 范围外：KB2 的同名关键词；已删除；处理中。
  seedDoc('d-other', kb2.id, 'other.txt');
  seedChunk('c-other', 'd-other', kb2.id, 0, 'SECRETBETA-TOKEN 其他知识库');
  seedDoc('d-deleted', kb1.id, 'deleted.txt', 'ready', ts);
  seedChunk('c-deleted', 'd-deleted', kb1.id, 0, 'DELETED-TOKEN 已删除');
  seedDoc('d-processing', kb1.id, 'processing.txt', 'processing');
  seedChunk('c-processing', 'd-processing', kb1.id, 0, 'PROCESSING-TOKEN 处理中');

  // 候选上限：没有关键词命中时只取 cap 行。
  const capped = await retrieveScoped({ kbIds: [kb1.id], query: 'zzz-nomatch', topK: 5, candidateCap: 7 });
  assert.equal(capped.candidateCapped, true);
  assert.equal(capped.candidateCount, 7);
  assert.equal(capped.refs.length, 0);

  // topK 上限 20。
  const many = await retrieveScoped({ kbIds: [kb1.id], query: 'common', topK: 100, topKMax: 20, candidateCap: 500 });
  assert.ok(many.refs.length <= 20);
  assert.ok(many.refs.length > 0);

  // FTS 不越界：KB2 内容在 KB1 范围内检索不到。
  const scoped = await retrieveScoped({ kbIds: [kb1.id], query: 'SECRETBETA-TOKEN', topK: 5 });
  assert.equal(scoped.refs.filter(r => r.document_id === 'd-other').length, 0);
  assert.equal(scoped.refs.length, 0);

  // 删除/处理中的文档不进入结果。
  const deleted = await retrieveScoped({ kbIds: [kb1.id], query: 'DELETED-TOKEN', topK: 5 });
  assert.equal(deleted.refs.length, 0);
  const processing = await retrieveScoped({ kbIds: [kb1.id], query: 'PROCESSING-TOKEN', topK: 5 });
  assert.equal(processing.refs.length, 0);

  // 关键词命中但落在候选上限外也能补回（d-bulk 时间最早，若 cap 很小仍应命中）。
  seedDoc('d-old', kb1.id, 'old.txt');
  seedChunk('c-old', 'd-old', kb1.id, 0, 'RAREKEY-TOKEN 早期文档');
  db.prepare('UPDATE chunks SET created_at = ? WHERE id = ?').run(ts - 10000, 'c-old');
  const backfilled = await retrieveScoped({ kbIds: [kb1.id], query: 'RAREKEY-TOKEN', topK: 5, candidateCap: 3 });
  assert.equal(backfilled.candidateCapped, true);
  assert.ok(backfilled.refs.some(r => r.chunk_id === 'c-old'));
});
