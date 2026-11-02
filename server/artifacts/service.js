// 成果服务：blob 存储 + 控制面元数据的唯一编排入口。
// 调用方只拿 artifact_id；storage_key 与磁盘路径永不外泄。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { withTransaction } from '../control/pg.js';
import {
  artifactMeta, withArtifactNameLock, upsertBlobRef, nextArtifactVersion,
  findActiveArtifactBySha, insertArtifact, incrementBlobRef, softDeleteArtifact,
  addAttachment, assertTaskArtifacts, countTaskArtifacts, countTaskBytes,
  listArtifacts, listArtifactsForUser, getArtifact, getArtifactWithBlob, getArtifactWithBlobByName,
  listGcCandidateBlobs, deleteBlobRow, recountBlobRefs, existingStorageKeys,
  lockBlobForGc, purgeDeletedArtifactsForBlob, countArtifactRowsForBlob,
} from '../control/artifact-repo.js';
import { appendEvent } from '../control/task-repo.js';
import { auditSafe } from '../control/audit-repo.js';
import { scanSecrets } from '../skills/secret-scan.js';
import {
  normalizeArtifactName, storageKeyForSha, quarantineRoot, blobRoot, ensureArtifactDirs,
} from './paths.js';
import { mimeForName, safeDownloadMime, assertUploadAllowed } from './mime.js';
import { writeBlob, readBlob, openBlobStream, listBlobFiles, deleteBlobFile, statBlob } from './blob-store.js';

