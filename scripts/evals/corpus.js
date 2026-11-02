// 评测语料装载：tasks.json 提供业务元数据，corpus.json 提供可执行场景。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EVAL_ROOT = path.join(ROOT, 'evals', 'p0');
export const SCENARIOS = Object.freeze([
  'generic', 'cross_tenant', 'prompt_injection', 'approval', 'kill_recovery', 'idempotency', 'budget',
]);

function readJson(file){
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadCorpus({ root = EVAL_ROOT } = {}){
  const tasksRaw = readJson(path.join(root, 'tasks.json'));
  const corpusRaw = readJson(path.join(root, 'corpus.json'));
  const base = Array.isArray(tasksRaw) ? tasksRaw : tasksRaw.tasks;
  if (!Array.isArray(base)) throw new Error('tasks.json 缺少 tasks 数组');
  const entries = Array.isArray(corpusRaw.tasks) ? corpusRaw.tasks : [];
  if (!entries.length) throw new Error('corpus.json 缺少 tasks 数组');

  const byId = new Map(base.map(t => [t.id, t]));
  const seen = new Set();
  const tasks = entries.map(entry => {
    if (!entry || typeof entry.id !== 'string') throw new Error('corpus 条目缺少 id');
    if (seen.has(entry.id)) throw new Error(`corpus 存在重复 id：${entry.id}`);
    seen.add(entry.id);
    const meta = byId.get(entry.id);
    if (!meta) throw new Error(`tasks.json 中不存在 ${entry.id}`);
    if (!SCENARIOS.includes(entry.scenario)) throw new Error(`${entry.id} 场景不合法：${entry.scenario}`);
    return {
      ...meta,
      scenario: entry.scenario,
      tools: Array.isArray(entry.tools) ? entry.tools : null,
      budget: entry.budget && typeof entry.budget === 'object' ? entry.budget : {},
    };
  });
  return { version: 1, tasks, baseCount: base.length, corpusCount: tasks.length };
}

export function selectTasks(corpus, spec = 'all'){
  const tasks = corpus?.tasks || [];
  if (!spec || spec === 'all') return tasks;
  const ids = String(spec).split(',').map(s => s.trim()).filter(Boolean);
  const byId = new Map(tasks.map(t => [t.id, t]));
  const out = [];
  for (const id of ids){
    const task = byId.get(id);
    if (!task){
      // 允许 T25-T30 这样的范围写法。
      const range = /^T(\d+)-T(\d+)$/i.exec(id);
      if (range){
        const from = Number(range[1]);
        const to = Number(range[2]);
        for (const t of tasks){
          const n = Number(String(t.id).replace(/^T/i, ''));
          if (n >= from && n <= to) out.push(t);
        }
        continue;
      }
      throw new Error(`未知评测任务：${id}`);
    }
    out.push(task);
  }
  return out;
}

export function corpusSummary(corpus){
  const byScenario = {};
  for (const t of corpus.tasks) byScenario[t.scenario] = (byScenario[t.scenario] || 0) + 1;
  return { total: corpus.tasks.length, by_scenario: byScenario };
}
