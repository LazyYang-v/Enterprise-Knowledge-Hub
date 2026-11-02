import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeArtifactName, extensionOf, storageKeyForSha, assertSafeStorageKey,
  canonicalBlobPath, contentDisposition, artifactRoot, blobRoot,
} from '../../server/artifacts/paths.js';
import { writeBlob } from '../../server/artifacts/blob-store.js';

test('S-09/Q-05：artifact 名称只接受单段 basename', () => {
  assert.equal(normalizeArtifactName('调研报告 2026.docx'), '调研报告 2026.docx');
  assert.equal(normalizeArtifactName('a.b.c.md'), 'a.b.c.md');

  for (const bad of [
    '', '   ', '.', '..', '../evil.txt', 'a/b.txt', 'a\\b.txt', '/etc/passwd',
    'C:\\Windows\\evil.txt', 'C:evil.txt', 'CON', 'nul.txt', 'com1', '.env',
    'report.', 'a\u0000b', 'a\u202eb', 'x'.repeat(201),
  ]){
    assert.throws(() => normalizeArtifactName(bad), /文件名|路径|盘符|保留名/, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('扩展名解析只接受短字母数字后缀', () => {
  assert.equal(extensionOf('report.docx'), 'docx');
  assert.equal(extensionOf('REPORT.PDF'), 'pdf');
  assert.equal(extensionOf('README'), '');
  assert.equal(extensionOf('.env'), '');
  assert.equal(extensionOf('a.verylongextension'), '');
});

test('storage_key 必须是内容哈希相对路径', () => {
  const sha = 'a'.repeat(64);
  assert.equal(storageKeyForSha(sha), `blobs/aa/aa/${sha}`);
  assert.throws(() => storageKeyForSha('abc'));
  assert.throws(() => storageKeyForSha('../' + sha));
  assert.equal(assertSafeStorageKey(`blobs/aa/aa/${sha}`), `blobs/aa/aa/${sha}`);
  for (const bad of [
    `/etc/passwd`, `blobs/../${sha}`, `blobs/aa/aa/../../${sha}`, `blobs/aa/aa/${'A'.repeat(64)}`,
    `blobs/aa/aa/${sha}/x`, '', null,
  ]){
    assert.throws(() => assertSafeStorageKey(bad), /storage_key/, `应拒绝：${String(bad)}`);
  }
});

test('canonicalBlobPath 拒绝 symlink 与不存在的文件', () => {
  const { storageKey } = writeBlob(Buffer.from('hello artifact'));
  const resolved = canonicalBlobPath(storageKey);
  assert.equal(fs.readFileSync(resolved, 'utf8'), 'hello artifact');

  assert.throws(() => canonicalBlobPath(`blobs/00/00/${'0'.repeat(64)}`), /文件不存在/);

  const outside = path.join(artifactRoot(), 'outside.txt');
  fs.writeFileSync(outside, 'secret');
  fs.rmSync(resolved);
  fs.symlinkSync(outside, resolved);
  assert.throws(() => canonicalBlobPath(storageKey), /符号链接/);
  fs.rmSync(outside);
  assert.ok(fs.existsSync(blobRoot()));
});

test('Content-Disposition 提供 ASCII fallback 与 UTF-8 文件名', () => {
  const header = contentDisposition('调研报告.docx');
  assert.match(header, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
  assert.ok(header.includes(encodeURIComponent('调研报告.docx')));
  assert.throws(() => contentDisposition('../x'), /文件名/);
});
