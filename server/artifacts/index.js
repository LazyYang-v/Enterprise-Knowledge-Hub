// 成果文件模块统一导出。
export {
  ArtifactPathError, normalizeArtifactName, extensionOf, artifactRoot, blobRoot, tmpRoot,
  quarantineRoot, ensureArtifactDirs, storageKeyForSha, assertSafeStorageKey,
  canonicalBlobPath, blobPathForStorageKey, contentDisposition,
} from './paths.js';
export {
  ArtifactTypeError, UPLOAD_EXTENSIONS, mimeForName, isTextMime, isTextExtension,
  safeDownloadMime, assertUploadAllowed,
} from './mime.js';
export {
  hashBytes, writeBlob, readBlob, statBlob, openBlobStream, deleteBlobFile, listBlobFiles,
} from './blob-store.js';
export {
  ZipGuardError, DEFAULT_ZIP_LIMITS, normalizeZipEntryName, inspectZip, readZipEntry, buildZip,
} from './zip-guard.js';
export { createDocx } from './docx.js';