export class ArtifactError extends Error {
  constructor(code, message, { status = 400, retryable = false } = {}){
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function asBuffer(value){
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new ArtifactError('artifact_invalid_content', '内容必须是 Buffer');
}

function iso(value){
  return value instanceof Date ? value.toISOString() : value || null;
}

function actorFor(createdBy){
  if (String(createdBy).startsWith('tool:')) return { actorType: 'tool', actorId: String(createdBy).slice(5) };
  if (String(createdBy).startsWith('user:')) return { actorType: 'user', actorId: String(createdBy).slice(5) };
  return { actorType: 'system', actorId: null };
}

async function assertLease(client, { tenantId, taskId, workerId, leaseEpoch }){
  const params = [tenantId, taskId, leaseEpoch];
  let where = 'tenant_id = $1 AND id = $2 AND lease_epoch = $3 AND status = \'running\' AND lease_expires_at > now()';
  if (workerId){ params.push(workerId); where += ' AND lease_owner = $4'; }
  const r = await client.query(`SELECT 1 FROM agent_tasks WHERE ${where}`, params);
  if (!r.rowCount) throw new ArtifactError('artifact_lease_lost', '任务租约已失效，不能写入成果', { status: 409, retryable: true });
}

export function createArtifactService({
  limits = config.artifacts,
  fileLimits = config.files,
} = {}){
  const lim = { ...config.artifacts, ...(limits || {}) };

  async function ingest({
    tenantId, taskId, stepId = null, toolCallId = null, workerId = null, leaseEpoch = null,
    name, kind = 'output', buffer, mime = null, createdBy = '', scan = false, dedupe = true,
  }){
    const safeName = normalizeArtifactName(name);
    if (!['input', 'output', 'intermediate'].includes(kind)){
      throw new ArtifactError('artifact_invalid_kind', 'artifact kind 不合法');
    }
    const data = asBuffer(buffer);
    if (!data.length) throw new ArtifactError('artifact_invalid_content', '内容不能为空');
    if (data.length > lim.maxBytes){
      throw new ArtifactError('artifact_too_large', `文件超过大小上限（${lim.maxBytes} 字节）`);
    }
    const finalMime = String(mime || mimeForName(safeName) || 'application/octet-stream');
    if (scan && scanSecrets(data.toString('utf8').slice(0, 200000), safeName).length){
      throw new ArtifactError('artifact_secret_detected', '成果内容疑似包含密钥，已拒绝写入');
    }

    const [count, bytes] = await Promise.all([
      countTaskArtifacts({ tenantId, taskId }),
      countTaskBytes({ tenantId, taskId }),
    ]);
    if (count >= lim.maxPerTask){
      throw new ArtifactError('artifact_quota_exceeded', `单任务成果数量超限（${lim.maxPerTask}）`);
    }
    if (bytes + data.length > lim.taskMaxBytes){
      throw new ArtifactError('artifact_quota_exceeded', `单任务成果总量超限（${lim.taskMaxBytes} 字节）`);
    }

    const written = writeBlob(data, { maxBytes: lim.maxBytes });
    const result = await withTransaction(async client => {
      if (leaseEpoch != null){
        await assertLease(client, { tenantId, taskId, workerId, leaseEpoch });
      }
      return withArtifactNameLock(client, { tenantId, taskId, name: safeName }, async () => {
        if (dedupe){
          const existing = await findActiveArtifactBySha(client, {
            tenantId, taskId, name: safeName, kind, sha256: written.sha256,
          });
          if (existing) return { meta: artifactMeta(existing), inserted: false };
        }
        const blob = await upsertBlobRef(client, {
          sha256: written.sha256, storageKey: written.storageKey, size: written.size, mime: finalMime,
        });
        if (blob.storage_key !== written.storageKey){
          throw new ArtifactError('artifact_storage_invalid', 'blob 存储键不一致', { status: 500 });
        }
        const version = await nextArtifactVersion(client, { tenantId, taskId, name: safeName });
        const row = await insertArtifact(client, {
          tenantId, taskId, stepId, blobId: blob.id, name: safeName, kind, version, createdBy,
        });
        await incrementBlobRef(client, blob.id);
        const actor = actorFor(createdBy);
        await appendEvent(client, {
          tenantId, taskId, type: 'artifact.created', ...actor,
          payload: {
            artifact_id: row.id, name: safeName, kind, version,
            size_bytes: data.length, sha256: written.sha256,
            tool_call_id: toolCallId,
          },
        });
        return {
          inserted: true,
          meta: {
            id: row.id, task_id: taskId, step_id: stepId, name: safeName, kind, version,
            visibility: 'task', download_policy: 'task_acl', mime: finalMime,
            size_bytes: data.length, sha256: written.sha256, created_by: createdBy,
            created_at: iso(row.created_at), deleted_at: null,
          },
        };
      });
    });
    // GC 与 ingest 可能并发：提交后确认文件仍在，缺失则按内容重建。
    try { statBlob(written.storageKey); }
    catch { writeBlob(data, { maxBytes: lim.maxBytes }); }
    return result.meta;
  }

  async function getForRead({ tenantId, taskId, artifactId = null, name = null, kind = null }){
    let artifact = null;
    if (artifactId){
      artifact = await getArtifactWithBlob({ tenantId, taskId, artifactId });
    } else if (name){
      artifact = await getArtifactWithBlobByName({ tenantId, taskId, name: normalizeArtifactName(name), kind });
    }
    if (!artifact) throw new ArtifactError('artifact_not_found', '成果不存在', { status: 404 });
    if (artifact.size_bytes > lim.maxBytes){
      throw new ArtifactError('artifact_too_large', '成果超过读取上限');
    }
    const buffer = readBlob(artifact.storage_key, { maxBytes: lim.maxBytes });
    return { artifact, buffer };
  }

  function list({ tenantId, taskId, includeDeleted = false, kind = null, limit = 200 }){
    return listArtifacts({ tenantId, taskId, includeDeleted, kind, limit });
  }

  function listForUser(options){
    return listArtifactsForUser(options);
  }

  async function listForPrompt({ tenantId, taskId, limit = 50 }){
    return listArtifacts({ tenantId, taskId, kind: null, limit });
  }

  async function download({ tenantId, taskId, artifactId, userId = null, ip = null, userAgent = null }){
    const artifact = await getArtifactWithBlob({ tenantId, taskId, artifactId });
    if (!artifact) throw new ArtifactError('artifact_not_found', '成果不存在', { status: 404 });
    if (artifact.download_policy !== 'task_acl' || artifact.visibility !== 'task'){
      throw new ArtifactError('artifact_forbidden', '成果下载策略禁止访问', { status: 403 });
    }
    let expectedKey;
    try {
      expectedKey = storageKeyForSha(artifact.sha256);
    } catch {
      throw new ArtifactError('artifact_storage_invalid', '成果存储信息不一致', { status: 404 });
    }
    if (expectedKey !== artifact.storage_key){
      throw new ArtifactError('artifact_storage_invalid', '成果存储信息不一致', { status: 404 });
    }
    let opened;
    try {
      opened = openBlobStream(artifact.storage_key);
    } catch {
      throw new ArtifactError('artifact_storage_invalid', '成果文件不可用', { status: 404 });
    }
    if (opened.stat.size !== artifact.size_bytes){
      try { opened.stream.destroy(); } catch {}
      throw new ArtifactError('artifact_storage_invalid', '成果文件大小不一致', { status: 404 });
    }
    const filename = normalizeArtifactName(artifact.name);
    await auditSafe({
      tenantId, actorType: 'user', actorId: userId, action: 'artifact.download',
      resourceType: 'artifact', resourceId: artifact.id, decision: 'allow', ip, userAgent,
      detail: { task_id: taskId, size_bytes: artifact.size_bytes, sha256_prefix: artifact.sha256.slice(0, 12) },
    });
    return {
      artifact,
      filename,
      mime: safeDownloadMime(artifact.mime),
      size: artifact.size_bytes,
      stream: opened.stream,
    };
  }

  async function attachUpload({ tenantId, taskId, userId, buffer, originalName, sourceRef = '', ip = null, userAgent = null }){
    const safeName = normalizeArtifactName(originalName);
    const { mime } = assertUploadAllowed(safeName, buffer);
    const artifact = await ingest({
      tenantId, taskId, name: safeName, kind: 'input', buffer, mime,
      createdBy: `user:${userId}`, scan: false,
    });
    await withTransaction(async client => {
      await addAttachment(client, {
        tenantId, taskId, artifactId: artifact.id, source: 'upload', sourceRef,
      });
      await appendEvent(client, {
        tenantId, taskId, type: 'artifact.attached', actorType: 'user', actorId: userId,
        payload: { artifact_id: artifact.id, name: artifact.name, size_bytes: artifact.size_bytes },
      });
    });
    await auditSafe({
      tenantId, actorType: 'user', actorId: userId, action: 'artifact.upload',
      resourceType: 'artifact', resourceId: artifact.id, decision: 'allow', ip, userAgent,
      detail: { task_id: taskId, size_bytes: artifact.size_bytes, sha256_prefix: artifact.sha256.slice(0, 12) },
    });
    return artifact;
  }

  async function softDelete({ tenantId, taskId, artifactId, userId = null, ip = null, userAgent = null }){
    const artifact = await getArtifact({ tenantId, taskId, artifactId });
    if (!artifact) throw new ArtifactError('artifact_not_found', '成果不存在', { status: 404 });
    const deleted = await withTransaction(async client => {
      const row = await softDeleteArtifact({ tenantId, taskId, artifactId, client });
      if (!row) return null;
      await appendEvent(client, {
        tenantId, taskId, type: 'artifact.deleted', actorType: 'user', actorId: userId,
        payload: { artifact_id: artifactId, name: artifact.name, version: artifact.version },
      });
      return row;
    });
    if (!deleted) throw new ArtifactError('artifact_not_found', '成果不存在', { status: 404 });
    await auditSafe({
      tenantId, actorType: 'user', actorId: userId, action: 'artifact.delete',
      resourceType: 'artifact', resourceId: artifactId, decision: 'allow', ip, userAgent,
      detail: { task_id: taskId },
    });
    return artifact;
  }

  async function assertFinishRefs({ tenantId, taskId, ids }){
    return assertTaskArtifacts({ tenantId, taskId, ids });
  }

  async function gc({ graceMs = lim.gcGraceMs, dryRun = false, limit = 100 } = {}){
    ensureArtifactDirs();
    const candidates = await listGcCandidateBlobs({ graceMs, limit });
    let blobsRemoved = 0;
    let bytesRemoved = 0;
    for (const blob of candidates){
      if (dryRun){ blobsRemoved += 1; bytesRemoved += Number(blob.size_bytes || 0); continue; }
      const removable = await withTransaction(async client => {
        const locked = await lockBlobForGc(client, blob.id);
        if (!locked) return false;
        // 软删除行仍通过外键引用 blob；超过宽限期后先清理元数据行。
        await purgeDeletedArtifactsForBlob(client, blob.id, graceMs);
        const remaining = await countArtifactRowsForBlob(client, blob.id);
        if (remaining > 0) return false;
        await deleteBlobRow(client, blob.id);
        return true;
      });
      if (!removable) continue;
      try { deleteBlobFile(blob.storage_key); } catch {}
      blobsRemoved += 1;
      bytesRemoved += Number(blob.size_bytes || 0);
    }

    const files = listBlobFiles();
    let orphans = 0;
    const keys = files.map(f => f.storageKey);
    const known = new Set();
    for (let i = 0; i < keys.length; i += 500){
      const found = await existingStorageKeys(keys.slice(i, i + 500));
      for (const key of found) known.add(key);
    }
    for (const file of files){
      if (known.has(file.storageKey)) continue;
      if (Date.now() - file.mtimeMs < graceMs) continue;
      if (!dryRun){
        ensureArtifactDirs();
        const target = path.join(quarantineRoot(), `${file.sha256}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`);
        try {
          fs.mkdirSync(quarantineRoot(), { recursive: true, mode: 0o700 });
          fs.renameSync(path.join(blobRoot(), file.storageKey.slice('blobs/'.length)), target);
        } catch {}
      }
      orphans += 1;
    }

    await auditSafe({
      action: 'artifact.gc', resourceType: 'artifact', decision: dryRun ? 'dry_run' : 'allow',
      detail: { blobs: blobsRemoved, bytes: bytesRemoved, orphans },
    });
    return { candidates: candidates.length, blobs_removed: blobsRemoved, bytes_removed: bytesRemoved, orphans_quarantined: orphans, dry_run: !!dryRun };
  }

  async function recountRefs(){
    const updated = await withTransaction(client => recountBlobRefs(client));
    return { updated };
  }

  return {
    ingest, getForRead, list, listForUser, listForPrompt, download, attachUpload, softDelete,
    assertFinishRefs, gc, recountRefs,
    limits: lim, fileLimits: { ...config.files, ...(fileLimits || {}) },
  };
}

let singleton = null;

export function getArtifactService(){
  if (!singleton) singleton = createArtifactService();
  return singleton;
}

export function resetArtifactService(){
  singleton = null;
}
