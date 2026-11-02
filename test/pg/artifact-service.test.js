import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ensureSchema, createTenant, canUseTestDatabase, closeTestDb, getEvents,
} from '../helpers/pg.js';
import { getPool } from '../../server/control/pg.js';
import { TaskService } from '../../server/control/task-service.js';
import { createArtifactService, ArtifactError } from '../../server/artifacts/service.js';
import { listArtifacts, getArtifactWithBlob, countTaskArtifacts } from '../../server/control/artifact-repo.js';
import { canonicalBlobPath } from '../../server/artifacts/paths.js';

const skip = !canUseTestDatabase();

test('P0-5 成果仓储：去重、版本、ref_count、上传与软删除/GC', { skip }, async t => {
  await ensureSchema();
  const tenantId = await createTenant('p05-artifacts');
  const ownerId = 'artifact-owner';
  const service = createArtifactService();
  const ts = new TaskService();
  t.after(async () => { await closeTestDb(); });

  const task = await ts.createTask({ tenantId, ownerId, goal: '生成成果' });
  const otherTask = await ts.createTask({ tenantId, ownerId, goal: '另一个任务' });

  await t.test('同名同内容复用；同名不同内容升版本；不同名共享 blob', async () => {
    const a = await service.ingest({
      tenantId, taskId: task.id, name: '摘要.md', buffer: Buffer.from('# 摘要\n内容'),
      mime: 'text/markdown', createdBy: `tool:call-1`,
    });
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.equal(a.version, 1);
    const again = await service.ingest({
      tenantId, taskId: task.id, name: '摘要.md', buffer: Buffer.from('# 摘要\n内容'),
      mime: 'text/markdown', createdBy: `tool:call-2`,
    });
    assert.equal(again.id, a.id, '同内容应复用');
    assert.equal(again.version, 1);

    const v2 = await service.ingest({
      tenantId, taskId: task.id, name: '摘要.md', buffer: Buffer.from('# 摘要\n更新'),
      mime: 'text/markdown', createdBy: `tool:call-3`,
    });
    assert.equal(v2.version, 2);

    const copy = await service.ingest({
      tenantId, taskId: task.id, name: '副本.md', buffer: Buffer.from('# 摘要\n内容'),
      mime: 'text/markdown', createdBy: `tool:call-4`,
    });
    assert.notEqual(copy.id, a.id);

    const rows = await getPool().query(
      'SELECT blob_id FROM artifacts WHERE tenant_id = $1 AND task_id = $2 AND id = ANY($3::uuid[])',
      [tenantId, task.id, [a.id, copy.id]],
    );
    assert.equal(rows.rows[0].blob_id, rows.rows[1].blob_id, '同内容共享 blob');
    const blob = await getPool().query('SELECT ref_count FROM artifact_blobs WHERE id = $1', [rows.rows[0].blob_id]);
    assert.equal(Number(blob.rows[0].ref_count), 2);

    const list = await service.list({ tenantId, taskId: task.id });
    assert.equal(list.length, 3);
    assert.ok(list.every(x => !('storage_key' in x)));
    const events = await getEvents(tenantId, task.id);
    assert.equal(events.filter(e => e.type === 'artifact.created').length, 3);
  });

  await t.test('租约校验、配额与密钥扫描', async () => {
    await assert.rejects(() => service.ingest({
      tenantId, taskId: task.id, name: '租约.txt', buffer: Buffer.from('x'),
      leaseEpoch: 999, workerId: 'w-nope', createdBy: 'tool:call-lease',
    }), e => e instanceof ArtifactError && e.code === 'artifact_lease_lost');

    const tiny = createArtifactService({ limits: { maxPerTask: 1 } });
    const smallTask = await ts.createTask({ tenantId, ownerId, goal: '配额' });
    await tiny.ingest({ tenantId, taskId: smallTask.id, name: 'a.txt', buffer: Buffer.from('a'), createdBy: 'tool:x' });
    await assert.rejects(() => tiny.ingest({
      tenantId, taskId: smallTask.id, name: 'b.txt', buffer: Buffer.from('b'), createdBy: 'tool:y',
    }), e => e.code === 'artifact_quota_exceeded');

    await assert.rejects(() => service.ingest({
      tenantId, taskId: task.id, name: 'secret.txt',
      buffer: Buffer.from('api_key = "sk-abcdefghijklmnopqrstuvwx"'),
      mime: 'text/plain', scan: true, createdBy: 'tool:secret',
    }), e => e.code === 'artifact_secret_detected');
  });

  await t.test('上传附件、命名安全与 finish 引用校验', async () => {
    const upload = await service.attachUpload({
      tenantId, taskId: task.id, userId: ownerId, buffer: Buffer.from('附件正文'),
      originalName: '输入说明.md',
    });
    assert.equal(upload.kind, 'input');
    const attachments = await getPool().query(
      'SELECT * FROM task_attachments WHERE tenant_id = $1 AND task_id = $2 AND artifact_id = $3',
      [tenantId, task.id, upload.id],
    );
    assert.equal(attachments.rowCount, 1);

    await assert.rejects(() => service.attachUpload({
      tenantId, taskId: task.id, userId: ownerId, buffer: Buffer.from('x'),
      originalName: '../../evil.txt',
    }), e => e.code === 'artifact_path_invalid' || e.code === 'artifact_invalid_name');

    const ids = await service.assertFinishRefs({ tenantId, taskId: task.id, ids: [upload.id] });
    assert.deepEqual(ids, [upload.id]);
    await assert.rejects(() => service.assertFinishRefs({
      tenantId, taskId: otherTask.id, ids: [upload.id],
    }), e => e.code === 'artifact_conflict');
    await assert.rejects(() => service.assertFinishRefs({
      tenantId, taskId: task.id, ids: ['not-a-uuid'],
    }), e => e.code === 'artifact_conflict');
  });

  await t.test('软删除立即停止读取，GC 清理无引用 blob', async () => {
    const a = await service.ingest({
      tenantId, taskId: task.id, name: '临时.txt', buffer: Buffer.from('temporary'),
      mime: 'text/plain', createdBy: 'tool:gc',
    });
    const row = await getArtifactWithBlob({ tenantId, taskId: task.id, artifactId: a.id });
    const file = canonicalBlobPath(row.storage_key);

    await service.softDelete({ tenantId, taskId: task.id, artifactId: a.id, userId: ownerId });
    await assert.rejects(() => service.getForRead({
      tenantId, taskId: task.id, artifactId: a.id,
    }), e => e.code === 'artifact_not_found');
    assert.equal((await listArtifacts({ tenantId, taskId: task.id })).some(x => x.id === a.id), false);
    assert.ok(fs.existsSync(file), '宽限期内文件仍在');

    const result = await service.gc({ graceMs: 0 });
    assert.ok(result.blobs_removed >= 1);
    assert.equal(fs.existsSync(file), false);
    const blobs = await getPool().query('SELECT COUNT(*)::int AS n FROM artifact_blobs WHERE storage_key = $1', [row.storage_key]);
    assert.equal(blobs.rows[0].n, 0);

    const count = await countTaskArtifacts({ tenantId, taskId: task.id });
    assert.ok(count >= 1);
    const deletedEvents = (await getEvents(tenantId, task.id)).filter(e => e.type === 'artifact.deleted');
    assert.equal(deletedEvents.length, 1);
  });
});
