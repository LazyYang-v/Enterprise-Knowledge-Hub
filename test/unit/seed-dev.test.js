// 开发模式仍可初始化演示数据（与生产门禁相对照）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-dev-seed-'));
process.env.NODE_ENV = 'development';
process.env.EKH_DATA_DIR = dir;
process.env.EKH_ENABLE_DEMO_SEED = '1';

const { seedIfEnabled } = await import('../../server/bootstrap.js');
const { db } = await import('../../server/db.js');

test('开发模式初始化演示账号', () => {
  assert.equal(seedIfEnabled(), true);
  const demo = db.prepare("SELECT id FROM users WHERE email = 'lzy@example.com'").get();
  assert.ok(demo, '应创建演示账号 lzy@example.com');
});

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
