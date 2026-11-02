import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  writeBlob, readBlob, statBlob, deleteBlobFile, listBlobFiles, hashBytes,
} from '../../server/artifacts/blob-store.js';
import { canonicalBlobPath } from '../../server/artifacts/paths.js';

test('内容寻址写入：同内容去重、大小校验与读取', () => {
  const data = Buffer.from('content-addressed artifact');
  const first = writeBlob(data);
  assert.equal(first.created, true);
  assert.equal(first.size, data.length);
  assert.equal(first.sha256, hashBytes(data));
  assert.ok(fs.existsSync(canonicalBlobPath(first.storageKey)));
  assert.equal(fs.statSync(canonicalBlobPath(first.storageKey)).mode & 0o777, 0o600);

  const second = writeBlob(Buffer.from(data));
  assert.equal(second.created, false);
  assert.equal(second.storageKey, first.storageKey);

  assert.deepEqual(readBlob(first.storageKey), data);
  assert.equal(statBlob(first.storageKey).size, data.length);
});

test('空内容、超限与非法内容被拒绝', () => {
  assert.throws(() => writeBlob(Buffer.alloc(0)), /内容为空/);
  assert.throws(() => writeBlob(Buffer.from('12345'), { maxBytes: 4 }), /大小上限/);
  assert.throws(() => writeBlob('string'), /Buffer/);
  const { storageKey } = writeBlob(Buffer.from('abc'));
  assert.throws(() => readBlob(storageKey, { maxBytes: 1 }), /读取上限/);
});

test('删除 blob 与孤儿文件列表', () => {
  const { storageKey } = writeBlob(Buffer.from('to be deleted'));
  assert.ok(listBlobFiles().some(f => f.storageKey === storageKey));
  assert.equal(deleteBlobFile(storageKey), true);
  assert.equal(deleteBlobFile(storageKey), false);
  assert.ok(!listBlobFiles().some(f => f.storageKey === storageKey));
});
