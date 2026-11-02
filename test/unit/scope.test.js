import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// service.js 默认检索会加载 SQLite；先指向临时目录，避免触碰仓库 data/。
process.env.EKH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-scope-test-'));
const { createKnowledgeService } = await import('../../server/knowledge/service.js');
const { KnowledgeForbiddenError } = await import('../../server/knowledge/errors.js');

function fakeStore({ visible = ['kb1', 'kb2'], docs = {}, sessions = {} } = {}){
  return {
    listVisibleKbIds: () => visible,
    listVisibleKbs: () => [],
    getDocument: id => docs[id] || null,
    getSession: id => sessions[id] || null,
  };
}

const actor = { userId: 'u1', tenantId: 't1', principalType: 'user' };

test('visible 模式只返回用户可见知识库', async () => {
  const svc = createKnowledgeService({ store: fakeStore(), retrieve: async () => ({ refs: [] }) });
  const scope = await svc.resolveScope({ actor, mode: 'visible' });
  assert.deepEqual(scope.kbIds, ['kb1', 'kb2']);
  assert.equal(scope.reducedCount, 0);
  assert.match(scope.scopeHash, /^[0-9a-f]{64}$/);
});

test('explicit 越权默认 403，降级模式只记录数量', async () => {
  const svc = createKnowledgeService({ store: fakeStore(), retrieve: async () => ({ refs: [] }) });
  await assert.rejects(
    () => svc.resolveScope({ actor, mode: 'explicit', kbIds: ['kb1', 'kb9'] }),
    e => e instanceof KnowledgeForbiddenError && e.status === 403,
  );
  const scope = await svc.resolveScope({
    actor, mode: 'explicit', kbIds: ['kb1', 'kb9'], onExplicitDenied: 'reduce',
  });
  assert.deepEqual(scope.kbIds, ['kb1']);
  assert.equal(scope.reducedCount, 1);
});

test('preset 与可见集合求交集，并受显式选择收窄', async () => {
  const svc = createKnowledgeService({ store: fakeStore(), retrieve: async () => ({ refs: [] }) });
  const preset = await svc.resolveScope({ actor, mode: 'preset', presetKbIds: ['kb1', 'kb9'] });
  assert.deepEqual(preset.kbIds, ['kb1']);
  assert.equal(preset.reducedCount, 1);

  const explicit = await svc.resolveScope({
    actor, mode: 'explicit', kbIds: ['kb1', 'kb2'], presetKbIds: ['kb1'],
  });
  assert.deepEqual(explicit.kbIds, ['kb1']);
  assert.equal(explicit.reducedCount, 1);
});

test('none 关闭范围；无权文档/会话被剔除且计数', async () => {
  const docs = {
    own: { id: 'own', owner_id: 'u1', deleted_at: null },
    foreign: { id: 'foreign', owner_id: 'u2', deleted_at: null },
    gone: { id: 'gone', owner_id: 'u1', deleted_at: 123 },
  };
  const sessions = { s1: { id: 's1', user_id: 'u1' }, s2: { id: 's2', user_id: 'u2' } };
  const svc = createKnowledgeService({
    store: fakeStore({ visible: [], docs, sessions }), retrieve: async () => ({ refs: [] }),
  });
  const none = await svc.resolveScope({ actor, mode: 'none', inputDocIds: ['own', 'foreign', 'gone'], sessionId: 's2' });
  assert.deepEqual(none.kbIds, []);
  assert.deepEqual(none.documentIds, ['own']);
  assert.equal(none.sessionId, null);
  assert.equal(none.reducedCount, 3);
});
