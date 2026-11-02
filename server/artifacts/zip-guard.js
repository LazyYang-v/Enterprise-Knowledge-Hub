// ZIP 统一护栏：zip-slip、符号链接、加密条目、重复名与 zip bomb。
// 只做内存解压；绝不按条目名写盘。
import AdmZip from 'adm-zip';

export class ZipGuardError extends Error {
  constructor(message, code = 'archive_unsafe_entry'){
    super(message);
    this.name = 'ZipGuardError';
    this.code = code;
  }
}

export const DEFAULT_ZIP_LIMITS = Object.freeze({
  maxEntries: 200,
  maxEntryBytes: 10 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
  maxRatio: 100,
  maxNameBytes: 1024,
});

const CONTROL_RE = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;
const DRIVE_RE = /^[a-zA-Z]:/;
const RATIO_THRESHOLD = 1024 * 1024;

export function normalizeZipEntryName(raw){
  if (typeof raw !== 'string' || !raw) throw new ZipGuardError('ZIP 条目名为空');
  const name = raw.normalize('NFC').replace(/\\/g, '/');
  if (CONTROL_RE.test(name)) throw new ZipGuardError('ZIP 条目名包含控制字符');
  if (name.startsWith('/') || DRIVE_RE.test(name)) throw new ZipGuardError('ZIP 条目使用绝对路径');
  if (Buffer.byteLength(name, 'utf8') > DEFAULT_ZIP_LIMITS.maxNameBytes) throw new ZipGuardError('ZIP 条目名过长');
  const isDir = name.endsWith('/');
  const segs = name.split('/');
  for (let i = 0; i < segs.length; i += 1){
    const seg = segs[i];
    if (seg === '..') throw new ZipGuardError('ZIP 条目包含路径遍历');
    if (seg === '.') throw new ZipGuardError('ZIP 条目包含当前目录段');
    if (seg === '' && !(isDir && i === segs.length - 1)) throw new ZipGuardError('ZIP 条目包含空路径段');
  }
  return name;
}

function limitsOf(limits){
  return { ...DEFAULT_ZIP_LIMITS, ...(limits || {}) };
}

function unixModeOf(entry){
  return ((entry.header?.attr || 0) >>> 16) & 0o170000;
}

/** 校验整个 ZIP；返回 adm-zip 实例与规范化条目列表。 */
export function inspectZip(buffer, limits = DEFAULT_ZIP_LIMITS){
  const lim = limitsOf(limits);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ZipGuardError('ZIP 内容为空', 'archive_invalid');
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new ZipGuardError('不是有效的 ZIP 文件', 'archive_invalid');
  }
  let rawEntries;
  try {
    rawEntries = zip.getEntries();
  } catch {
    throw new ZipGuardError('ZIP 目录损坏', 'archive_invalid');
  }
  if (rawEntries.length > lim.maxEntries) throw new ZipGuardError('ZIP 条目数超限', 'archive_too_large');

  const seen = new Set();
  const entries = [];
  let totalUncompressed = 0;
  let totalCompressed = 0;

  for (const entry of rawEntries){
    const name = normalizeZipEntryName(entry.entryName);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ZipGuardError(`ZIP 条目重复：${name}`);
    seen.add(key);

    if ((entry.header?.flags || 0) & 1) throw new ZipGuardError('不支持加密 ZIP 条目');
    const mode = unixModeOf(entry);
    if (mode === 0o120000) throw new ZipGuardError('ZIP 包含符号链接条目');
    if (mode === 0o020000 || mode === 0o010000) throw new ZipGuardError('ZIP 包含设备/FIFO 条目');

    const size = Number(entry.header?.size || 0);
    const compressedSize = Number(entry.header?.compressedSize || 0);
    if (!Number.isFinite(size) || size < 0) throw new ZipGuardError('ZIP 条目大小非法', 'archive_invalid');
    if (size > lim.maxEntryBytes) throw new ZipGuardError('ZIP 单条目解压超限', 'archive_too_large');
    totalUncompressed += size;
    totalCompressed += Math.max(0, compressedSize);
    if (totalUncompressed > lim.maxTotalBytes) throw new ZipGuardError('ZIP 总解压大小超限', 'archive_too_large');
    if (entry.isDirectory && size !== 0) throw new ZipGuardError('ZIP 目录条目包含数据');

    if (size > RATIO_THRESHOLD){
      if (compressedSize <= 0) throw new ZipGuardError('ZIP 条目压缩比异常', 'archive_too_large');
      if (size / compressedSize > lim.maxRatio) throw new ZipGuardError('ZIP 条目压缩比超限', 'archive_too_large');
    }

    entries.push({
      name, size, compressedSize,
      isDir: !!entry.isDirectory,
    });
  }

  return { zip, entries, totalUncompressed, totalCompressed };
}

/** 读取单个条目；再次校验实际解压大小。 */
export function readZipEntry(zip, name, limits = DEFAULT_ZIP_LIMITS){
  const lim = limitsOf(limits);
  const entry = zip.getEntry(name);
  if (!entry) throw new ZipGuardError(`ZIP 条目不存在：${name}`, 'archive_entry_not_found');
  if (entry.isDirectory) return Buffer.alloc(0);
  let data;
  try {
    data = entry.getData();
  } catch {
    throw new ZipGuardError('ZIP 条目解压失败', 'archive_invalid');
  }
  if (data.length > lim.maxEntryBytes) throw new ZipGuardError('ZIP 单条目解压超限', 'archive_too_large');
  return data;
}

/** 生成 ZIP；条目名、重复与总量都经过同一套校验。 */
export function buildZip(entries, limits = DEFAULT_ZIP_LIMITS){
  const lim = limitsOf(limits);
  if (!Array.isArray(entries) || entries.length === 0) throw new ZipGuardError('ZIP 至少需要一个条目', 'archive_empty');
  if (entries.length > lim.maxEntries) throw new ZipGuardError('ZIP 条目数超限', 'archive_too_large');
  const seen = new Set();
  const zip = new AdmZip();
  let total = 0;
  for (const item of entries){
    const name = normalizeZipEntryName(item?.name);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ZipGuardError(`ZIP 条目重复：${name}`);
    seen.add(key);
    const data = Buffer.isBuffer(item?.data) ? item.data : Buffer.from(String(item?.data ?? ''), 'utf8');
    if (data.length > lim.maxEntryBytes) throw new ZipGuardError('ZIP 单条目超限', 'archive_too_large');
    total += data.length;
    if (total > lim.maxTotalBytes) throw new ZipGuardError('ZIP 总大小超限', 'archive_too_large');
    zip.addFile(name, data);
  }
  return zip.toBuffer();
}
