// 证据快照仓储：所有查询都必须带 tenant_id（+ task_id）隔离。
import { getPool } from './pg.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrNull(value){
  const s = String(value || '');
  return UUID_RE.test(s) ? s : null;
}

function evidenceFromItem(item){
  return {
    kb_id: item.kb_id ? String(item.kb_id) : null,
    document_id: item.document_id ? String(item.document_id) : null,
    document_version: Number.isInteger(Number(item.document_version)) && Number(item.document_version) > 0
      ? Number(item.document_version) : null,
    chunk_id: item.chunk_id ? String(item.chunk_id) : null,
    content_hash: String(item.content_hash || ''),
    locator_json: item.locator_json ?? item.locator ?? {},
    excerpt: String(item.excerpt ?? item.content ?? '').slice(0, 2000),
    score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
    title: String(item.title || item.doc_name || '').slice(0, 300),
    kb_name: String(item.kb_name || item.kbName || '').slice(0, 200),
  };
}

/**
 * 幂等写入证据快照。返回与 items 同序的 [{ row, inserted }]。
 * 同一 (tenant, task, chunk, content_hash) 只保留一行，冲突时回读已有行。
 */
export async function insertEvidenceSnapshots({
  tenantId, taskId, stepId = null, toolCallId = null, items = [],
}, client = null){
  const q = client ? client.query.bind(client) : getPool().query.bind(getPool());
  const out = [];
  for (const item of items){
    const e = evidenceFromItem(item);
    let row = null;
    if (e.chunk_id){
      const r = await q(
        `INSERT INTO agent_evidence
           (tenant_id, task_id, step_id, tool_call_id, kb_id, document_id, document_version,
            chunk_id, content_hash, locator_json, excerpt, score, title, kb_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)
         ON CONFLICT (tenant_id, task_id, chunk_id, content_hash) WHERE chunk_id IS NOT NULL
         DO NOTHING
         RETURNING *`,
        [tenantId, taskId, uuidOrNull(stepId), uuidOrNull(toolCallId), e.kb_id, e.document_id,
          e.document_version, e.chunk_id, e.content_hash, JSON.stringify(e.locator_json),
          e.excerpt, e.score, e.title, e.kb_name],
      );
      row = r.rows[0] || null;
    } else {
      const r = await q(
        `INSERT INTO agent_evidence
           (tenant_id, task_id, step_id, tool_call_id, kb_id, document_id, document_version,
            chunk_id, content_hash, locator_json, excerpt, score, title, kb_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9::jsonb,$10,$11,$12,$13)
         RETURNING *`,
        [tenantId, taskId, uuidOrNull(stepId), uuidOrNull(toolCallId), e.kb_id, e.document_id,
          e.document_version, e.content_hash, JSON.stringify(e.locator_json), e.excerpt, e.score,
          e.title, e.kb_name],
      );
      row = r.rows[0] || null;
    }
    const inserted = !!row;
    if (!row && e.chunk_id){
      const r = await q(
        `SELECT * FROM agent_evidence
          WHERE tenant_id = $1 AND task_id = $2 AND chunk_id = $3 AND content_hash = $4
          ORDER BY retrieved_at ASC, id LIMIT 1`,
        [tenantId, taskId, e.chunk_id, e.content_hash],
      );
      row = r.rows[0] || null;
    }
    out.push({ row, inserted });
  }
  return out;
}

export async function getPinnedVersions({ tenantId, taskId }){
  const r = await getPool().query(
    `SELECT DISTINCT ON (document_id) document_id, document_version
       FROM agent_evidence
      WHERE tenant_id = $1 AND task_id = $2 AND document_id IS NOT NULL
        AND document_version IS NOT NULL
      ORDER BY document_id, retrieved_at ASC, id ASC`,
    [tenantId, taskId],
  );
  const map = {};
  for (const row of r.rows) map[row.document_id] = Number(row.document_version);
  return map;
}

export async function listEvidence({ tenantId, taskId, limit = 100 }){
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const r = await getPool().query(
    `SELECT * FROM agent_evidence WHERE tenant_id = $1 AND task_id = $2
      ORDER BY retrieved_at ASC, id ASC LIMIT $3`,
    [tenantId, taskId, n],
  );
  return r.rows;
}

export async function countEvidence({ tenantId, taskId }){
  const r = await getPool().query(
    'SELECT COUNT(*)::int AS n FROM agent_evidence WHERE tenant_id = $1 AND task_id = $2',
    [tenantId, taskId],
  );
  return r.rows[0]?.n || 0;
}

export async function getEvidence({ tenantId, taskId, evidenceId }){
  const r = await getPool().query(
    'SELECT * FROM agent_evidence WHERE tenant_id = $1 AND task_id = $2 AND id = $3',
    [tenantId, taskId, evidenceId],
  );
  return r.rows[0] || null;
}

export async function getEvidenceByIds({ tenantId, taskId, ids = [] }){
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!list.length) return [];
  const r = await getPool().query(
    `SELECT * FROM agent_evidence WHERE tenant_id = $1 AND task_id = $2 AND id = ANY($3::uuid[])`,
    [tenantId, taskId, list],
  );
  return r.rows;
}

export async function getEvidenceForUser({ tenantId, evidenceId, userId }){
  const r = await getPool().query(
    `SELECT e.* FROM agent_evidence e
       JOIN agent_tasks t ON t.id = e.task_id AND t.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1 AND e.id = $2 AND t.owner_id = $3`,
    [tenantId, evidenceId, userId],
  );
  return r.rows[0] || null;
}
