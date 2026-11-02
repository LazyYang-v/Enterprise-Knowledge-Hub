import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCitation, truncateExcerpt, parseLocator } from '../../server/knowledge/citations.js';
import { chunkContentHash } from '../../server/knowledge/versioning.js';

test('引用对象包含设计要求的全部字段', () => {
  const c = buildCitation({
    chunk_id: 'c1', document_id: 'd1', document_version: 3, kb_id: 'kb1',
    doc_name: '制度.pdf', kb_name: '人事', locator_json: '{"page":2}',
    content: '年假天数', score: 0.87, content_hash: 'abc',
  }, { retrievedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(c, {
    evidence_id: null,
    document_id: 'd1', document_version: 3, chunk_id: 'c1', content_hash: 'abc',
    title: '制度.pdf', kb_id: 'kb1', kb_name: '人事',
    locator: { page: 2 }, excerpt: '年假天数', score: 0.87,
    retrieved_at: '2026-01-01T00:00:00.000Z', untrusted: true,
  });
});

test('缺省哈希按内容计算，locator 解析容错', () => {
  const c = buildCitation({ chunk_id: 'c', document_id: 'd', content: 'hello' });
  assert.equal(c.content_hash, chunkContentHash('hello'));
  assert.deepEqual(c.locator, { chunk_index: 0 });
  assert.deepEqual(parseLocator('not-json'), {});
  assert.deepEqual(parseLocator('{"sheet":"S1"}'), { sheet: 'S1' });
});

test('摘录截断到上限且不改变短文本', () => {
  assert.equal(truncateExcerpt('abcdef', 3), 'abc');
  assert.equal(truncateExcerpt('abc', 10), 'abc');
  assert.equal(truncateExcerpt(null, 10), '');
});
