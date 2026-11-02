// 成果文件路径与名称安全：S-09 的第一道防线。
// 文件名只作为展示元数据；磁盘路径一律由内容哈希生成，绝不接受客户端路径。
import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR } from '../db.js';

export class ArtifactPathError extends Error {
  constructor(message, code = 'artifact_path_invalid'){
    super(message);
    this.name = 'ArtifactPathError';
    this.code = code;
    this.status = 400;
    this.retryable = false;
  }
}

export const MAX_ARTIFACT_NAME = 200;
export const MAX_STORAGE_NAME_BYTES = 255;

const CONTROL_RE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const DRIVE_RE = /^[a-zA-Z]:/;
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const STORAGE_KEY_RE = /^blobs\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

/** 规范 artifact 展示名：单段 basename，拒绝遍历、绝对路径、控制字符与保留名。 */
export function normalizeArtifactName(raw){
  if (typeof raw !== 'string') throw new ArtifactPathError('文件名必须是字符串');
  const name = raw.normalize('NFC').trim();
  if (!name) throw new ArtifactPathError('文件名不能为空');
  if (name.length > MAX_ARTIFACT_NAME) throw new ArtifactPathError(`文件名不能超过 ${MAX_ARTIFACT_NAME} 字符`);
  if (Buffer.byteLength(name, 'utf8') > MAX_STORAGE_NAME_BYTES) throw new ArtifactPathError('文件名过长');
  if (CONTROL_RE.test(name)) throw new ArtifactPathError('文件名包含控制字符');
  if (name.includes('/') || name.includes('\\')) throw new ArtifactPathError('文件名不能包含路径分隔符');
  if (name === '.' || name === '..' || name.startsWith('.')) throw new ArtifactPathError('文件名不能以点开头');
  if (DRIVE_RE.test(name)) throw new ArtifactPathError('不允许盘符路径');
  if (name.endsWith('.')) throw new ArtifactPathError('文件名不能以点结尾');
  if (RESERVED_RE.test(name)) throw new ArtifactPathError('文件名是系统保留名');
  return name;
}

export function extensionOf(name){
  const clean = String(name || '');
  const idx = clean.lastIndexOf('.');
  if (idx <= 0 || idx === clean.length - 1) return '';
  const ext = clean.slice(idx + 1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(ext) ? ext : '';
}

export function artifactRoot(){
  return path.join(DATA_DIR, 'artifacts');
}

export function blobRoot(){
  return path.join(artifactRoot(), 'blobs');
}

export function tmpRoot(){
  return path.join(artifactRoot(), 'tmp');
}

export function quarantineRoot(){
  return path.join(artifactRoot(), 'quarantine');
}

export function ensureArtifactDirs(){
  for (const dir of [artifactRoot(), blobRoot(), tmpRoot(), quarantineRoot()]){
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function storageKeyForSha(sha256){
  const sha = String(sha256 || '').toLowerCase();
  if (!SHA_RE.test(sha)) throw new ArtifactPathError('sha256 不合法', 'artifact_storage_invalid');
  return `blobs/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
}

export function assertSafeStorageKey(storageKey){
  const key = String(storageKey || '');
  if (!STORAGE_KEY_RE.test(key)) throw new ArtifactPathError('storage_key 不合法', 'artifact_storage_invalid');
  return key;
}

function realBlobRoot(){
  ensureArtifactDirs();
  return fs.realpathSync(blobRoot());
}

/** 把 storage_key 解析为真实文件路径：必须是普通文件、非 symlink、且位于 blobRoot 内。 */
export function canonicalBlobPath(storageKey){
  const key = assertSafeStorageKey(storageKey);
  const root = realBlobRoot();
  const rel = key.slice('blobs/'.length);
  const expected = path.join(root, rel);
  if (!expected.startsWith(root + path.sep)) throw new ArtifactPathError('路径越界', 'artifact_storage_invalid');
  let stat;
  try {
    stat = fs.lstatSync(expected);
  } catch {
    throw new ArtifactPathError('文件不存在', 'artifact_storage_invalid');
  }
  if (stat.isSymbolicLink()) throw new ArtifactPathError('不允许符号链接', 'artifact_storage_invalid');
  if (!stat.isFile()) throw new ArtifactPathError('不是普通文件', 'artifact_storage_invalid');
  const real = fs.realpathSync(expected);
  if (real !== expected) throw new ArtifactPathError('真实路径与预期不一致', 'artifact_storage_invalid');
  return expected;
}

/** 未落盘前计算最终路径（写新 blob 时目标可能尚不存在）。 */
export function blobPathForStorageKey(storageKey){
  const key = assertSafeStorageKey(storageKey);
  const rel = key.slice('blobs/'.length);
  const root = realBlobRoot();
  const target = path.join(root, rel);
  if (!target.startsWith(root + path.sep)) throw new ArtifactPathError('路径越界', 'artifact_storage_invalid');
  return target;
}

export function contentDisposition(name){
  const clean = normalizeArtifactName(name);
  const fallback = clean
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 150) || 'artifact';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}
