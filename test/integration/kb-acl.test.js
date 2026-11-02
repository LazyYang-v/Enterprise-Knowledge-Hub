import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers/app.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.close(); });

test('私有知识库不跨用户可见，检索越权返回 403', async () => {
  const alice = await app.register('acl-alice@example.com', 'Alice');
  const bob = await app.register('acl-bob@example.com', 'Bob');

  const created = await app.request('POST', '/api/kbs', {
    token: bob.token,
    body: { name: 'Bob 私有制度库', description: '仅 Bob 可见' },
  });
  assert.equal(created.status, 200);
  const kbId = created.data.kb.id;

  const aliceList = await app.request('GET', '/api/kbs', { token: alice.token });
  assert.equal(aliceList.status, 200);
  assert.ok(!aliceList.data.kbs.some(k => k.id === kbId), 'Alice 不应看到 Bob 的知识库');

  const bobList = await app.request('GET', '/api/kbs', { token: bob.token });
  assert.ok(bobList.data.kbs.some(k => k.id === kbId));

  const denied = await app.request('GET', `/api/kbs/${kbId}`, { token: alice.token });
  assert.equal(denied.status, 403);

  const retrieveDenied = await app.request('POST', '/api/retrieve', {
    token: alice.token,
    body: { query: '制度', kb_ids: [kbId] },
  });
  assert.equal(retrieveDenied.status, 403);

  const retrieveDefault = await app.request('POST', '/api/retrieve', {
    token: alice.token,
    body: { query: '制度' },
  });
  assert.equal(retrieveDefault.status, 200);
  assert.deepEqual(retrieveDefault.data.kb_ids, []);
});

test('文档读取同样受知识库 ACL 约束', async () => {
  const alice = await app.register('doc-alice@example.com', 'Alice');
  const bob = await app.register('doc-bob@example.com', 'Bob');

  const kb = await app.request('POST', '/api/kbs', { token: bob.token, body: { name: 'Bob 文档库' } });
  const kbId = kb.data.kb.id;

  const qa = await app.request('POST', `/api/kbs/${kbId}/qa`, {
    token: bob.token,
    body: { question: '采购限额是多少？', answer: '采购限额为人民币 888 万元。' },
  });
  assert.equal(qa.status, 200);
  const docId = qa.data.id;

  const ready = await app.waitFor(async () => {
    const r = await app.request('GET', `/api/documents/${docId}`, { token: bob.token });
    return r.data?.doc?.status === 'ready' ? r : null;
  });
  assert.ok(ready.data.chunks.length > 0);
  assert.ok(ready.data.chunks[0].content.includes('888'));

  const denied = await app.request('GET', `/api/documents/${docId}`, { token: alice.token });
  assert.equal(denied.status, 403);
});
