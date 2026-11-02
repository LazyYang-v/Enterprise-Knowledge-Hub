import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureSchema, createTenant, canUseTestDatabase, getEvents, closeTestDb,
} from '../helpers/pg.js';
import { startFakeModel } from '../helpers/fake-model.js';
import { getPool } from '../../server/control/pg.js';
import { TaskService } from '../../server/control/task-service.js';
import { claimNextTask } from '../../server/control/task-repo.js';
import { executeTask } from '../../server/control/task-executor.js';
import { getPreset } from '../../server/control/preset-repo.js';
import {
  insertEvidenceSnapshots, getPinnedVersions,
} from '../../server/control/evidence-repo.js';

const { db } = await import('../../server/db.js');
const { createTaskKnowledgeResolver } = await import('../../server/knowledge/task-context.js');
const { getKnowledgeService } = await import('../../server/knowledge/index.js');
const { createSkillRegistry } = await import('../../server/skills/registry.js');
const { hashText } = await import('../../server/knowledge/versioning.js');

const skip = !canUseTestDatabase();
const ROOT = path.resolve(import.meta.dirname, '../../skills');

function seedSqlite(){
  const ts = Date.now();
  const insKb = db.prepare('INSERT INTO knowledge_bases(id, name, description, owner_id, created_at, updated_at) VALUES(?,?,?,?,?,?)');
  insKb.run('kb-a', 'KB A', '', 'user-a', ts, ts);
  insKb.run('kb-b', 'KB B', '', 'user-b', ts, ts);

  db.prepare(`INSERT INTO documents(id, kb_id, owner_id, kind, name, status, chunk_count, current_version, content_hash, created_at, updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run('d-a', 'kb-a', 'user-a', 'file', 'A.txt', 'ready', 2, 2, hashText('v2'), ts, ts);
  const insChunk = db.prepare(`INSERT INTO chunks(id, document_id, kb_id, idx, content, embedding, created_at, document_version, content_hash, locator_json)
                               VALUES(?,?,?,?,?,'',?,?,?,?)`);
  insChunk.run('c-a1', 'd-a', 'kb-a', 0, 'PINNEDWORD 旧版本内容', ts - 10, 1, hashText('old'), JSON.stringify({ chunk_index: 0 }));
  insChunk.run('c-a2', 'd-a', 'kb-a', 1, 'PINNEDWORD 新版本内容', ts, 2, hashText('new'), JSON.stringify({ chunk_index: 1 }));
  db.prepare('INSERT INTO chunks_fts(content, chunk_id) VALUES(?,?)').run('PINNEDWORD 旧版本内容', 'c-a1');
  db.prepare('INSERT INTO chunks_fts(content, chunk_id) VALUES(?,?)').run('PINNEDWORD 新版本内容', 'c-a2');
}

test('P0-3 任务范围、证据快照、引用与 Skill', { skip }, async t => {
  await ensureSchema();
  const tenantId = await createTenant('p03');
  const resolver = createTaskKnowledgeResolver();
  const service = new TaskService({
    getPreset,
    resolveKnowledgeScope: resolver.resolveTaskKnowledge,
    assertInputDocs: resolver.assertInputDocs,
    selectSkill: null,
  });
  seedSqlite();
  t.after(async () => { await closeTestDb(); });

  await t.test('显式范围写入快照；越权 403', async () => {
    const task = await service.createTask({
      tenantId, ownerId: 'user-a', goal: '研究制度',
      input: { kb_scope: { mode: 'explicit', kb_ids: ['kb-a'] } },
    });
    const k = task.input_json.knowledge;
    assert.deepEqual(k.effective_kb_ids, ['kb-a']);
    assert.deepEqual(k.requested_kb_ids, ['kb-a']);
    assert.equal(k.version_policy, 'pin_on_first_use');
    assert.equal(k.reduced_count, 0);
    assert.match(k.scope_hash, /^[0-9a-f]{64}$/);
    const types = (await getEvents(tenantId, task.id)).map(e => e.type);
    assert.deepEqual(types, ['task.created', 'task.queued']);

    await assert.rejects(() => service.createTask({
      tenantId, ownerId: 'user-a', goal: '越权',
      input: { kb_scope: { mode: 'explicit', kb_ids: ['kb-b'] } },
    }), e => e.code === 'forbidden' && e.status === 403);
  });

  await t.test('预设范围只保留交集，事件不包含不可见 KB ID', async () => {
    const preset = await getPool().query(
      `INSERT INTO agent_presets (tenant_id, owner_id, name, default_kb_ids, status)
       VALUES ($1, 'user-a', '研究预设', $2::jsonb, 'active') RETURNING *`,
      [tenantId, JSON.stringify(['kb-a', 'kb-b'])],
    );
    const task = await service.createTask({
      tenantId, ownerId: 'user-a', goal: '按预设研究',
      input: { preset_id: preset.rows[0].id },
    });
    assert.equal(task.preset_id, preset.rows[0].id);
    assert.equal(task.preset_version, 1);
    assert.deepEqual(task.input_json.knowledge.effective_kb_ids, ['kb-a']);
    assert.equal(task.input_json.knowledge.reduced_count, 1);

    const events = await getEvents(tenantId, task.id);
    assert.deepEqual(events.map(e => e.type), ['task.created', 'policy.scope_reduced', 'task.queued']);
    const reduced = events[1];
    assert.deepEqual(reduced.payload, { reduced_count: 1, source: 'preset' });
    assert.equal(JSON.stringify(reduced.payload).includes('kb-b'), false);
  });

  await t.test('证据快照幂等、固定版本检索与最新版本检索', async () => {
    await getPool().query(
      `INSERT INTO agent_presets (tenant_id, owner_id, name, default_kb_ids, status)
       VALUES ($1, 'user-a', '证据预设', '[]'::jsonb, 'active')`,
      [tenantId],
    );
    const task = await service.createTask({
      tenantId, ownerId: 'user-a', goal: '证据任务',
      input: { kb_scope: { mode: 'explicit', kb_ids: ['kb-a'] } },
    });
    const item = {
      kb_id: 'kb-a', document_id: 'd-a', document_version: 1, chunk_id: 'c-a1',
      content_hash: hashText('old'), locator_json: { chunk_index: 0 },
      excerpt: 'PINNEDWORD 旧版本内容', score: 0.5, title: 'A.txt', kb_name: 'KB A',
    };
    const first = await insertEvidenceSnapshots({ tenantId, taskId: task.id, items: [item] });
    const second = await insertEvidenceSnapshots({ tenantId, taskId: task.id, items: [item] });
    assert.equal(first[0].inserted, true);
    assert.equal(second[0].inserted, false);
    assert.equal(first[0].row.id, second[0].row.id);

    const pinned = await getPinnedVersions({ tenantId, taskId: task.id });
    assert.deepEqual(pinned, { 'd-a': 1 });

    const svc = getKnowledgeService();
    const actor = { userId: 'user-a', tenantId, principalType: 'user' };
    const pinnedResult = await svc.search({
      actor, taskId: task.id, query: 'PINNEDWORD',
      scope: {
        mode: 'explicit', kbIds: ['kb-a'], documentIds: [], sessionId: null,
        versionPolicy: 'pin_on_first_use', reducedCount: 0,
      },
    });
    assert.ok(pinnedResult.evidence.length >= 1);
    assert.ok(pinnedResult.evidence.every(e => e.document_version === 1));
    assert.equal(pinnedResult.evidence[0].evidence_id, first[0].row.id);
    assert.equal(pinnedResult.newEvidence.length, 0);

    const latest = await svc.search({
      actor, query: 'PINNEDWORD',
      scope: {
        mode: 'explicit', kbIds: ['kb-a'], documentIds: [], sessionId: null,
        versionPolicy: 'latest', reducedCount: 0,
      },
    });
    assert.ok(latest.evidence.length >= 1);
    assert.ok(latest.evidence.every(e => e.document_version === 2));

    // 任务所有者可按 evidence_id 回读引用；其他用户不可见。
    const row = await svc.getCitation(actor, first[0].row.id);
    assert.equal(row.citation.document_version, 1);
    assert.equal(row.superseded, true);
    assert.equal(row.document_deleted, false);
  });

  await t.test('Skill reload、可选性、版本固定与同版本内容变更拒绝', async () => {
    const registry = createSkillRegistry({ skillsDir: ROOT });
    const first = await registry.reload();
    assert.equal(first.loaded, 2);
    assert.deepEqual(first.errors, []);
    const again = await registry.reload();
    assert.equal(again.loaded, 2);
    assert.equal(again.inserted, 0);

    const list = await registry.list();
    const kr = list.find(s => s.name === 'knowledge-research');
    const sa = list.find(s => s.name === 'spreadsheet-audit');
    assert.equal(kr.selectable, true);
    assert.equal(sa.selectable, true);
    assert.equal(sa.unavailable_reason, null);
    assert.equal(sa.version, '1.1.0');

    const selected = await registry.select({ tenantId, skillRef: 'knowledge-research' });
    assert.equal(selected.name, 'knowledge-research');
    const spreadsheet = await registry.select({ tenantId, skillRef: 'spreadsheet-audit' });
    assert.equal(spreadsheet.version, '1.1.0');

    const loaded = await registry.loadInstructions({
      skillId: selected.skill_id, version: selected.version, contentHash: selected.content_hash,
    });
    assert.match(loaded.instructions, /Knowledge Research/);
    await assert.rejects(() => registry.loadInstructions({
      skillId: selected.skill_id, version: selected.version, contentHash: 'deadbeef',
    }), e => e.code === 'skill_version_conflict');

    // 同版本内容变化：reload 拒绝，旧行保留。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-skills-pg-'));
    fs.cpSync(ROOT, tmp, { recursive: true });
    const tmpRegistry = createSkillRegistry({ skillsDir: tmp });
    assert.equal((await tmpRegistry.reload()).loaded, 2);
    fs.appendFileSync(path.join(tmp, 'knowledge-research', 'SKILL.md'), '\n未升版本的内容变更。\n');
    const conflict = await tmpRegistry.reload();
    assert.ok(conflict.errors.some(e => e.code === 'skill_version_conflict' && e.dir === 'knowledge-research'));
    const kept = (await tmpRegistry.list()).find(s => s.name === 'knowledge-research');
    assert.equal(kept.content_hash, selected.content_hash);
  });

  await t.test('finish.citations 必须是本任务证据；未知 ID 不进入 completed', async () => {
    // 隔离队列：前面只验证创建/快照，不执行的任务统一取消。
    await getPool().query(
      `UPDATE agent_tasks SET status = 'cancelled', cancelled_by = 'test_cleanup', version = version + 1
        WHERE tenant_id = $1 AND status = 'queued'`,
      [tenantId],
    );
    const noScope = await service.createTask({
      tenantId, ownerId: 'user-a', goal: '引用校验',
      input: { kb_scope: { mode: 'none' } },
    });
    const claimed = await claimNextTask({ workerId: 'w-citation', leaseTtlMs: 5000 });
    assert.equal(claimed.id, noScope.id);
    const evidence = await insertEvidenceSnapshots({
      tenantId, taskId: noScope.id, leaseEpoch: claimed.lease_epoch,
      items: [{
        kb_id: 'kb-a', document_id: 'd-a', document_version: 1, chunk_id: 'c-a1',
        content_hash: hashText('old'), locator_json: { chunk_index: 0 },
        excerpt: '引用内容', score: 0.9, title: 'A.txt', kb_name: 'KB A',
      }],
    });
    const evidenceId = evidence[0].row.id;

    const okModel = await startFakeModel(() => JSON.stringify({
      type: 'finish', summary: '完成', artifact_refs: [], citations: [evidenceId],
    }));
    const result = await executeTask(claimed, { workerId: 'w-citation', model: okModel });
    assert.equal(result.status, 'completed');
    const events = await getEvents(tenantId, noScope.id);
    const completed = events.find(e => e.type === 'task.completed');
    assert.deepEqual(completed.payload.citations, [evidenceId]);
    await okModel.close();

    const badTask = await service.createTask({
      tenantId, ownerId: 'user-a', goal: '错误引用',
      input: { kb_scope: { mode: 'none' } },
    });
    const badModel = await startFakeModel(() => JSON.stringify({
      type: 'finish', summary: '完成', artifact_refs: [],
      citations: ['00000000-0000-4000-8000-000000000000'],
    }));
    const claimedBad = await claimNextTask({ workerId: 'w-bad-citation', leaseTtlMs: 5000 });
    assert.equal(claimedBad.id, badTask.id);
    await assert.rejects(
      () => executeTask(claimedBad, { workerId: 'w-bad-citation', model: badModel }),
      e => e.code === 'model_invalid_output' && e.retryable === true,
    );
    const status = await getPool().query('SELECT status FROM agent_tasks WHERE tenant_id = $1 AND id = $2', [tenantId, badTask.id]);
    assert.equal(status.rows[0].status, 'running');
    await badModel.close();
  });

  await t.test('TaskService 选择 Skill 时写入冻结摘要与事件', async () => {
    const registry = createSkillRegistry({ skillsDir: ROOT });
    const withSkill = new TaskService({
      getPreset,
      resolveKnowledgeScope: resolver.resolveTaskKnowledge,
      assertInputDocs: resolver.assertInputDocs,
      selectSkill: opts => registry.select(opts),
    });
    const task = await withSkill.createTask({
      tenantId, ownerId: 'user-a', goal: '带技能的任务',
      input: { kb_scope: { mode: 'none' }, skill: 'knowledge-research' },
    });
    assert.equal(task.input_json.skill.name, 'knowledge-research');
    assert.match(task.input_json.skill.content_hash, /^[0-9a-f]{64}$/);
    const types = (await getEvents(tenantId, task.id)).map(e => e.type);
    assert.ok(types.includes('skill.selected'));

    const withSpreadsheet = await withSkill.createTask({
      tenantId, ownerId: 'user-a', goal: '表格审计技能',
      input: { kb_scope: { mode: 'none' }, skill: 'spreadsheet-audit' },
    });
    assert.equal(withSpreadsheet.input_json.skill.name, 'spreadsheet-audit');
    assert.equal(withSpreadsheet.input_json.skill.version, '1.1.0');

    await assert.rejects(() => withSkill.createTask({
      tenantId, ownerId: 'user-a', goal: '不存在的技能',
      input: { kb_scope: { mode: 'none' }, skill: 'no-such-skill' },
    }), e => e.status === 422);
  });
});
