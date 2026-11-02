// 受控混合检索：ACL/范围/版本/删除条件全部下推到 SQL，先限制候选再计算向量。
import { db } from '../db.js';
import { embed, cosine } from '../llm.js';
import { getModel } from '../model-registry.js';
import { chunkContentHash } from './versioning.js';

export const RETRIEVAL_DEFAULTS = Object.freeze({
  candidateCap: 5000,
  ftsLimit: 80,
  topKMax: 20,
  maxPerDocument: 0,
});

function dedupeStrings(values){
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function buildScopeClause(scope, params){
  const conds = [];
  const kbIds = dedupeStrings(scope.kbIds);
  const documentIds = dedupeStrings(scope.documentIds);
  if (kbIds.length){
    conds.push(`c.kb_id IN (${kbIds.map(() => '?').join(',')})`);
    params.push(...kbIds);
  }
  if (documentIds.length){
    conds.push(`c.document_id IN (${documentIds.map(() => '?').join(',')})`);
    params.push(...documentIds);
  }
  if (scope.sessionId){
    conds.push('c.session_id = ?');
    params.push(String(scope.sessionId));
  }
  return conds.length ? `(${conds.join(' OR ')})` : null;
}

/**
 * 固定版本只约束被固定的文档；其他文档仍取 current_version。
 * 这样 pin_on_first_use 不会同时返回同一文档的新旧两个版本。
 */
function buildVersionClause(pinnedVersions, params){
  const entries = Object.entries(pinnedVersions || {})
    .filter(([, v]) => Number.isInteger(Number(v)) && Number(v) > 0)
    .map(([id, v]) => [String(id), Number(v)]);
  if (!entries.length) return 'c.document_version = d.current_version';
  const ids = entries.map(([id]) => id);
  const parts = [`(c.document_id NOT IN (${ids.map(() => '?').join(',')}) AND c.document_version = d.current_version)`];
  params.push(...ids);
  for (const [docId, version] of entries){
    parts.push('(c.document_id = ? AND c.document_version = ?)');
    params.push(docId, version);
  }
  return `(${parts.join(' OR ')})`;
}

function clampTopK(value, topKMax){
  const n = Number(value);
  if (!Number.isFinite(n)) return 6;
  return Math.min(Math.max(Math.trunc(n), 1), topKMax);
}

function likeHits(where, whereParams, q, limit){
  const rows = db.prepare(`
    SELECT c.id FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE ${where} AND c.content LIKE ? LIMIT ?
  `).all(...whereParams, `%${q}%`, limit);
  const map = new Map();
  for (const r of rows) map.set(r.id, 0.5);
  return map;
}

function trigramMatch(text){
  const q = String(text || '').replace(/\s+/g, '');
  if (q.length < 3) return null;
  const trigrams = [];
  for (let i = 0; i + 3 <= q.length; i++) trigrams.push(q.slice(i, i + 3));
  let sel = trigrams;
  if (sel.length > 32){
    const step = sel.length / 32;
    sel = Array.from({ length: 32 }, (_, i) => trigrams[Math.floor(i * step)]);
  }
  return sel.map(t => `"${t}"`).join(' OR ');
}

function ftsHits(where, whereParams, match, limit){
  const rows = db.prepare(`
    SELECT chunks_fts.chunk_id AS chunk_id, bm25(chunks_fts) AS rank
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.chunk_id
    JOIN documents d ON d.id = c.document_id
    WHERE chunks_fts MATCH ? AND ${where}
    ORDER BY rank LIMIT ?
  `).all(match, ...whereParams, limit);
  const map = new Map();
  let max = 0;
  for (const h of rows){
    const s = Math.max(0, -h.rank);
    map.set(h.chunk_id, s);
    if (s > max) max = s;
  }
  if (max > 0) for (const [k, v] of map) map.set(k, v / max);
  return map;
}

function selectRowsByIds(ids, where, whereParams){
  if (!ids.length) return [];
  return db.prepare(`
    SELECT c.id, c.document_id, c.kb_id, c.session_id, c.idx, c.content, c.embedding,
           c.document_version, c.content_hash, c.locator_json, c.created_at,
           d.name AS doc_name, d.current_version,
           k.name AS kb_name
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    LEFT JOIN knowledge_bases k ON k.id = c.kb_id
    WHERE c.id IN (${ids.map(() => '?').join(',')}) AND ${where}
  `).all(...ids, ...whereParams);
}

function safeLocator(raw, idx){
  try {
    const loc = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (loc && typeof loc === 'object' && !Array.isArray(loc)) return loc;
  } catch {}
  return { chunk_index: idx ?? 0 };
}

/**
 * 返回 { refs, degraded, candidateCount, candidateCapped, ftsCount, ftsError }
 * scope: { kbIds, documentIds, sessionId, pinnedVersions }
 */
export async function retrieveScoped({
  kbIds = [], documentIds = [], sessionId = null, pinnedVersions = {},
  query, topK = 6, candidateCap = RETRIEVAL_DEFAULTS.candidateCap,
  ftsLimit = RETRIEVAL_DEFAULTS.ftsLimit, topKMax = RETRIEVAL_DEFAULTS.topKMax,
  maxPerDocument = 0,
} = {}){
  const text = String(query || '').trim();
  const empty = { refs: [], degraded: false, candidateCount: 0, candidateCapped: false, ftsCount: 0, ftsError: false };
  if (!text) return empty;

  const whereParams = [];
  const scopeClause = buildScopeClause({ kbIds, documentIds, sessionId }, whereParams);
  if (!scopeClause) return empty;
  const versionClause = buildVersionClause(pinnedVersions, whereParams);
  const where = `${scopeClause} AND d.deleted_at IS NULL AND d.status = 'ready' AND ${versionClause}`;

  const cap = Math.max(1, Number(candidateCap) || RETRIEVAL_DEFAULTS.candidateCap);
  const rows = db.prepare(`
    SELECT c.id, c.document_id, c.kb_id, c.session_id, c.idx, c.content, c.embedding,
           c.document_version, c.content_hash, c.locator_json, c.created_at,
           d.name AS doc_name, d.current_version,
           k.name AS kb_name
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    LEFT JOIN knowledge_bases k ON k.id = c.kb_id
    WHERE ${where}
    ORDER BY c.created_at DESC, c.id
    LIMIT ?
  `).all(...whereParams, cap + 1);
  const candidateCapped = rows.length > cap;
  if (candidateCapped) rows.length = cap;
  if (!rows.length) return { ...empty, candidateCapped, candidateCount: 0 };

  // —— 关键词通道（范围/版本条件与候选集一致） ——
  let ftsError = false;
  let kwScores = new Map();
  const q = text.replace(/\s+/g, '');
  try {
    const match = trigramMatch(text);
    if (match){
      kwScores = ftsHits(where, whereParams, match, Math.max(1, Number(ftsLimit) || RETRIEVAL_DEFAULTS.ftsLimit));
    } else if (q.length >= 2){
      kwScores = likeHits(where, whereParams, q, 60);
    }
  } catch {
    ftsError = true;
  }

  // FTS 命中可能落在候选上限之外；按 ID 补回，保证关键词召回不被截断。
  const seen = new Set(rows.map(r => r.id));
  const missing = [...kwScores.keys()].filter(id => !seen.has(id));
  if (missing.length){
    rows.push(...selectRowsByIds(missing, where, whereParams));
  }

  // —— 向量通道：只对已限制的候选行计算 ——
  let vecScores = new Map();
  let vecAvailable = false;
  let embedError = false;
  const hasEmb = rows.some(r => r.embedding);
  const embedModel = getModel('embedding');
  if (hasEmb && embedModel){
    try {
      const [qv] = await embed(embedModel, [text]);
      if (qv){
        for (const r of rows){
          if (!r.embedding) continue;
          try { vecScores.set(r.id, Math.max(0, cosine(qv, JSON.parse(r.embedding)))); } catch {}
        }
        vecAvailable = vecScores.size > 0;
      }
    } catch {
      embedError = true;
    }
  }

  const scored = rows.map(r => {
    const kw = kwScores.get(r.id) || 0;
    const vec = vecScores.get(r.id) || 0;
    let score;
    if (vecAvailable && kwScores.size) score = 0.55 * vec + 0.45 * kw;
    else if (vecAvailable) score = vec;
    else score = kw;
    return {
      chunk_id: r.id, document_id: r.document_id, kb_id: r.kb_id, session_id: r.session_id,
      idx: r.idx, document_version: Number(r.document_version) || 1,
      current_version: Number(r.current_version) || 1,
      content_hash: r.content_hash || chunkContentHash(r.content),
      locator_json: safeLocator(r.locator_json, r.idx),
      doc_name: r.doc_name || '会话附件', kb_name: r.kb_name || '',
      content: r.content, score,
    };
  });
  scored.sort((a, b) => b.score - a.score);

  // 文档多样性（默认关闭，保持旧排序）。
  const perDoc = Math.max(0, Number(maxPerDocument) || 0);
  let selected = scored;
  if (perDoc > 0){
    const counts = new Map();
    selected = [];
    for (const row of scored){
      const n = counts.get(row.document_id) || 0;
      if (n >= perDoc) continue;
      counts.set(row.document_id, n + 1);
      selected.push(row);
    }
  }

  const limit = clampTopK(topK, Number(topKMax) || RETRIEVAL_DEFAULTS.topKMax);
  const refs = selected.slice(0, limit).filter(s => s.score > 0.02);
  return {
    refs,
    degraded: ftsError || embedError,
    candidateCount: rows.length,
    candidateCapped,
    ftsCount: kwScores.size,
    ftsError,
  };
}

/** 向后兼容：旧调用只关心 refs。 */
export async function retrieve(opts){
  const result = await retrieveScoped(opts);
  return result.refs;
}
