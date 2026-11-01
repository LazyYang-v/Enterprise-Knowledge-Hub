// 混合检索：FTS5 关键词 + 向量余弦，加权融合
import { db } from './db.js';
import { embed, getModel, cosine } from './llm.js';

export async function retrieve({ kbIds = [], sessionId = null, query, topK = 6 }){
  const text = String(query || '').trim();
  if (!text) return [];

  // 候选集合：知识库 chunks + 会话附件 chunks
  const conds = [];
  const params = [];
  if (kbIds.length){
    conds.push(`c.kb_id IN (${kbIds.map(() => '?').join(',')})`);
    params.push(...kbIds);
  }
  if (sessionId){
    conds.push('c.session_id = ?');
    params.push(sessionId);
  }
  if (!conds.length) return [];
  const where = conds.join(' OR ');

  const rows = db.prepare(
    `SELECT c.id, c.document_id, c.kb_id, c.session_id, c.idx, c.content, c.embedding,
            d.name AS doc_name, k.name AS kb_name
     FROM chunks c LEFT JOIN documents d ON d.id = c.document_id
     LEFT JOIN knowledge_bases k ON k.id = c.kb_id
     WHERE (${where}) AND c.embedding IS NOT NULL`
  ).all(...params);

  if (!rows.length) return [];

  // —— 关键词得分：查询拆成滑动 trigram，OR 匹配，bm25 归一化（匹配越多的片段越靠前） ——
  const kwScores = new Map();
  const q = String(text).replace(/\s+/g, '');
  try {
    if (q.length >= 3){
      const trigrams = [];
      for (let i = 0; i + 3 <= q.length; i++) trigrams.push(q.slice(i, i + 3));
      let sel = trigrams;
      if (sel.length > 32){
        const step = sel.length / 32;
        sel = Array.from({ length: 32 }, (_, i) => trigrams[Math.floor(i * step)]);
      }
      const match = sel.map(t => `"${t}"`).join(' OR ');
      const hits = db.prepare(
        `SELECT chunk_id, bm25(chunks_fts) AS rank FROM chunks_fts
         WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 80`
      ).all(match);
      let max = 0;
      for (const h of hits){ const s = Math.max(0, -h.rank); kwScores.set(h.chunk_id, s); if (s > max) max = s; }
      if (max > 0) for (const [k, v] of kwScores) kwScores.set(k, v / max);
    } else if (q.length >= 2){
      // 短查询回退 LIKE
      const hits = db.prepare(
        `SELECT c.id FROM chunks c WHERE (${where}) AND c.content LIKE ? LIMIT 60`
      ).all(...params, `%${q}%`);
      for (const h of hits) kwScores.set(h.id, 0.5);
    }
  } catch { /* fts 查询异常时忽略关键词通道 */ }

  // —— 向量得分 ——
  const hasEmb = rows.some(r => r.embedding);
  let vecScores = new Map();
  let vecAvailable = false;
  const embedModel = getModel('embedding');
  if (hasEmb && embedModel){
    try {
      const [qv] = await embed(embedModel, [text]);
      vecAvailable = !!qv;
      if (qv){
        for (const r of rows){
          if (!r.embedding) continue;
          try { vecScores.set(r.id, Math.max(0, cosine(qv, JSON.parse(r.embedding)))); } catch {}
        }
      }
    } catch { vecAvailable = false; }
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
      idx: r.idx, doc_name: r.doc_name || '会话附件', kb_name: r.kb_name || '', content: r.content, score,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter(s => s.score > 0.02);
}
