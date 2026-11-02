// P0-5 成果 API：上传、列表、下载、删除与错误映射（需要 PostgreSQL）。
process.env.AGENT_PLATFORM_ENABLED = '1';
process.env.EKH_ARTIFACT_UPLOAD_MAX_BYTES = '1024';

import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { ensureSchema, canUseTestDatabase, closeTestDb, getPool } = await import('../helpers/pg.js');
const { startApp } = await import('../helpers/app.js');

const skip = !canUseTestDatabase();

test('P0-5 成果 API：上传/列表/下载/删除与 S-09 输入校验', { skip }, async t => {
  await ensureSchema();
  const app = await startApp({
    AGENT_PLATFORM_ENABLED: '1',
    EKH_ARTIFACT_UPLOAD_MAX_BYTES: '1024',
  });
  t.after(async () => { await app.close(); await closeTestDb(); });

  const owner = await app.register('owner@example.com', '任务所有者');

  const created = await app.request('POST', '/api/tasks', {
    token: owner.token, body: { goal: '生成成果并上传附件' },
  });
  assert.equal(created.status, 201);
  const taskId = created.data.task.id;
  assert.deepEqual(created.data.task.artifacts, []);
  assert.equal(created.data.task.permissions.can_download, true);
  assert.equal(created.data.task.permissions.can_upload_attachment, true);

  const content = Buffer.from('# 输入说明\n\n这是附件内容。', 'utf8');
  const uploaded = await app.uploadForm(`/api/tasks/${taskId}/attachments`, {
    token: owner.token, filename: '输入说明.md', data: content, contentType: 'text/markdown',
  });
  assert.equal(uploaded.status, 201, uploaded.buffer.toString());
  const artifact = uploaded.data.artifact;
  assert.equal(artifact.name, '输入说明.md');
  assert.equal(artifact.kind, 'input');
  assert.equal(artifact.version, 1);
  assert.equal(artifact.size_bytes, content.length);
  assert.ok(!('storage_key' in artifact));
  assert.equal(uploaded.data.task.artifacts.length, 1);
  assert.equal(uploaded.data.task.artifacts[0].id, artifact.id);

  const listed = await app.request('GET', `/api/tasks/${taskId}/artifacts`, { token: owner.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.artifacts.length, 1);
  assert.ok(!JSON.stringify(listed.data.artifacts).includes('storage_key'));

  const snapshot = await app.request('GET', `/api/tasks/${taskId}`, { token: owner.token });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.task.artifacts.length, 1);

  const download = await app.requestRaw('GET', `/api/tasks/${taskId}/artifacts/${artifact.id}/download`, {
    token: owner.token,
  });
  assert.equal(download.status, 200);
  assert.deepEqual(download.buffer, content);
  assert.match(download.headers.get('content-disposition'), /^attachment; filename=".*"; filename\*=UTF-8''/);
  assert.match(download.headers.get('content-disposition'), /%E8%BE%93%E5%85%A5/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.match(download.headers.get('content-security-policy'), /sandbox/);

  const audit = await getPool().query(
    `SELECT action, resource_type, resource_id FROM audit_log WHERE resource_id = $1 ORDER BY id`,
    [artifact.id],
  );
  assert.deepEqual(audit.rows.map(r => r.action).sort(), ['artifact.download', 'artifact.upload']);

  // S-09：扩展名、magic bytes、路径遍历与大小上限。
  const exe = await app.uploadForm(`/api/tasks/${taskId}/attachments`, {
    token: owner.token, filename: '恶意.exe', data: Buffer.from('MZ...'), contentType: 'application/octet-stream',
  });
  assert.equal(exe.status, 400);
  assert.equal(exe.data.error.code, 'artifact_unsupported_type');

  const mismatch = await app.uploadForm(`/api/tasks/${taskId}/attachments`, {
    token: owner.token, filename: '伪装.pdf', data: Buffer.from('not a pdf'), contentType: 'application/pdf',
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.data.error.code, 'artifact_type_mismatch');

  const traversal = await app.uploadForm(`/api/tasks/${taskId}/attachments`, {
    token: owner.token, filename: '..evil.txt', data: Buffer.from('evil'), contentType: 'text/plain',
  });
  assert.equal(traversal.status, 400);
  assert.match(traversal.data.error.code, /^artifact_(path_invalid|invalid_name)$/);

  const tooLarge = await app.uploadForm(`/api/tasks/${taskId}/attachments`, {
    token: owner.token, filename: '大文件.txt', data: Buffer.alloc(2000, 0x61), contentType: 'text/plain',
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.data.error.code, 'file_too_large');

  const removed = await app.request('DELETE', `/api/tasks/${taskId}/artifacts/${artifact.id}`, { token: owner.token });
  assert.equal(removed.status, 200);
  assert.equal((await app.request('GET', `/api/tasks/${taskId}/artifacts`, { token: owner.token })).data.artifacts.length, 0);
  const gone = await app.requestRaw('GET', `/api/tasks/${taskId}/artifacts/${artifact.id}/download`, { token: owner.token });
  assert.equal(gone.status, 404);
  const doubleDelete = await app.request('DELETE', `/api/tasks/${taskId}/artifacts/${artifact.id}`, { token: owner.token });
  assert.equal(doubleDelete.status, 404);

  // 终态任务禁止上传附件。
  const ended = await app.request('POST', '/api/tasks', { token: owner.token, body: { goal: '即将取消' } });
  const endedId = ended.data.task.id;
  assert.equal((await app.request('POST', `/api/tasks/${endedId}/cancel`, { token: owner.token })).status, 200);
  const terminal = await app.request('GET', `/api/tasks/${endedId}`, { token: owner.token });
  assert.equal(terminal.data.task.permissions.can_upload_attachment, false);
  const blocked = await app.uploadForm(`/api/tasks/${endedId}/attachments`, {
    token: owner.token, filename: '晚到.txt', data: Buffer.from('late'), contentType: 'text/plain',
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error.code, 'conflict');
});
