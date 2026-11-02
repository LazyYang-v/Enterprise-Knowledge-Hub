// 引用对象组装：字段与设计文档 §8.5 对齐。
import { chunkContentHash } from './versioning.js';

export const DEFAULT_EXCERPT_CHARS = 2000;

export function truncateExcerpt(content, max = DEFAULT_EXCERPT_CHARS){
  const text = String(content ?? '');
  const limit = Math.max(1, Number(max) || DEFAULT_EXCERPT_CHARS);
  return text.length > limit ? text.slice(0, limit) : text;
}

export function parseLocator(value){
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  return {};
}

export function buildCitation(ref, { excerptChars = DEFAULT_EXCERPT_CHARS, retrievedAt = null } = {}){
  const locator = parseLocator(ref.locator_json);
  return {
    evidence_id: ref.evidence_id || null,
    document_id: ref.document_id,
    document_version: Number(ref.document_version) || 1,
    chunk_id: ref.chunk_id,
    content_hash: ref.content_hash || chunkContentHash(ref.content || ''),
    title: ref.doc_name || ref.title || '',
    kb_id: ref.kb_id || null,
    kb_name: ref.kb_name || '',
    locator: Object.keys(locator).length ? locator : { chunk_index: ref.idx ?? 0 },
    excerpt: truncateExcerpt(ref.excerpt ?? ref.content ?? '', excerptChars),
    score: Number(ref.score) || 0,
    retrieved_at: ref.retrieved_at || retrievedAt || new Date().toISOString(),
    untrusted: true,
  };
}
