import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('评测运行器 --dry 不需要数据库即可输出语料计划', () => {
  const out = spawnSync(process.execPath, ['scripts/evals/run-p0.js', '--dry', '--tasks=T25-T30'], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DATABASE_URL: '', EKH_DATA_DIR: '' },
  });
  assert.equal(out.status, 0, out.stderr);
  const plan = JSON.parse(out.stdout);
  assert.deepEqual(plan.tasks, ['T25', 'T26', 'T27', 'T28', 'T29', 'T30']);
  assert.equal(plan.corpus.total, 30);
});
