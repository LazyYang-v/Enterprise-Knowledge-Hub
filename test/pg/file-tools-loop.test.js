import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureSchema, createTenant, canUseTestDatabase, getTaskRow, getEvents, closeTestDb,
} from '../helpers/pg.js';
import { startFakeModel, finish } from '../helpers/fake-model.js';
import { getPool } from '../../server/control/pg.js';
import { TaskService } from '../../server/control/task-service.js';
import { TaskWorker } from '../../server/control/worker.js';
import { claimNextTask } from '../../server/control/task-repo.js';
import { executeTask } from '../../server/control/task-executor.js';
import { resolveTools } from '../../server/tools/registry.js';
import { createToolExecutor } from '../../server/tools/executor.js';
import { getArtifactService } from '../../server/artifacts/service.js';
import { listArtifacts, getArtifactWithBlob } from '../../server/control/artifact-repo.js';
import { inspectZip } from '../../server/artifacts/zip-guard.js';
import { buildZip } from '../../server/artifacts/zip-guard.js';

const skip = !canUseTestDatabase();

const callTool = (name, args) => JSON.stringify({ type: 'call_tool', tool_name: name, arguments: args });
const finishWith = (summary, refs) => JSON.stringify({
  type: 'finish', summary, artifact_refs: refs, citations: [],
});

/** 辅助任务只用于造数据，立即取消以免被 claimNextTask 领走。 */
async function retireTask(tenantId, taskId){
  await getPool().query(
    `UPDATE agent_tasks SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, version = version + 1
      WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'retry_wait')`,
    [tenantId, taskId],
  );
}

function toolFactory(workerId){
  return ({ task, knowledge, signal }) => createToolExecutor({
    task, knowledge, signal, artifacts: getArtifactService(), workerId,
  });
}

function workerFor(model, workerId, toolFactoryValue){
  return new TaskWorker({
    workerId, model, service: new TaskService({ resolveTools }),
    toolFactory: toolFactoryValue || toolFactory(workerId),
    log: () => {},
    leaseTtlMs: 5000, heartbeatIntervalMs: 1000, reaperIntervalMs: 0, pollIntervalMs: 10,
    retryBaseMs: 10, maxRetryDelayMs: 20,
  });
}

