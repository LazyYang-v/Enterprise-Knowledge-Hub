// 成果文件控制面仓储：所有查询必须同时带 tenant_id 与 task_id。
import { getPool, withTransaction } from './pg.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ArtifactClaimError extends Error {
  constructor(message = 'artifact 不属于当前任务或已删除'){
    super(message);
    this.name = 'ArtifactClaimError';
    this.code = 'artifact_conflict';
  }
}

export function isArtifactId(value){
  return UUID_RE.test(String(value || ''));
}

function iso(value){
  return value instanceof Date ? value.toISOString() : value || null;
}

export function artifactMeta(row){
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    step_id: row.step_id || null,
    name: row.name,
    kind: row.kind,
    version: Number(row.version) || 1,
    visibility: row.visibility || 'task',
    download_policy: row.download_policy || 'task_acl',
    mime: row.mime || 'application/octet-stream',
    size_bytes: Number(row.size_bytes || 0),
    sha256: row.sha256 || '',
    created_by: row.created_by || '',
    created_at: iso(row.created_at),
    deleted_at: iso(row.deleted_at),
  };
}

const SELECT_META = `
  SELECT a.id, a.task_id, a.step_id, a.name, a.kind, a.version, a.visibility,
         a.download_policy, a.created_by, a.created_at, a.deleted_at,
         b.sha256, b.size_bytes, b.mime
    FROM artifacts a
    JOIN artifact_blobs b ON b.id = a.blob_id`;

/** 事务内按 (tenant, task, name) 加 advisory lock，避免并发版本竞争。 */
export async function withArtifactNameLock(client, { tenantId, taskId, name }, fn){
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${tenantId}:${taskId}:${name}`]);
  return fn();
}

export async function upsertBlobRef(client, { sha256, storageKey, size, mime }){
  const r = await client.query(
    `INSERT INTO artifact_blobs (sha256, storage_key, size_bytes, mime, ref_count)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (sha256) DO UPDATE SET mime = artifact_blobs.mime
     RETURNING *`,
    [sha256, storageKey, size, mime || 'application/octet-stream'],
  );
  return r.rows[0];
}

export async function nextArtifactVersion(client, { tenantId, taskId, name }){
  const r = await client.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS version
       FROM artifacts WHERE tenant_id = $1 AND task_id = $2 AND name = $3`,
    [tenantId, taskId, name],
  );
  return Number(r.rows[0].version) || 1;
}

export async function findActiveArtifactBySha(client, { tenantId, taskId, name, kind, sha256 }){
  const r = await client.query(
    `${SELECT_META}
      WHERE a.tenant_id = $1 AND a.task_id = $2 AND a.name = $3 AND a.kind = $4
        AND a.deleted_at IS NULL AND b.sha256 = $5
      ORDER BY a.version DESC LIMIT 1`,
    [tenantId, taskId, name, kind, sha256],
  );
  return r.rows[0] || null;
}

