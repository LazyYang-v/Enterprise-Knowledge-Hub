import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tasks = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/p0/tasks.json'), 'utf8')).tasks;
const e2eDir = path.join(ROOT, 'evals/p0/e2e');
const e2eFiles = fs.readdirSync(e2eDir).filter(f => f.endsWith('.json')).sort();

const validIds = new Set([
  ...Array.from({ length: 8 }, (_, i) => `F-0${i + 1}`),
  ...Array.from({ length: 7 }, (_, i) => `R-0${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `S-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 5 }, (_, i) => `Q-0${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `P-0${i + 1}`),
]);

test('评测集包含 30 条唯一任务且字段完整', () => {
  assert.equal(tasks.length, 30);
  assert.equal(new Set(tasks.map(t => t.id)).size, 30);
  for (const t of tasks){
    assert.match(t.id, /^T\d{2}$/);
    for (const field of ['title', 'category', 'goal', 'inputs', 'expected_artifacts', 'expected_tools', 'acceptance_ids', 'risk_level', 'phase']){
      assert.ok(field in t, `${t.id} 缺少字段 ${field}`);
    }
    assert.ok(Array.isArray(t.acceptance_ids) && t.acceptance_ids.length > 0);
    for (const id of t.acceptance_ids) assert.ok(validIds.has(id), `${t.id} 引用了未知验收 ID ${id}`);
    assert.ok(['low', 'medium', 'high'].includes(t.risk_level));
  }
});

test('3 个端到端场景结构完整且引用存在的任务', () => {
  assert.equal(e2eFiles.length, 3);
  const taskIds = new Set(tasks.map(t => t.id));
  for (const file of e2eFiles){
    const e2e = JSON.parse(fs.readFileSync(path.join(e2eDir, file), 'utf8'));
    assert.ok(e2e.id && e2e.name && e2e.goal);
    assert.ok(taskIds.has(e2e.task_id), `${file} 引用了不存在的任务 ${e2e.task_id}`);
    assert.ok(Array.isArray(e2e.steps) && e2e.steps.length > 0);
    assert.ok(Array.isArray(e2e.pass_criteria) && e2e.pass_criteria.length > 0);
    for (const id of e2e.acceptance_ids || []) assert.ok(validIds.has(id), `${file} 未知验收 ID ${id}`);
  }
});
