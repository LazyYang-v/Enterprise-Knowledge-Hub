import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers/app.js';

process.env.AGENT_PLATFORM_ENABLED = '1';

async function waitReady(app, token, kbId){
  return app.waitFor(async () => {
    const r = await app.request('GET', `/api/kbs/${kbId}/documents`, { token });
    return r.data?.docs?.find(d => d.status === 'ready');
  }, { timeout: 10000 });
}

test('S-01/G1：知识 API、会话与 Agent 都按用户可见集合求交集', async t => {
  const app = await startApp();
  t.after(() => app.close());
  const alice = await app.register('alice-acl@example.com', 'Alice');
  const bob = await app.register('bob-acl@example.com', 'Bob');

  const kbA = (await app.request('POST', '/api/kbs', { token: alice.token, body: { name: 'Alice KB' } })).data.kb;
  await app.request('POST', `/api/kbs/${kbA.id}/qa`, {
    token: alice.token, body: { question: '机密等级', answer: 'ALPHA9QK 机密等级 A' },
  });
  const docA = await waitReady(app, alice.token, kbA.id);

  const kbB = (await app.request('POST', '/api/kbs', { token: bob.token, body: { name: 'Bob KB' } })).data.kb;
  await app.request('POST', `/api/kbs/${kbB.id}/qa`, {
    token: bob.token, body: { question: '公开信息', answer: 'BETA4ZX 公开信息' },
  });
  await waitReady(app, bob.token, kbB.id);

  // 显式越权：403，且错误中不返回片段。
  const denied = await app.request('POST', '/api/knowledge/search', {
    token: bob.token, body: { query: 'ALPHA-TOKEN', kb_ids: [kbA.id] },
  });
  assert.equal(denied.status, 403);
  assert.equal(JSON.stringify(denied.data).includes('ALPHA-TOKEN'), false);

  // 所有者检索命中，引用字段完整。
  const ok = await app.request('POST', '/api/knowledge/search', {
    token: alice.token, body: { query: 'ALPHA-TOKEN', kb_ids: [kbA.id], top_k: 5 },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.evidence.length >= 1);
  const ev = ok.data.evidence[0];
  for (const key of ['document_id', 'document_version', 'chunk_id', 'content_hash', 'title', 'locator', 'excerpt', 'retrieved_at', 'untrusted']){
    assert.ok(key in ev, `引用缺少字段 ${key}`);
  }
  assert.equal(ev.document_version, 1);
  assert.equal(ev.untrusted, true);
  assert.equal(ev.evidence_id, null);

  // visible 模式只返回自己的 KB。
  const bobVisible = await app.request('POST', '/api/knowledge/search', {
    token: bob.token, body: { query: 'ALPHA9QK', mode: 'visible' },
  });
  assert.equal(bobVisible.status, 200);
  assert.equal(bobVisible.data.evidence.filter(e => e.kb_id === kbA.id).length, 0);
  assert.ok(bobVisible.data.effective_kb_ids.includes(kbB.id));
  assert.equal(bobVisible.data.effective_kb_ids.includes(kbA.id), false);

  // 旧 /api/retrieve 保持 JSON 形状并执行同样的 ACL。
  const retDenied = await app.request('POST', '/api/retrieve', {
    token: bob.token, body: { query: 'ALPHA-TOKEN', kb_ids: [kbA.id] },
  });
  assert.equal(retDenied.status, 403);
  const retOk = await app.request('POST', '/api/retrieve', {
    token: alice.token, body: { query: 'ALPHA-TOKEN', kb_ids: [kbA.id] },
  });
  assert.equal(retOk.status, 200);
  assert.deepEqual(Object.keys(retOk.data).sort(), ['kb_ids', 'query', 'refs']);
  assert.ok(retOk.data.refs.length >= 1);
  assert.equal(retOk.data.refs[0].document_version, 1);

  // 会话绑定不可见 KB → 403。
  const bindDenied = await app.request('POST', '/api/sessions', {
    token: bob.token, body: { kb_ids: [kbA.id] },
  });
  assert.equal(bindDenied.status, 403);

  // 绕过写入校验直接落库（模拟历史脏数据）后，聊天仍不得检索 ALPHA。
  const { db } = await import('../../server/db.js');
  const bobSession = await app.request('POST', '/api/sessions', { token: bob.token, body: {} });
  db.prepare('UPDATE chat_sessions SET kb_ids = ? WHERE id = ?')
    .run(JSON.stringify([kbA.id]), bobSession.data.session.id);
  const chat = await app.postSse(`/api/sessions/${bobSession.data.session.id}/chat`, {
    token: bob.token, body: { message: 'ALPHA9QK 是什么？' },
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.events.find(e => e.type === 'retrieved')?.count, 0);
  const done = chat.events.find(e => e.type === 'done');
  assert.equal(String(done?.message?.content || '').includes('ALPHA9QK'), false);

  // Agent 同样：历史越权绑定不能泄露。
  const agentId = 'agent-leak';
  db.prepare(`INSERT INTO agents(id, owner_id, name, description, color, system_prompt, model, kb_ids, tools, created_at, updated_at)
              VALUES(?,?,?,'','','','',?,'[]',?,?)`)
    .run(agentId, bob.user.id, '越权 Agent', JSON.stringify([kbA.id]), Date.now(), Date.now());
  const agentSession = await app.request('POST', '/api/sessions', {
    token: bob.token, body: { agent_id: agentId },
  });
  assert.equal(agentSession.status, 200);
  const agentChat = await app.postSse(`/api/sessions/${agentSession.data.session.id}/chat`, {
    token: bob.token, body: { message: 'ALPHA9QK 是什么？' },
  });
  assert.equal(agentChat.events.find(e => e.type === 'retrieved')?.count, 0);

  // Agent 写入时直接拒绝不可见 KB。
  const agentDenied = await app.request('POST', '/api/agents', {
    token: bob.token, body: { name: '坏 Agent', kb_ids: [kbA.id] },
  });
  assert.equal(agentDenied.status, 403);
});
