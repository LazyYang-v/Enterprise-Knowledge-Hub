// 内容寻址 blob 存储：原子写入、去重、大小上限与路径校验。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ArtifactPathError, artifactRoot, blobRoot, tmpRoot, ensureArtifactDirs,
  storageKeyForSha, canonicalBlobPath, blobPathForStorageKey, assertSafeStorageKey,
} from './paths.js';

export function hashBytes(buffer){
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function asBuffer(value){
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new ArtifactPathError('内容必须是 Buffer', 'artifact_invalid_content');
}

/**
 * 写入内容寻址 blob。已存在同内容时校验大小后复用，不重复落盘。
 * 返回 { sha256, storageKey, size, created }。
 */
export function writeBlob(value, { maxBytes = Number.MAX_SAFE_INTEGER } = {}){
  const buffer = asBuffer(value);
  if (buffer.length === 0) throw new ArtifactPathError('内容为空', 'artifact_invalid_content');
  if (buffer.length > maxBytes){
    throw new ArtifactPathError(`文件超过大小上限（${maxBytes} 字节）`, 'artifact_too_large');
  }
  ensureArtifactDirs();
  const sha256 = hashBytes(buffer);
  const storageKey = storageKeyForSha(sha256);
  const target = blobPathForStorageKey(storageKey);

  if (fs.existsSync(target)){
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== buffer.length){
      throw new ArtifactPathError('已有 blob 与内容不一致', 'artifact_storage_invalid');
    }
    return { sha256, storageKey, size: stat.size, created: false };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = path.join(tmpRoot(), `${crypto.randomUUID()}.part`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, buffer, 0, buffer.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
  } catch (e){
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    if (e instanceof ArtifactPathError) throw e;
    throw new ArtifactPathError(`blob 写入失败：${e.message}`, 'artifact_storage_invalid');
  }
  return { sha256, storageKey, size: buffer.length, created: true };
}

export function statBlob(storageKey){
  const file = canonicalBlobPath(storageKey);
  return fs.statSync(file);
}

export function readBlob(storageKey, { maxBytes = Number.MAX_SAFE_INTEGER } = {}){
  const file = canonicalBlobPath(storageKey);
  const stat = fs.statSync(file);
  if (stat.size > maxBytes){
    throw new ArtifactPathError(`文件超过读取上限（${maxBytes} 字节）`, 'artifact_too_large');
  }
  return fs.readFileSync(file);
}

export function openBlobStream(storageKey){
  const file = canonicalBlobPath(storageKey);
  const stat = fs.statSync(file);
  return { path: file, stat, stream: fs.createReadStream(file) };
}

export function deleteBlobFile(storageKey){
  const key = assertSafeStorageKey(storageKey);
  const file = blobPathForStorageKey(key);
  try { fs.unlinkSync(file); return true; }
  catch (e){ if (e.code === 'ENOENT') return false; throw e; }
}

/** 列出磁盘上所有合法 blob 文件（供孤儿巡检）。 */
export function listBlobFiles(){
  const root = blobRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const aa of fs.readdirSync(root, { withFileTypes: true })){
    if (!aa.isDirectory() || !/^[0-9a-f]{2}$/.test(aa.name)) continue;
    for (const bb of fs.readdirSync(path.join(root, aa.name), { withFileTypes: true })){
      if (!bb.isDirectory() || !/^[0-9a-f]{2}$/.test(bb.name)) continue;
      for (const file of fs.readdirSync(path.join(root, aa.name, bb.name), { withFileTypes: true })){
        if (!file.isFile() || !/^[0-9a-f]{64}$/.test(file.name)) continue;
        const storageKey = assertSafeStorageKey(`blobs/${aa.name}/${bb.name}/${file.name}`);
        const full = path.join(root, aa.name, bb.name, file.name);
        const stat = fs.lstatSync(full);
        out.push({ storageKey, size: stat.size, mtimeMs: stat.mtimeMs, sha256: file.name });
      }
    }
  }
  return out;
}

export { artifactRoot, blobRoot, tmpRoot };
