import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../server/config.js';
import { getFileTool } from '../../server/tools/file-tools.js';

function uuid(n){
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function fakeArtifacts(){
  const items = new Map();
  let seq = 0;
  return {
    async ingest({ name, buffer, mime, kind = 'output' }){
      seq += 1;
      const meta = {
        id: uuid(seq), name, kind, version: 1,
        mime: mime || 'application/octet-stream', size_bytes: buffer.length,
        sha256: 'a'.repeat(64),
      };
      items.set(meta.id, { meta, buffer });
      return meta;
    },
    async getForRead({ artifactId, name }){
      const found = [...items.values()].find(x => artifactId ? x.meta.id === artifactId : x.meta.name === name);
      if (!found){
        const e = new Error('成果不存在');
        e.code = 'artifact_not_found';
        throw e;
      }
      return { artifact: found.meta, buffer: found.buffer };
    },
    async list(){ return [...items.values()].map(x => x.meta); },
    fileLimits: { ...config.files },
    limits: { ...config.artifacts },
  };
}

function context(artifacts){
  return {
    task: { id: 'task-1', tenant_id: 'tenant-1', owner_id: 'user-1', lease_epoch: 1 },
    artifacts, workerId: 'w-1', toolCallId: 'call-1', stepId: 'step-1', leaseEpoch: 1,
  };
}

async function call(name, args, ctx){
  const tool = getFileTool(name);
  assert.ok(tool, `工具不存在：${name}`);
  return tool.handler(args, ctx);
}

test('document.write/read：Markdown、JSON、DOCX 与分页', async () => {
  const ctx = context(fakeArtifacts());

  const md = await call('document.write', { name: '摘要.md', content: '# 摘要\n\n正文内容' }, ctx);
  assert.equal(md.artifact.name, '摘要.md');
  assert.equal(md.artifact.mime, 'text/markdown; charset=utf-8');

  const read = await call('document.read', { artifact_id: md.artifact.artifact_id }, ctx);
  assert.ok(read.text.includes('正文内容'));
  assert.equal(read.next_offset, null);
  assert.equal(read.truncated, false);

  const page = await call('document.read', { name: '摘要.md', offset: 2, limit: 3 }, ctx);
  assert.equal(page.text, '# 摘要\n\n正文内容'.slice(2, 5));
  assert.equal(page.next_offset, 5);

  const json = await call('document.write', { name: '数据.json', content: '{"b":1,"a":2}' }, ctx);
  const jsonRead = await call('document.read', { artifact_id: json.artifact.artifact_id }, ctx);
  assert.deepEqual(JSON.parse(jsonRead.text), { b: 1, a: 2 });
  assert.ok(jsonRead.text.includes('\n  '), 'JSON 应格式化');

  await assert.rejects(() => call('document.write', { name: '坏.json', content: '{oops' }, ctx), e => e.code === 'document_invalid_json');
  await assert.rejects(() => call('document.write', { name: '报告.pdf', content: 'x' }, ctx), e => e.code === 'document_write_unsupported');
  await assert.rejects(() => call('document.write', { name: '报告.md', format: 'docx', content: 'x' }, ctx), e => e.code === 'document_write_unsupported');

  const docx = await call('document.write', { name: '会议纪要.docx', content: '第一段\n第二段' }, ctx);
  const docxRead = await call('document.read', { artifact_id: docx.artifact.artifact_id }, ctx);
  assert.ok(docxRead.text.includes('第一段'));
  assert.ok(docxRead.text.includes('第二段'));
});

test('spreadsheet.write/read：XLSX 往返与行列截断', async () => {
  const ctx = context(fakeArtifacts());
  const written = await call('spreadsheet.write', {
    name: '行动项.xlsx',
    sheets: [{
      name: '行动项',
      rows: [['事项', '负责人', '金额'], ['采购审批', '张三', 1200], ['合同归档', '李四', 300]],
    }],
  }, ctx);
  assert.equal(written.artifact.name, '行动项.xlsx');

  const read = await call('spreadsheet.read', { artifact_id: written.artifact.artifact_id }, ctx);
  assert.deepEqual(read.sheets, ['行动项']);
  assert.ok(read.csv.includes('采购审批'));
  assert.ok(read.csv.includes('1200'));

  const limited = await call('spreadsheet.read', {
    name: '行动项.xlsx', offset: 1, limit_rows: 1, limit_cols: 2,
  }, ctx);
  assert.ok(limited.csv.startsWith('采购审批'));
  assert.equal(limited.next_offset, 2);
  assert.equal(limited.truncated, true);

  await assert.rejects(() => call('spreadsheet.write', { name: '表.xlsx', sheets: [{ name: 'a', rows: [] }, { name: 'A', rows: [] }] }, ctx), e => e.code === 'spreadsheet_invalid_sheet');
});

test('archive.create/read：打包当前任务成果并抽取文本', async () => {
  const ctx = context(fakeArtifacts());
  const a = await call('artifact.create', { name: 'README.txt', content: '交付说明' }, ctx);
  const b = await call('artifact.create', { name: 'manifest.json', content: '{"files":[]}' }, ctx);

  const zip = await call('archive.create', {
    name: 'deliverable.zip',
    entries: [
      { artifact_id: a.artifact.artifact_id },
      { artifact_id: b.artifact.artifact_id },
    ],
  }, ctx);
  assert.equal(zip.artifact.name, 'deliverable.zip');
  assert.deepEqual(zip.entries.sort(), ['README.txt', 'manifest.json']);

  const read = await call('archive.read', {
    artifact_id: zip.artifact.artifact_id, include_text: true,
  }, ctx);
  assert.deepEqual(read.entries.map(e => e.name).sort(), ['README.txt', 'manifest.json']);
  const byName = Object.fromEntries(read.texts.map(t => [t.name, t.text]));
  assert.equal(byName['README.txt'], '交付说明');
  assert.ok(byName['manifest.json'].includes('files'));

  await assert.rejects(() => call('archive.create', {
    name: 'dup.zip', entries: [{ name: 'README.txt' }, { name: 'README.txt' }],
  }, ctx), e => e.code === 'archive_duplicate_entry');
  await assert.rejects(() => call('archive.create', { name: 'x.zip' }, ctx), e => e.code === 'archive_empty');
});

test('工具作用域与名称安全：跨任务不存在、非法文件名', async () => {
  const ctx = context(fakeArtifacts());
  await assert.rejects(() => call('document.read', { name: '不存在.md' }, ctx), e => e.code === 'artifact_not_found');
  await assert.rejects(() => call('artifact.create', { name: '../evil.txt', content: 'x' }, ctx), e => e.code === 'artifact_path_invalid');
  await assert.rejects(() => call('archive.create', { name: 'x.zip', entries: [{ name: '../evil' }] }, ctx), e => /artifact_/.test(e.code));
  const binary = await call('artifact.create', { name: '图片.png', content: 'aGVsbG8=', encoding: 'base64' }, ctx);
  const note = await call('document.read', { artifact_id: binary.artifact.artifact_id }, ctx);
  assert.match(note.note, /暂不支持|仅存档/);
});
