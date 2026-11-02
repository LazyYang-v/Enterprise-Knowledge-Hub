// 上传类型 allowlist 与下载 MIME 降级：不信任 multipart 的 Content-Type。
import { extensionOf, ArtifactPathError } from './paths.js';

const EXT_MIME = Object.freeze({
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  json: 'application/json; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
});

export const UPLOAD_EXTENSIONS = Object.freeze(new Set(Object.keys(EXT_MIME)));

const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'xml', 'html', 'htm']);
const ZIP_EXTS = new Set(['zip', 'docx', 'xlsx', 'pptx']);

const ACTIVE_MIME_RE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/javascript|text\/javascript)/i;

export class ArtifactTypeError extends Error {
  constructor(message, code = 'artifact_unsupported_type'){
    super(message);
    this.name = 'ArtifactTypeError';
    this.code = code;
    this.status = 400;
    this.retryable = false;
  }
}

export function mimeForName(name){
  return EXT_MIME[extensionOf(name)] || 'application/octet-stream';
}

export function isTextMime(mime){
  return /^text\//i.test(String(mime || '')) || /^application\/(json|xml|yaml)/i.test(String(mime || ''));
}

export function isTextExtension(ext){
  return TEXT_EXTS.has(String(ext || '').toLowerCase());
}

/** 下载一律降级危险类型，避免浏览器把成果当活动内容执行。 */
export function safeDownloadMime(mime){
  const value = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!value) return 'application/octet-stream';
  if (ACTIVE_MIME_RE.test(value)) return 'application/octet-stream';
  if (/^text\/plain$/.test(value)) return 'text/plain; charset=utf-8';
  if (/^text\/(markdown|csv|tab-separated-values|yaml)$/.test(value)) return value;
  if (/^application\/(json|xml|pdf|zip)$/.test(value)) return value;
  if (/^image\/(png|jpeg|webp|gif)$/.test(value)) return value;
  if (/^application\/vnd\.openxmlformats-officedocument\./.test(value)) return value;
  return 'application/octet-stream';
}

function startsWith(buffer, bytes){
  if (buffer.length < bytes.length) return false;
  return bytes.every((b, i) => buffer[i] === b);
}

function isZip(buffer){
  return startsWith(buffer, [0x50, 0x4b]) && (
    (buffer[2] === 0x03 && buffer[3] === 0x04)
    || (buffer[2] === 0x05 && buffer[3] === 0x06)
    || (buffer[2] === 0x07 && buffer[3] === 0x08)
  );
}

function hasNul(buffer, limit = 8192){
  const end = Math.min(buffer.length, limit);
  for (let i = 0; i < end; i += 1) if (buffer[i] === 0) return true;
  return false;
}

function matchesFamily(ext, buffer){
  if (ZIP_EXTS.has(ext)) return isZip(buffer);
  if (ext === 'pdf') return startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  if (ext === 'png') return startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (ext === 'jpg' || ext === 'jpeg') return startsWith(buffer, [0xff, 0xd8, 0xff]);
  if (ext === 'gif') return startsWith(buffer, [0x47, 0x49, 0x46, 0x38]);
  if (ext === 'webp'){
    return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  if (TEXT_EXTS.has(ext)) return !hasNul(buffer);
  return false;
}

/** 校验上传文件名与内容：扩展名 allowlist + magic bytes；返回可信 MIME。 */
export function assertUploadAllowed(name, buffer){
  const ext = extensionOf(name);
  if (!UPLOAD_EXTENSIONS.has(ext)) throw new ArtifactTypeError(`不支持的文件类型：${ext || '未知'}`, 'artifact_unsupported_type');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ArtifactTypeError('文件内容为空', 'artifact_invalid_content');
  if (!matchesFamily(ext, buffer)) throw new ArtifactTypeError('文件内容与扩展名不匹配', 'artifact_type_mismatch');
  return { ext, mime: EXT_MIME[ext] };
}

export { ArtifactPathError };