function idFor(body, name){
  const needle = JSON.stringify(name);
  for (const m of [...(body.messages || [])].reverse()){
    const text = String(m.content || '');
    const idx = text.indexOf(needle);
    if (idx < 0) continue;
    const ids = [...text.slice(0, idx).matchAll(/"artifact_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi)];
    if (ids.length) return ids.at(-1)[1];
  }
  return null;
}

function lastToolJson(body, toolName){
  for (const m of [...(body.messages || [])].reverse()){
    const text = String(m.content || '');
    if (!text.includes(`工具 ${toolName} 返回：`)) continue;
    const start = text.indexOf('=== UNTRUSTED_TOOL_RESULT_START ===\n');
    const end = text.lastIndexOf('\n=== UNTRUSTED_TOOL_RESULT_END ===');
    if (start >= 0 && end > start){
      return JSON.parse(text.slice(start + '=== UNTRUSTED_TOOL_RESULT_START ===\n'.length, end));
    }
    return JSON.parse(text.slice(text.indexOf('：\n') + 2));
  }
  return null;
}

test('P0-5 文件工具端到端：T19/T21 写入、打包、引用与读取', { skip }, async t => {
  await ensureSchema();
  const service = new TaskService({ resolveTools });
  const tenantId = await createTenant('p05-file-loop');
  const ownerId = 'file-owner';
  t.after(async () => { await closeTestDb(); });

  await t.test('document.write → spreadsheet.write → archive.create → finish 引用', async () => {
    let step = 0;
    const ids = {};
    const model = await startFakeModel(({ body }) => {
      step += 1;
      if (step === 1){
        return callTool('document.write', {
          name: '交付说明.md', content: '# 交付说明\n\n本任务完成采购审批梳理。',
        });
      }
      if (step === 2){
        ids.md = idFor(body, '交付说明.md');
        assert.ok(ids.md, '模型应能从工具结果中取得 artifact_id');
        return callTool('spreadsheet.write', {
          name: '行动项.xlsx',
          sheets: [{ name: '行动项', rows: [['事项', '负责人'], ['采购审批', '张三']] }],
        });
      }
      if (step === 3){
        ids.xlsx = idFor(body, '行动项.xlsx');
        assert.ok(ids.xlsx);
        return callTool('archive.create', {
          name: '交付包.zip',
          entries: [{ artifact_id: ids.md }, { artifact_id: ids.xlsx }],
        });
      }
      if (step === 4){
        ids.zip = idFor(body, '交付包.zip');
        assert.ok(ids.zip);
        return callTool('archive.read', { artifact_id: ids.zip, include_text: true });
      }
      const read = lastToolJson(body, 'archive.read');
      assert.deepEqual(read.entries.map(e => e.name).sort(), ['交付说明.md', '行动项.xlsx'].sort());
      return finishWith('交付包已生成', [ids.md, ids.xlsx, ids.zip]);
    });
    t.after(() => model.close());

    const task = await service.createTask({
      tenantId, ownerId, goal: '生成交付物',
      input: { tools: ['document.write', 'spreadsheet.write', 'archive.create', 'archive.read'] },
    });
    const result = await workerFor(model, 'w-file-loop').runOnce();
    assert.equal(result.status, 'completed');

    const row = await getTaskRow(tenantId, task.id);
    assert.equal(row.status, 'completed');
    const done = (await getEvents(tenantId, task.id)).find(e => e.type === 'task.completed');
    assert.equal(new Set(done.payload.artifact_ids).size, 3);
    assert.deepEqual(done.payload.artifact_ids.sort(), [ids.md, ids.xlsx, ids.zip].sort());

    const list = await listArtifacts({ tenantId, taskId: task.id });
    assert.equal(list.length, 3);
    assert.ok(list.every(a => a.kind === 'output' && a.version === 1));

    const calls = (await getPool().query(
      'SELECT tool_name, status, idempotency_key FROM agent_tool_calls WHERE tenant_id = $1 AND task_id = $2 ORDER BY created_at',
      [tenantId, task.id],
    )).rows;
    assert.equal(calls.length, 4);
    assert.ok(calls.every(c => c.status === 'succeeded'));
    for (const c of calls){
      if (c.tool_name === 'archive.read'){
        assert.equal(c.idempotency_key, null, '读工具不需要幂等键');
      } else {
        assert.match(c.idempotency_key, new RegExp(`^${c.tool_name.replace('.', '\\.')}:[0-9a-f]{64}:`));
      }
    }
    const attempts = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM agent_tool_attempts a
         JOIN agent_tool_calls c ON c.id = a.tool_call_id
        WHERE c.tenant_id = $1 AND c.task_id = $2`,
      [tenantId, task.id],
    );
    assert.equal(attempts.rows[0].n, 4);

    const zipRow = await getArtifactWithBlob({ tenantId, taskId: task.id, artifactId: ids.zip });
    const zipRead = await getArtifactService().getForRead({ tenantId, taskId: task.id, artifactId: ids.zip });
    assert.equal(inspectZip(zipRead.buffer).entries.length, 2);
    assert.ok(zipRow.storage_key.startsWith('blobs/'));
    assert.ok(!JSON.stringify(list).includes('storage_key'), '列表不得泄露磁盘路径');
  });

  await t.test('finish 引用其他任务成果：任务不得完成', async () => {
    const created = await service.createTask({
      tenantId, ownerId: 'owner-bad-ref', goal: '非法引用',
      input: { tools: ['document.write'] },
    });
    const claimed = await claimNextTask({ workerId: 'w-bad-ref', leaseTtlMs: 5000 });
    assert.equal(claimed.id, created.id);
    const other = await service.createTask({ tenantId, ownerId: 'owner-bad-ref', goal: '另一个任务' });
    const foreignArtifact = await getArtifactService().ingest({
      tenantId, taskId: other.id, name: '他人成果.md', buffer: Buffer.from('x'),
      mime: 'text/markdown', createdBy: 'tool:foreign',
    });
    await retireTask(tenantId, other.id);

    const model = await startFakeModel(({ call }) => (
      call === 1
        ? callTool('document.write', { name: '本任务.md', content: '正文' })
        : finishWith('尝试引用他人成果', [foreignArtifact.id])
    ));
    t.after(() => model.close());

    await assert.rejects(() => executeTask(claimed, {
      workerId: 'w-bad-ref', model, toolFactory: toolFactory('w-bad-ref'),
    }), e => e.code === 'model_invalid_output' && e.retryable === true);

    const row = await getTaskRow(tenantId, created.id);
    assert.equal(row.status, 'running', '引用校验失败必须保持 running 交给重试');
    assert.equal((await getEvents(tenantId, created.id)).some(e => e.type === 'task.completed'), false);
    await getPool().query(
      `UPDATE agent_tasks SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL
        WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
      [tenantId, created.id],
    );
  });

  await t.test('T24：读取上传 ZIP 的条目文本，嵌套压缩包只列出', async () => {
    const task = await service.createTask({
      tenantId, ownerId, goal: '审阅上传压缩包',
      input: { tools: ['archive.read'] },
    });
    const inner = buildZip([{ name: '内层.txt', data: Buffer.from('不应展开') }]);
    const uploaded = await getArtifactService().attachUpload({
      tenantId, taskId: task.id, userId: ownerId,
      originalName: '资料包.zip',
      buffer: buildZip([
        { name: '说明.txt', data: Buffer.from('这是说明') },
        { name: '内层.zip', data: inner },
      ]),
    });

    const model = await startFakeModel(({ body }) => {
      if (!body.messages.some(m => String(m.content).includes('工具 archive.read 返回：'))){
        return callTool('archive.read', { artifact_id: uploaded.id, include_text: true });
      }
      const out = lastToolJson(body, 'archive.read');
      assert.deepEqual(out.entries.map(e => e.name).sort(), ['内层.zip', '说明.txt'].sort());
      const texts = Object.fromEntries(out.texts.map(x => [x.name, x.text]));
      assert.equal(texts['说明.txt'], '这是说明');
      assert.equal(texts['内层.zip'], undefined, '嵌套压缩包不得展开');
      return finish('压缩包已审阅');
    });
    t.after(() => model.close());

    const result = await workerFor(model, 'w-zip-loop').runOnce();
    assert.equal(result.status, 'completed');
    const calls = (await getPool().query(
      'SELECT status FROM agent_tool_calls WHERE tenant_id = $1 AND task_id = $2',
      [tenantId, task.id],
    )).rows;
    assert.deepEqual(calls.map(c => c.status), ['succeeded']);
  });

  await t.test('工具只读当前任务：跨任务 artifact_id 返回 artifact_not_found', async () => {
    const source = await service.createTask({ tenantId, ownerId, goal: '成果来源任务' });
    const secret = await getArtifactService().ingest({
      tenantId, taskId: source.id, name: '机密.md', buffer: Buffer.from('机密内容'),
      mime: 'text/markdown', createdBy: 'tool:source',
    });
    await retireTask(tenantId, source.id);
    const task = await service.createTask({
      tenantId, ownerId, goal: '尝试跨任务读取',
      input: { tools: ['document.read', 'archive.create'] },
    });

    let step = 0;
    const model = await startFakeModel(() => {
      step += 1;
      if (step === 1) return callTool('document.read', { artifact_id: secret.id });
      if (step === 2) return callTool('archive.create', { name: '窃取.zip', entries: [{ artifact_id: secret.id }] });
      return finish('读取被拒绝');
    });
    t.after(() => model.close());

    const result = await workerFor(model, 'w-cross-task').runOnce();
    assert.equal(result.status, 'completed');
    const calls = (await getPool().query(
      'SELECT tool_name, status, error_code FROM agent_tool_calls WHERE tenant_id = $1 AND task_id = $2 ORDER BY created_at',
      [tenantId, task.id],
    )).rows;
    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => c.status === 'failed'));
    assert.ok(calls.every(c => c.error_code === 'artifact_not_found'));
    assert.equal((await listArtifacts({ tenantId, taskId: task.id })).length, 0);

    // 完成引用同样不能引用其他任务成果。
    const badModel = await startFakeModel(() => finishWith('引用他人', [secret.id]));
    t.after(() => badModel.close());
    const again = await service.createTask({
      tenantId, ownerId, goal: '直接引用他人成果', input: { tools: [] },
    });
    const claimed = await claimNextTask({ workerId: 'w-cross-finish', leaseTtlMs: 5000 });
    assert.equal(claimed.id, again.id);
    await assert.rejects(() => executeTask(claimed, {
      workerId: 'w-cross-finish', model: badModel, toolFactory: toolFactory('w-cross-finish'),
    }), e => e.code === 'model_invalid_output');
    await getPool().query(
      `UPDATE agent_tasks SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL
        WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
      [tenantId, again.id],
    );
  });
});
