// G7：生产模式不得创建演示账号。测试文件独立进程，先设置 env 再动态导入。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-prod-seed-'));
process.env.NODE_ENV = 'production';
process.env.EKH_DATA_DIR = dir;
process.env.EKH_ENABLE_DEMO_SEED = '1';

const { seedIfEnabled } = await import('../../server/bootstrap.js');
const { db } = await import('../../server/db.js');

test('生产模式跳过 seed()/seedDemo()，不产生演示账号', () => {
  assert.equal(seedIfEnabled(), false);
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const kbs = db.prepare('SELECT COUNT(*) AS c FROM knowledge_bases').get().c;
  assert.equal(users, 0);
  assert.equal(kbs, 0);
});

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
