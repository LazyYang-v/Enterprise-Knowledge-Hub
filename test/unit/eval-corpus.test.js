import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus, selectTasks, corpusSummary, EVAL_ROOT } from '../../scripts/evals/corpus.js';

test('P0 语料完整：30 条任务、场景合法、T25–T30 覆盖', () => {
  const corpus = loadCorpus();
  assert.equal(corpus.tasks.length, 30);
  assert.equal(corpus.baseCount, 30);
  const ids = corpus.tasks.map(t => t.id);
  assert.equal(new Set(ids).size, 30);
  for (const id of ['T25', 'T26', 'T27', 'T28', 'T29', 'T30']) assert.ok(ids.includes(id));
  const scenarios = new Set(corpus.tasks.map(t => t.scenario));
  for (const s of ['generic', 'cross_tenant', 'prompt_injection', 'approval', 'kill_recovery', 'idempotency', 'budget']){
    assert.ok(scenarios.has(s), `缺少场景 ${s}`);
  }
  const summary = corpusSummary(corpus);
  assert.equal(summary.total, 30);
});

test('任务选择支持 all、逗号列表与范围', () => {
  const corpus = loadCorpus();
  assert.equal(selectTasks(corpus, 'all').length, 30);
  assert.deepEqual(selectTasks(corpus, 'T25,T29').map(t => t.id), ['T25', 'T29']);
  assert.deepEqual(selectTasks(corpus, 'T28-T30').map(t => t.id), ['T28', 'T29', 'T30']);
  assert.throws(() => selectTasks(corpus, 'T99'), /未知评测任务/);
});

test('语料 JSON 不包含二进制/密钥字段', () => {
  for (const file of ['tasks.json', 'corpus.json']){
    const text = fs.readFileSync(path.join(EVAL_ROOT, file), 'utf8');
    assert.ok(text.length < 200 * 1024);
    assert.ok(!/BEGIN (RSA |EC )?PRIVATE KEY/.test(text));
    assert.ok(!/api[_-]?key\s*[:=]\s*["'][^"']+["']/i.test(text));
  }
});