export async function insertArtifact(client, {
  tenantId, taskId, stepId = null, blobId, name, kind = 'output', version = 1, createdBy = '',
}){
  const r = await client.query(
    `INSERT INTO artifacts (tenant_id, task_id, step_id, blob_id, name, kind, version, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [tenantId, taskId, stepId, blobId, name, kind, version, createdBy],
  );
  return r.rows[0];
}

export async function incrementBlobRef(client, blobId){
  const r = await client.query(
    'UPDATE artifact_blobs SET ref_count = ref_count + 1 WHERE id = $1 RETURNING ref_count',
    [blobId],
  );
  return Number(r.rows[0]?.ref_count || 0);
}

export async function decrementBlobRef(client, blobId){
  const r = await client.query(
    'UPDATE artifact_blobs SET ref_count = GREATEST(ref_count - 1, 0) WHERE id = $1 RETURNING ref_count',
    [blobId],
  );
  return Number(r.rows[0]?.ref_count || 0);
}

export async function listArtifacts({ tenantId, taskId, includeDeleted = false, kind = null, limit = 200 }){
  const params = [tenantId, taskId];
  let where = 'a.tenant_id = $1 AND a.task_id = $2';
  if (!includeDeleted) where += ' AND a.deleted_at IS NULL';
  if (kind){ params.push(kind); where += ` AND a.kind = $${params.length}`; }
  params.push(Math.min(Math.max(Number(limit) || 200, 1), 500));
  const r = await getPool().query(
    `${SELECT_META} WHERE ${where} ORDER BY a.created_at DESC, a.version DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows.map(artifactMeta);
}

export async function getArtifact({ tenantId, taskId, artifactId, includeDeleted = false }){
  if (!isArtifactId(artifactId)) return null;
  const r = await getPool().query(
    `${SELECT_META} WHERE a.tenant_id = $1 AND a.task_id = $2 AND a.id = $3
       ${includeDeleted ? '' : 'AND a.deleted_at IS NULL'}`,
    [tenantId, taskId, artifactId],
  );
  return r.rows[0] ? artifactMeta(r.rows[0]) : null;
}

export async function getArtifactWithBlob({ tenantId, taskId, artifactId, client = null }){
  if (!isArtifactId(artifactId)) return null;
  const q = client ? client.query.bind(client) : getPool().query.bind(getPool());
  const r = await q(
    `SELECT a.*, b.sha256, b.storage_key, b.size_bytes, b.mime, b.ref_count
       FROM artifacts a JOIN artifact_blobs b ON b.id = a.blob_id
      WHERE a.tenant_id = $1 AND a.task_id = $2 AND a.id = $3 AND a.deleted_at IS NULL`,
    [tenantId, taskId, artifactId],
  );
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    ...artifactMeta(row),
    blob_id: row.blob_id,
    storage_key: row.storage_key,
    ref_count: Number(row.ref_count || 0),
  };
}

export async function getArtifactByName({ tenantId, taskId, name, kind = null }){
  const params = [tenantId, taskId, name];
  let where = 'a.tenant_id = $1 AND a.task_id = $2 AND a.name = $3 AND a.deleted_at IS NULL';
  if (kind){ params.push(kind); where += ` AND a.kind = $${params.length}`; }
  const r = await getPool().query(
    `${SELECT_META} WHERE ${where} ORDER BY a.version DESC LIMIT 1`,
    params,
  );
  if (!r.rows[0]) return null;
  return {
    ...artifactMeta(r.rows[0]),
    storage_key: null,
  };
}

export async function getArtifactWithBlobByName({ tenantId, taskId, name, kind = null }){
  const params = [tenantId, taskId, name];
  let where = 'a.tenant_id = $1 AND a.task_id = $2 AND a.name = $3 AND a.deleted_at IS NULL';
  if (kind){ params.push(kind); where += ` AND a.kind = $${params.length}`; }
  const r = await getPool().query(
    `SELECT a.*, b.sha256, b.storage_key, b.size_bytes, b.mime, b.ref_count
       FROM artifacts a JOIN artifact_blobs b ON b.id = a.blob_id
      WHERE ${where} ORDER BY a.version DESC LIMIT 1`,
    params,
  );
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    ...artifactMeta(row),
    blob_id: row.blob_id,
    storage_key: row.storage_key,
    ref_count: Number(row.ref_count || 0),
  };
}

export async function softDeleteArtifact({ tenantId, taskId, artifactId, client = null }){
  const run = async c => {
    const r = await c.query(
      `UPDATE artifacts SET deleted_at = now()
        WHERE tenant_id = $1 AND task_id = $2 AND id = $3 AND deleted_at IS NULL
        RETURNING *`,
      [tenantId, taskId, artifactId],
    );
    if (!r.rowCount) return null;
    await c.query(
      'DELETE FROM task_attachments WHERE tenant_id = $1 AND task_id = $2 AND artifact_id = $3',
      [tenantId, taskId, artifactId],
    );
    await decrementBlobRef(c, r.rows[0].blob_id);
    return r.rows[0];
  };
  return client ? run(client) : withTransaction(run);
}

export async function addAttachment(client, { tenantId, taskId, artifactId, source = 'upload', sourceRef = '' }){
  const r = await client.query(
    `INSERT INTO task_attachments (tenant_id, task_id, artifact_id, source, source_ref)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (task_id, artifact_id) DO NOTHING
     RETURNING *`,
    [tenantId, taskId, artifactId, source, sourceRef],
  );
  if (r.rows[0]) return r.rows[0];
  const existing = await client.query(
    'SELECT * FROM task_attachments WHERE tenant_id = $1 AND task_id = $2 AND artifact_id = $3',
    [tenantId, taskId, artifactId],
  );
  return existing.rows[0] || null;
}

