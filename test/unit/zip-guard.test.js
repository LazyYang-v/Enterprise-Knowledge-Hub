import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import {
  normalizeZipEntryName, inspectZip, readZipEntry, buildZip, ZipGuardError,
} from '../../server/artifacts/zip-guard.js';

function rawZip(names){
  const zip = new AdmZip();
  for (const name of names) zip.addFile(name, Buffer.from(`data:${name}`));
  return zip.toBuffer();
}

test('Q-05：ZIP 条目名拒绝路径遍历、绝对路径与控制字符', () => {
  assert.equal(normalizeZipEntryName('docs/a.md'), 'docs/a.md');
  assert.equal(normalizeZipEntryName('报告/摘要.md'), '报告/摘要.md');
  assert.equal(normalizeZipEntryName('dir/'), 'dir/');
  for (const bad of ['../evil.txt', 'a/../../evil', '/etc/passwd', 'C:\\evil', 'a\u0000b', 'a//b', './a']){
    assert.throws(() => normalizeZipEntryName(bad), ZipGuardError, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('inspectZip 拒绝遍历条目（原始 ZIP 字节）', () => {
  const zip = new AdmZip();
  zip.addFile('aaaa/xx.txt', Buffer.from('evil'));
  const buf = zip.toBuffer();
  // adm-zip 在写入时会规范化 ../；这里直接替换等长字节，模拟恶意 ZIP。
  const patched = Buffer.from(buf);
  for (let i = 0; i <= patched.length - 11; i += 1){
    if (patched.toString('latin1', i, i + 11) === 'aaaa/xx.txt') patched.write('../evil.txt', i, 'latin1');
  }
  assert.throws(() => inspectZip(patched), e => e instanceof ZipGuardError && e.code === 'archive_unsafe_entry');
});

test('inspectZip 拒绝符号链接与加密条目', () => {
  const linkZip = new AdmZip();
  linkZip.addFile('link', Buffer.from('/etc/passwd'));
  linkZip.getEntry('link').header.attr = (0o120777 << 16) >>> 0;
  assert.throws(() => inspectZip(linkZip.toBuffer()), /符号链接/);

  const encZip = new AdmZip();
  encZip.addFile('secret.txt', Buffer.from('x'));
  encZip.getEntry('secret.txt').header.flags |= 1;
  assert.throws(() => inspectZip(encZip.toBuffer()), /加密/);
});

test('inspectZip 限额：条目数、单条、总量与压缩比', () => {
  const buf = rawZip(['a.txt', 'b.txt']);
  assert.throws(() => inspectZip(buf, { maxEntries: 1 }), /条目数/);
  assert.throws(() => inspectZip(buf, { maxEntryBytes: 2 }), /单条目/);
  assert.throws(() => inspectZip(buf, { maxTotalBytes: 5 }), /总解压/);

  const big = Buffer.alloc(2 * 1024 * 1024, 0x41);
  const bomb = new AdmZip();
  bomb.addFile('big.txt', big);
  assert.throws(() => inspectZip(bomb.toBuffer(), { maxRatio: 2 }), /压缩比/);
});

test('inspectZip/readZipEntry 正常读取条目', () => {
  const { zip, entries } = inspectZip(buildZip([
    { name: 'docs/a.md', data: 'hello' },
    { name: 'b.txt', data: Buffer.from('world') },
  ]));
  assert.deepEqual(entries.map(e => e.name).sort(), ['b.txt', 'docs/a.md']);
  assert.equal(readZipEntry(zip, 'docs/a.md').toString(), 'hello');
  assert.throws(() => readZipEntry(zip, 'missing.txt'), /不存在/);
});

test('buildZip 拒绝遍历、重复条目与总量超限', () => {
  assert.throws(() => buildZip([{ name: '../evil', data: 'x' }]), /遍历/);
  assert.throws(() => buildZip([{ name: 'a.txt', data: '1' }, { name: 'A.TXT', data: '2' }]), /重复/);
  assert.throws(() => buildZip([{ name: 'a', data: Buffer.alloc(100) }], { maxTotalBytes: 10 }), /总大小/);
  assert.throws(() => buildZip([]), /至少需要一个条目/);
});
