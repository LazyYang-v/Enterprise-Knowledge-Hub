import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import mammoth from 'mammoth';
import { createDocx } from '../../server/artifacts/docx.js';

test('最小 DOCX 可打开、含必要部件且文本可抽取', async () => {
  const buffer = createDocx({
    title: '会议纪要',
    paragraphs: ['第一段：讨论采购流程。', '第二段：<script>alert(1)</script> & "引号"', ''],
  });
  const zip = new AdmZip(buffer);
  const names = zip.getEntries().map(e => e.entryName).sort();
  assert.deepEqual(names, ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/document.xml']);

  const xml = zip.getEntry('word/document.xml').getData().toString('utf8');
  assert.ok(xml.includes('会议纪要'));
  assert.ok(xml.includes('&lt;script&gt;'), 'XML 必须转义');
  assert.ok(!xml.includes('<script>'));

  const { value } = await mammoth.extractRawText({ buffer });
  assert.ok(value.includes('第一段：讨论采购流程。'));
  assert.ok(value.includes('<script>alert(1)</script>'), '转义后文本应还原为字面量');
});

test('空文档也生成合法 DOCX', async () => {
  const buffer = createDocx({});
  const { value } = await mammoth.extractRawText({ buffer });
  assert.equal(value.trim(), '');
});