/** 校验 ids 全部存在、属于本任务且未删除；数量不一致抛 ArtifactClaimError。 */
export async function assertTaskArtifacts({ tenantId, taskId, ids, client = null }){
  const list = [...new Set((ids || []).map(String))];
  if (!list.length) return [];
  if (!list.every(isArtifactId)) throw new ArtifactClaimError('artifact_refs 含非法 ID');
  const q = client ? client.query.bind(client) : getPool().query.bind(getPool());
  const r = await q(
    `SELECT id FROM artifacts
      WHERE tenant_id = $1 AND task_id = $2 AND deleted_at IS NULL AND id = ANY($3::uuid[])`,
    [tenantId, taskId, list],
  );
  if (r.rowCount !== list.length) throw new ArtifactClaimError();
  return r.rows.map(x => x.id);
}

export async function countTaskArtifacts({ tenantId, taskId }){
  const r = await getPool().query(
    `SELECT COUNT(*)::int AS n FROM artifacts
      WHERE tenant_id = $1 AND task_id = $2 AND deleted_at IS NULL`,
    [tenantId, taskId],
  );
  return Number(r.rows[0].n || 0);
}

export async function countTaskBytes({ tenantId, taskId }){
  const r = await getPool().query(
    `SELECT COALESCE(SUM(b.size_bytes), 0)::bigint AS n
       FROM artifacts a JOIN artifact_blobs b ON b.id = a.blob_id
      WHERE a.tenant_id = $1 AND a.task_id = $2 AND a.deleted_at IS NULL`,
    [tenantId, taskId],
  );
  return Number(r.rows[0].n || 0);
}

export async function listGcCandidateBlobs({ graceMs, limit = 100 }){
  const r = await getPool().query(
    `SELECT b.* FROM artifact_blobs b
      WHERE b.created_at < now() - ($1::double precision * interval '1 millisecond')
        AND NOT EXISTS (
          SELECT 1 FROM artifacts a WHERE a.blob_id = b.id AND a.deleted_at IS NULL
        )
      ORDER BY b.created_at ASC LIMIT $2`,
    [Math.max(0, Number(graceMs) || 0), Math.min(Math.max(Number(limit) || 100, 1), 1000)],
  );
  return r.rows;
}

export async function deleteBlobRow(client, blobId){
  await client.query('DELETE FROM artifact_blobs WHERE id = $1', [blobId]);
}

/** GC 时锁住 blob 行，阻止并发 ingest 在同一事务内复用。 */
export async function lockBlobForGc(client, blobId){
  const r = await client.query(
    'SELECT * FROM artifact_blobs WHERE id = $1 FOR UPDATE',
    [blobId],
  );
  return r.rows[0] || null;
}

/** 清理超过宽限期的软删除 artifact 行（保留事件与审计）。 */
export async function purgeDeletedArtifactsForBlob(client, blobId, graceMs){
  const r = await client.query(
    `DELETE FROM artifacts
      WHERE blob_id = $1 AND deleted_at IS NOT NULL
        AND deleted_at < now() - ($2::double precision * interval '1 millisecond')`,
    [blobId, Math.max(0, Number(graceMs) || 0)],
  );
  return r.rowCount;
}

export async function countArtifactRowsForBlob(client, blobId){
  const r = await client.query(
    'SELECT COUNT(*)::int AS n FROM artifacts WHERE blob_id = $1',
    [blobId],
  );
  return Number(r.rows[0].n || 0);
}

export async function recountBlobRefs(client){
  const r = await client.query(
    `UPDATE artifact_blobs b
        SET ref_count = (
          SELECT COUNT(*) FROM artifacts a WHERE a.blob_id = b.id AND a.deleted_at IS NULL
        )`,
  );
  return r.rowCount;
}

export async function existingStorageKeys(keys){
  if (!keys.length) return new Set();
  const r = await getPool().query(
    'SELECT storage_key FROM artifact_blobs WHERE storage_key = ANY($1::text[])',
    [keys],
  );
  return new Set(r.rows.map(x => x.storage_key));
}

export { withTransaction };
