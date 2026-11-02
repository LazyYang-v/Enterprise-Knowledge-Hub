// 证据快照仓储：所有查询都必须带 tenant_id（+ task_id）隔离。
import { getPool, withTransaction } from './pg.js';
import { LeaseLostError } from './task-repo.js';

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
 * 同一 (tenant, task, chunk, content_hash) 只保留一行；新领取重新检索时改绑到该领取。
 * 提供 leaseEpoch 时先校验任务仍处于该领取的未到期 running 状态，过期领取不能写入。
 */
export async function insertEvidenceSnapshots({
  tenantId, taskId, stepId = null, toolCallId = null, items = [], leaseEpoch = null,
}, client = null){
  const execute = async q => {
    if (leaseEpoch != null){
      const owned = await q(
        `SELECT 1 FROM agent_tasks
          WHERE tenant_id = $1 AND id = $2 AND lease_epoch = $3
            AND status = 'running' AND lease_expires_at > now()`,
        [tenantId, taskId, leaseEpoch],
      );
      if (!owned.rowCount) throw new LeaseLostError('证据写入不属于当前领取');
    }
    const out = [];
    for (const item of items){
      const e = evidenceFromItem(item);
      const rebind = leaseEpoch != null
        ? `lease_epoch = EXCLUDED.lease_epoch, step_id = EXCLUDED.step_id, retrieved_at = now()`
        : `lease_epoch = agent_evidence.lease_epoch`;
      if (e.chunk_id){
        const r = await q(
          `INSERT INTO agent_evidence
             (tenant_id, task_id, step_id, tool_call_id, kb_id, document_id, document_version,
              chunk_id, content_hash, locator_json, excerpt, score, title, kb_name, lease_epoch)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15)
           ON CONFLICT (tenant_id, task_id, chunk_id, content_hash) WHERE chunk_id IS NOT NULL
           DO UPDATE SET ${rebind}
           RETURNING *, (xmax = 0) AS inserted`,
          [tenantId, taskId, uuidOrNull(stepId), uuidOrNull(toolCallId), e.kb_id, e.document_id,
            e.document_version, e.chunk_id, e.content_hash, JSON.stringify(e.locator_json),
            e.excerpt, e.score, e.title, e.kb_name, leaseEpoch],
        );
        const { inserted, ...row } = r.rows[0];
        out.push({ row, inserted: !!inserted });
        continue;
      }
      const r = await q(
        `INSERT INTO agent_evidence
           (tenant_id, task_id, step_id, tool_call_id, kb_id, document_id, document_version,
            chunk_id, content_hash, locator_json, excerpt, score, title, kb_name, lease_epoch)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9::jsonb,$10,$11,$12,$13,$14)
         RETURNING *`,
        [tenantId, taskId, uuidOrNull(stepId), uuidOrNull(toolCallId), e.kb_id, e.document_id,
          e.document_version, e.content_hash, JSON.stringify(e.locator_json), e.excerpt, e.score,
          e.title, e.kb_name, leaseEpoch],
      );
      out.push({ row: r.rows[0], inserted: true });
    }
    return out;
  };
  if (client) return execute(client.query.bind(client));
  if (leaseEpoch != null) return withTransaction(c => execute(c.query.bind(c)));
  return execute(getPool().query.bind(getPool()));
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

export async function getEvidenceByIds({ tenantId, taskId, ids = [], leaseEpoch = null }){
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!list.length) return [];
  const params = [tenantId, taskId, list];
  let where = 'tenant_id = $1 AND task_id = $2 AND id = ANY($3::uuid[])';
  if (leaseEpoch != null){
    params.push(leaseEpoch);
    where += ' AND lease_epoch = $4';
  }
  const r = await getPool().query(
    `SELECT * FROM agent_evidence WHERE ${where}`,
    params,
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
