import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp } from '../helpers/app.js';

process.env.AGENT_PLATFORM_ENABLED = '1';

async function waitReady(app, token, kbId, version = null){
  return app.waitFor(async () => {
    const r = await app.request('GET', `/api/kbs/${kbId}/documents`, { token });
    const doc = r.data?.docs?.find(d => d.status === 'ready' && d.progress === 100);
    if (!doc) return null;
    if (version != null && doc.current_version !== version) return null;
    return doc;
  }, { timeout: 10000 });
}

test('G9/Q-04：重解析生成新版本、旧分块保留、软删除后引用仍可回读', async t => {
  const app = await startApp();
  t.after(() => app.close());
  const alice = await app.register('alice-version@example.com', 'Alice');
  const kb = (await app.request('POST', '/api/kbs', { token: alice.token, body: { name: '版本库' } })).data.kb;
  const qa = await app.request('POST', `/api/kbs/${kb.id}/qa`, {
    token: alice.token, body: { question: '政策版本', answer: 'OLD7F3K9 旧版内容' },
  });
  const docId = qa.data.id;
  const v1 = await waitReady(app, alice.token, kb.id, 1);
  assert.equal(v1.current_version, 1);
  assert.ok(v1.content_hash);

  const { db } = await import('../../server/db.js');
  db.prepare("UPDATE documents SET answer = 'NEW2M8P4 新版内容' WHERE id = ?").run(docId);
  const reparse = await app.request('POST', `/api/documents/${docId}/reparse`, { token: alice.token });
  assert.equal(reparse.status, 200);
  const v2 = await waitReady(app, alice.token, kb.id, 2);
  assert.equal(v2.current_version, 2);
  assert.notEqual(v2.content_hash, v1.content_hash);

  // 历史版本仍可读取，旧 chunks 未被删除。
  const old = await app.request('GET', `/api/documents/${docId}?version=1`, { token: alice.token });
  assert.equal(old.status, 200);
  assert.equal(old.data.version, 1);
  assert.equal(old.data.chunks.length, 1);
  assert.match(old.data.chunks[0].content, /OLD7F3K9/);
  assert.ok(old.data.chunks[0].content_hash);

  const current = await app.request('GET', `/api/documents/${docId}`, { token: alice.token });
  assert.equal(current.data.version, 2);
  assert.match(current.data.chunks[0].content, /NEW2M8P4/);

  const versions = db.prepare('SELECT version, status FROM document_versions WHERE document_id = ? ORDER BY version').all(docId);
  assert.deepEqual(versions.map(v => v.version), [1, 2]);
  assert.deepEqual(versions.map(v => v.status), ['ready', 'ready']);

  // 默认检索只命中当前版本。
  const newSearch = await app.request('POST', '/api/knowledge/search', {
    token: alice.token, body: { query: 'NEW2M8P4', kb_ids: [kb.id] },
  });
  assert.equal(newSearch.status, 200);
  assert.equal(newSearch.data.evidence.length, 1);
  assert.equal(newSearch.data.evidence[0].document_version, 2);
  const oldSearch = await app.request('POST', '/api/knowledge/search', {
    token: alice.token, body: { query: 'OLD7F3K9', kb_ids: [kb.id] },
  });
  assert.equal(oldSearch.data.evidence.length, 0);

  // 内容未变化时 force reparse 不产生新版本。
  await app.request('POST', `/api/documents/${docId}/reparse`, { token: alice.token });
  await new Promise(r => setTimeout(r, 300));
  const stillTwo = db.prepare('SELECT current_version FROM documents WHERE id = ?').get(docId);
  assert.equal(stillTwo.current_version, 2);

  // 软删除：列表/检索/读取排除，但历史 chunks 与版本仍保留。
  const del = await app.request('DELETE', `/api/documents/${docId}`, { token: alice.token });
  assert.equal(del.status, 200);
  assert.equal((await app.request('GET', `/api/documents/${docId}`, { token: alice.token })).status, 404);
  const afterDelete = await app.request('POST', '/api/knowledge/search', {
    token: alice.token, body: { query: 'NEW2M8P4', kb_ids: [kb.id] },
  });
  assert.equal(afterDelete.data.evidence.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM chunks WHERE document_id = ?').get(docId).c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM document_versions WHERE document_id = ?').get(docId).c, 2);
});
