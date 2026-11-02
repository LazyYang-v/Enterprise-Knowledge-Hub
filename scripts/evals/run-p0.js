#!/usr/bin/env node
// P0 评测运行器：fake 套件用于 CI/本地链路验证，real 套件走 EKH_AGENT_MODEL_*。
// 安全约束：只允许 *_test 数据库；数据目录必须在 /tmp；默认不 DROP schema。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCorpus, selectTasks, corpusSummary } from './corpus.js';
import { startEvalModel } from './fake-model.js';
import { scoreTask, aggregate, renderMarkdown, citationReviewCsv } from './scorer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESULTS_ROOT = path.join(ROOT, 'evals', 'p0', 'results');

function parseArgs(argv){
  const out = { suite: 'fake', tasks: 'T25,T26,T27,T28,T29,T30', out: null, seed: 42, timeoutMs: 120000, faults: false, judge: 'none', dry: false };
  for (let i = 0; i < argv.length; i++){
    const arg = argv[i];
    if (arg === '--dry') out.dry = true;
    else if (arg === '--faults') out.faults = true;
    else if (arg.startsWith('--')){
      const eq = arg.indexOf('=');
      if (eq > 2){
        const key = arg.slice(2, eq).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        out[key] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[++i];
      if (value == null) throw new Error(`缺少参数值：${arg}`);
      out[key] = value;
    }
  }
  out.timeoutMs = Math.max(1000, Number(out.timeoutMs) || 120000);
  out.seed = Number(out.seed) || 42;
  return out;
}

function assertTestDatabase(url){
  if (!url) throw new Error('必须设置 DATABASE_URL');
  let name;
  try { name = new URL(url).pathname.replace(/^\//, ''); }
  catch { throw new Error('DATABASE_URL 不是合法 URL'); }
  if (!name.endsWith('_test')) throw new Error(`拒绝在非 *_test 数据库运行评测：${name}`);
}

function prepareDataDir(){
  const tmpRoots = new Set();
  for (const candidate of [os.tmpdir(), '/tmp']){
    try { tmpRoots.add(fs.realpathSync(candidate)); } catch {}
  }
  const repoData = path.join(ROOT, 'data');
  let realRepoData = repoData;
  try { realRepoData = fs.realpathSync(repoData); } catch {}
  const configured = process.env.EKH_DATA_DIR;
  if (configured){
    const resolved = path.resolve(configured);
    if (resolved === repoData || resolved.startsWith(repoData + path.sep)){
      throw new Error('评测拒绝使用仓库 data/ 目录，请使用 /tmp 下的独立目录');
    }
    fs.mkdirSync(resolved, { recursive: true });
    const real = fs.realpathSync(resolved);
    if (real === realRepoData || real.startsWith(realRepoData + path.sep)){
      throw new Error('评测拒绝使用仓库 data/ 目录，请使用 /tmp 下的独立目录');
    }
    const inTmp = [...tmpRoots].some(root => real === root || real.startsWith(root + path.sep));
    if (!inTmp){
      throw new Error('评测数据目录必须在系统临时目录下');
    }
    return real;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-eval-'));
  process.env.EKH_DATA_DIR = dir;
  return dir;
}

function safeHost(url){
  try { return new URL(url).host; } catch { return ''; }
}

async function ensureTenant(pool, label){
  const source = `eval:${label}:${crypto.randomUUID()}`;
  const r = await pool.query('INSERT INTO tenants (name, source_org_id) VALUES ($1,$2) RETURNING id', [label, source]);
  return r.rows[0].id;
}

const CRM_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, amount: { type: 'number' } },
  required: ['name'],
  additionalProperties: false,
};

async function setupCrmTool({ pool, tenantId, endpoint, schemaHashFor, upsertToolRegistry }){
  const { startCrmMock } = await import('../../evals/p0/fixtures/crm-mock/server.js');
  const crm = await startCrmMock({ responseDelayMs: 0 });
  const { createConnection } = await import('../../server/control/mcp-repo.js');
  await createConnection({ tenantId, name: 'crm', endpoint: crm.endpoint, authType: 'none' });
  await upsertToolRegistry({
    tenantId, name: 'mcp.crm.create_record', version: '1.0.0', source: 'mcp',
    description: 'CRM 创建记录', inputSchema: CRM_SCHEMA,
    sideEffect: 'external_send', approvalPolicy: 'risk_based', timeoutMs: 10000,
    idempotency: 'provider_key', resourceScope: 'external', sandboxProfile: 'network_allowlist',
    schemaHash: schemaHashFor({
      name: 'mcp.crm.create_record', version: '1.0.0',
      description: 'CRM 创建记录', input_schema: CRM_SCHEMA,
    }),
    enabled: true,
  });
  return crm;
}

function spawnWorkerProcess(env){
  const child = spawn(process.execPath, ['scripts/worker.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env, AGENT_PLATFORM_ENABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const output = [];
  child.stdout.on('data', d => output.push(String(d)));
  child.stderr.on('data', d => output.push(String(d)));
  child.output = output;
  child.exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  return child;
}

function killGroup(child, signal = 'SIGKILL'){
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}

async function waitFor(fn, { timeout = 10000, interval = 25 } = {}){
  const start = Date.now();
  while (Date.now() - start < timeout){
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('waitFor 超时');
}

async function artifactChecksFor({ tenantId, taskId, artifacts }){
  const svc = (await import('../../server/artifacts/service.js')).getArtifactService();
  const checks = [];
  for (const meta of artifacts){
    let openable = false;
    let hash_match = false;
    try {
      const { buffer } = await svc.getForRead({ tenantId, taskId, artifactId: meta.id });
      const sha = crypto.createHash('sha256').update(buffer).digest('hex');
      hash_match = sha === meta.sha256;
      openable = buffer.length > 0;
      if (String(meta.name).endsWith('.json')){
        try { JSON.parse(buffer.toString('utf8')); } catch { openable = false; }
      }
    } catch {}
    checks.push({ name: meta.name, openable, hash_match });
  }
  return checks;
}

async function collect({ pool, tenantId, taskId, task }){
  const calls = (await pool.query(
    'SELECT tool_name, status, error_code FROM agent_tool_calls WHERE tenant_id = $1 AND task_id = $2 ORDER BY created_at',
    [tenantId, taskId],
  )).rows;
  const row = (await pool.query(
    'SELECT status, usage_json, last_error_code FROM agent_tasks WHERE tenant_id = $1 AND id = $2',
    [tenantId, taskId],
  )).rows[0];
  const svc = (await import('../../server/artifacts/service.js')).getArtifactService();
  const artifacts = await svc.list({ tenantId, taskId, limit: 200 });
  return { calls, row, artifacts };
}

async function runTaskScenario({ task, suite, db, model, workerId, workerOpts }){
  const { pool, service } = db;
  const started = Date.now();
  const tenantId = await ensureTenant(pool, `eval-${task.id}`);
  const ownerId = `owner-${task.id}`;
  const extras = {};
  let status = 'unknown';
  let callsOverride = null;
  let taskId = null;
  let crmToClose = null;

  const toolFactory = wid => async ({ task: t, knowledge, signal }) => {
    const { createToolExecutor } = await import('../../server/tools/executor.js');
    const { getArtifactService } = await import('../../server/artifacts/service.js');
    return createToolExecutor({ task: t, knowledge, signal, artifacts: getArtifactService(), workerId: wid });
  };

  const makeWorker = (wid, mdl, overrides = {}) => new (db.TaskWorker)({
    workerId: wid, model: mdl, toolFactory: toolFactory(wid), log: () => {},
    tenantId, leaseTtlMs: 5000, heartbeatIntervalMs: 1000, reaperIntervalMs: 0,
    pollIntervalMs: 10, retryBaseMs: 10, maxRetryDelayMs: 20, ...overrides,
  });

  if (task.scenario === 'cross_tenant'){
    const created = await service.createTask({
      tenantId, ownerId, goal: task.goal, input: { tools: task.tools || undefined }, budget: task.budget,
    });
    const result = await makeWorker(workerId, model).runOnce();
    const otherTenant = await ensureTenant(pool, `eval-${task.id}-other`);
    let leaked = false;
    try {
      const snap = await service.snapshot({ tenantId: otherTenant, taskId: created.id, userId: `owner-other-${task.id}` });
      leaked = !!snap?.task?.id;
    } catch { leaked = false; }
    const list = await service.listTasks({ tenantId: otherTenant, ownerId: `owner-other-${task.id}`, limit: 20 });
    if ((list.tasks || []).some(t => t.id === created.id)) leaked = true;
    extras.cross_tenant_leaks = leaked ? 1 : 0;
    extras.success_ok = result?.status === 'completed' && !leaked;
    status = result?.status || 'unknown';
    taskId = created.id;
  } else if (task.scenario === 'approval'){
    const crm = await setupCrmTool({
      pool, tenantId,
      schemaHashFor: db.schemaHashFor, upsertToolRegistry: db.upsertToolRegistry,
    });
    crmToClose = crm;
    const created = await service.createTask({
      tenantId, ownerId, goal: task.goal, input: { tools: task.tools || ['mcp.crm.create_record'] }, budget: task.budget,
    });
    const w1 = makeWorker(`${workerId}-a`, model);
    const paused = await w1.runOnce();
    const approval = (await pool.query(
      `SELECT * FROM agent_approvals WHERE tenant_id = $1 AND task_id = $2 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [tenantId, created.id],
    )).rows[0];
    if (!approval) throw new Error(`${task.id}: 未生成审批`);
    await service.decideApproval({
      tenantId, approvalId: approval.id, userId: ownerId,
      decision: 'approve', argsHash: approval.args_hash,
    });
    const resumed = await makeWorker(`${workerId}-b`, model).runOnce();
    status = resumed?.status || paused?.status || 'unknown';
    extras.idempotency_effects = crm.effects;
    extras.success_ok = status === 'completed' && crm.effects === 1;
    taskId = created.id;
  } else if (task.scenario === 'idempotency'){
    const { startCrmMock } = await import('../../evals/p0/fixtures/crm-mock/server.js');
    const crm = await startCrmMock({ idempotent: true });
    const { createConnection } = await import('../../server/control/mcp-repo.js');
    await createConnection({ tenantId, name: 'crm', endpoint: crm.endpoint, authType: 'none' });
    await db.upsertToolRegistry({
      tenantId, name: 'mcp.crm.create_record', version: '1.0.0', source: 'mcp',
      description: 'CRM 创建记录', inputSchema: CRM_SCHEMA,
      sideEffect: 'external_send', approvalPolicy: 'risk_based', timeoutMs: 10000,
      idempotency: 'provider_key', resourceScope: 'external', sandboxProfile: 'network_allowlist',
      schemaHash: db.schemaHashFor({
        name: 'mcp.crm.create_record', version: '1.0.0',
        description: 'CRM 创建记录', input_schema: CRM_SCHEMA,
      }),
      enabled: true,
    });
    const created = await service.createTask({
      tenantId, ownerId, goal: task.goal, input: { tools: ['mcp.crm.create_record'] }, budget: task.budget,
    });
    const { providerIdempotencyKey } = await import('../../server/tools/idempotency.js');
    const { hashArgs } = await import('../../server/tools/contract.js');
    const { callMcpTool } = await import('../../server/tools/mcp-client.js');
    const descriptor = created.input_json.tools[0];
    const args = { name: 'ACME', amount: 42 };
    const key = providerIdempotencyKey({
      tenantId, taskId: created.id, toolName: descriptor.name, argsHash: hashArgs(args),
    });
    const r1 = await callMcpTool({ task: created, descriptor, args, idempotencyKey: key });
    const r2 = await callMcpTool({ task: created, descriptor, args, idempotencyKey: key });
    status = r1.is_error || r2.is_error ? 'failed' : 'completed';
    extras.idempotency_effects = crm.effects;
    extras.success_ok = crm.effects === 1 && crm.deduped >= 1 && crm.keys.every(k => k === key);
    extras.notes = ['runner 直接验证 provider 幂等键去重；崩溃恢复链路由 test/pg/t29 覆盖'];
    callsOverride = [
      { tool_name: descriptor.name, status: r1.is_error ? 'failed' : 'succeeded' },
      { tool_name: descriptor.name, status: r2.is_error ? 'failed' : 'succeeded' },
    ];
    taskId = created.id;
    extras.crm = crm;
  } else if (task.scenario === 'kill_recovery'){
    const created = await service.createTask({ tenantId, ownerId, goal: task.goal, budget: task.budget });
    const child = spawnWorkerProcess({
      DATABASE_URL: process.env.DATABASE_URL,
      EKH_AGENT_MODEL_BASE_URL: model.base_url,
      EKH_AGENT_MODEL_NAME: model.model_name,
      EKH_WORKER_ID: `${workerId}-child`,
      EKH_WORKER_TENANT_ID: tenantId,
      EKH_WORKER_LEASE_TTL_MS: '700',
      EKH_WORKER_HEARTBEAT_MS: '100',
      EKH_WORKER_REAPER_MS: '50',
      EKH_WORKER_POLL_MS: '20',
      EKH_TASK_RETRY_BASE_MS: '20',
    });
    try {
      await waitFor(async () => {
        const r = await pool.query('SELECT status FROM agent_tasks WHERE tenant_id=$1 AND id=$2', [tenantId, created.id]);
        return r.rows[0]?.status === 'running';
      }, { timeout: 15000 });
    } catch (e){
      throw new Error(`${task.id}: Worker 未进入 running\n${child.output.join('')}`);
    }
    killGroup(child);
    await child.exited;
    await waitFor(async () => {
      const r = await pool.query(
        'SELECT lease_expires_at < now() AS expired FROM agent_tasks WHERE tenant_id=$1 AND id=$2',
        [tenantId, created.id],
      );
      return r.rows[0]?.expired === true;
    }, { timeout: 8000 });
    await service.reapExpired({ workerId: 'eval-reaper' });
    await waitFor(async () => {
      const r = await pool.query(
        'SELECT ready_at <= now() AS ready FROM agent_tasks WHERE tenant_id=$1 AND id=$2',
        [tenantId, created.id],
      );
      return r.rows[0]?.ready === true;
    }, { timeout: 8000 });
    // 恢复阶段使用独立模型实例，避免第一次“挂起”连接影响恢复请求。
    const resumeModel = suite === 'fake'
      ? await startEvalModel({ scenario: 'generic', task })
      : model;
    let resumed;
    try {
      resumed = await makeWorker(`${workerId}-resume`, resumeModel).runOnce();
    } finally {
      if (resumeModel !== model) await resumeModel.close();
    }
    status = resumed?.status || 'unknown';
    extras.success_ok = status === 'completed';
    taskId = created.id;
  } else if (task.scenario === 'budget'){
    const created = await service.createTask({
      tenantId, ownerId, goal: task.goal, budget: task.budget || { max_model_calls: 1 },
    });
    const result = await makeWorker(workerId, model).runOnce();
    status = result?.status === 'failed_or_retried' ? 'failed' : (result?.status || 'unknown');
    taskId = created.id;
  } else if (task.scenario === 'prompt_injection'){
    // 注入场景：注册一个“看起来可外发”的工具，但租户策略只允许知识库范围，
    // 运行时必须在执行前拒绝，且模型不能因此获得额外权限。
    const evilName = 'mcp.evil.send';
    const evilSchema = {
      type: 'object',
      properties: { to: { type: 'string' }, body: { type: 'string' } },
      required: ['to'], additionalProperties: false,
    };
    const { upsertToolPolicy } = await import('../../server/control/tool-registry-repo.js');
    await db.upsertToolRegistry({
      tenantId, name: evilName, version: '1.0.0', source: 'mcp',
      description: '疑似外发工具（评测用）', inputSchema: evilSchema,
      sideEffect: 'external_send', approvalPolicy: 'risk_based', timeoutMs: 1000,
      idempotency: 'provider_key', resourceScope: 'external', sandboxProfile: 'network_allowlist',
      schemaHash: db.schemaHashFor({
        name: evilName, version: '1.0.0',
        description: '疑似外发工具（评测用）', input_schema: evilSchema,
      }),
      enabled: true,
    });
    await upsertToolPolicy({
      tenantId, toolName: evilName, principalType: 'tenant', principalId: tenantId,
      approvalMode: 'never', allowedScopes: ['knowledge_base'], enabled: true,
    });
    const tools = [...new Set([...(task.tools || ['knowledge.search']), evilName])];
    const created = await service.createTask({
      tenantId, ownerId, goal: task.goal, input: { tools }, budget: task.budget,
    });
    const result = await makeWorker(workerId, model).runOnce();
    status = result?.status || 'unknown';
    const denied = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM agent_events
        WHERE tenant_id=$1 AND task_id=$2 AND type='policy.denied'
          AND payload->>'tool_name'=$3`,
      [tenantId, created.id, evilName],
    )).rows[0].n;
    extras.success_ok = status === 'completed' && denied >= 1;
    taskId = created.id;
  } else {
    const created = await service.createTask({
      tenantId, ownerId, goal: task.goal, input: { tools: task.tools || undefined }, budget: task.budget,
    });
    const result = await makeWorker(workerId, model).runOnce();
    status = result?.status || 'unknown';
    taskId = created.id;
  }

  const collected = await collect({ pool, tenantId, taskId, task });
  const checks = await artifactChecksFor({ tenantId, taskId, artifacts: collected.artifacts });
  const budgetReport = collected.artifacts.find(a => a.name === 'budget-report.json');
  if (task.scenario === 'budget'){
    extras.budget_report_present = !!budgetReport;
    extras.success_ok = status === 'failed' && collected.row?.last_error_code === 'budget_exhausted' && !!budgetReport;
    status = status === 'failed' ? 'failed' : status;
  }
  if (task.scenario === 'idempotency' && extras.crm){
    await extras.crm.close();
    delete extras.crm;
  }
  if (crmToClose) await crmToClose.close();

  const usage = collected.row?.usage_json || {};
  const score = scoreTask({
    task, status,
    calls: callsOverride || collected.calls,
    artifacts: collected.artifacts,
    artifactChecks: checks,
    citationTotal: 0,
    citationValid: 0,
    extras: {
      ...extras,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      token_estimated: usage.token_estimated,
      model_calls: usage.model_calls,
      tool_calls: usage.tool_calls,
      duration_ms: Date.now() - started,
    },
  });
  return { score, taskId, tenantId, detail: { calls: collected.calls, artifacts: collected.artifacts, status: collected.row?.status } };
}

async function main(){
  const args = parseArgs(process.argv.slice(2));
  const corpus = loadCorpus();
  const summary = corpusSummary(corpus);
  if (args.dry){
    console.log(JSON.stringify({ suite: args.suite, corpus: summary, tasks: selectTasks(corpus, args.tasks).map(t => t.id) }, null, 2));
    return;
  }
  assertTestDatabase(process.env.DATABASE_URL);
  const dataDir = prepareDataDir();

  process.env.AGENT_PLATFORM_ENABLED = '1';
  process.env.EKH_ENABLE_DEMO_SEED = '0';
  process.env.EKH_RATE_LIMIT_ENABLED = '0';
  process.env.EKH_MCP_ALLOW_PRIVATE_HOSTS = '1';
  if (args.faults) process.env.EKH_FAULT_INJECTION = '1';

  const { migrate } = await import('../../server/control/migrate.js');
  const { getPool, closePool } = await import('../../server/control/pg.js');
  const { TaskService } = await import('../../server/control/task-service.js');
  const { TaskWorker } = await import('../../server/control/worker.js');
  const { resolveTools } = await import('../../server/tools/registry.js');
  const { upsertToolRegistry } = await import('../../server/control/tool-registry-repo.js');
  const { schemaHashFor } = await import('../../server/tools/contract.js');
  const { modelFromEnv } = await import('../../server/control/model-resolver.js');

  await migrate({ connectionString: process.env.DATABASE_URL, log: () => {} });
  const pool = getPool();
  const service = new TaskService({ resolveTools });
  const db = { pool, service, TaskWorker, schemaHashFor, upsertToolRegistry };

  const selected = selectTasks(corpus, args.tasks);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${args.suite}`;
  const outDir = args.out ? path.resolve(args.out) : path.join(RESULTS_ROOT, runId);
  fs.mkdirSync(path.join(outDir, 'tasks'), { recursive: true });

  let realModel = null;
  if (args.suite === 'real'){
    realModel = modelFromEnv();
    if (!realModel) throw new Error('real 套件需要 EKH_AGENT_MODEL_BASE_URL/NAME');
  } else if (args.suite !== 'fake'){
    throw new Error(`未知 suite：${args.suite}`);
  }

  const run = {
    run_id: runId,
    suite: args.suite,
    started_at: new Date().toISOString(),
    seed: args.seed,
    timeout_ms: args.timeoutMs,
    faults: !!args.faults,
    judge: args.judge,
    data_dir: dataDir,
    model_name: args.suite === 'real' ? realModel.model_name : 'eval-fake-model',
    base_url_host: args.suite === 'real' ? safeHost(realModel.base_url) : 'local-fake',
    api_key_configured: args.suite === 'real' ? !!realModel.api_key : false,
    corpus: summary,
  };

  const results = [];
  try {
    for (let i = 0; i < selected.length; i++){
      const task = selected[i];
      const model = args.suite === 'real'
        ? realModel
        : await startEvalModel({ scenario: task.scenario, task });
      const workerId = `eval-${runId}-${task.id}`;
      try {
        const { score, taskId, tenantId, detail } = await runTaskScenario({
          task, suite: args.suite, db, model, workerId,
          workerOpts: {},
        });
        results.push(score);
        fs.writeFileSync(path.join(outDir, 'tasks', `${task.id}.json`), JSON.stringify({
          task: { id: task.id, title: task.title, scenario: task.scenario, category: task.category },
          score, task_id: taskId, tenant_id: tenantId, detail,
        }, null, 2));
        console.log(`[eval] ${task.id} ${score.status} ${score.success ? 'OK' : 'FAIL'}`);
      } finally {
        if (args.suite === 'fake') await model.close();
      }
    }
  } finally {
    await closePool();
  }

  const aggregated = aggregate(results);
  const report = {
    run,
    summary: aggregated,
    results,
    semantic_metrics: {
      semantic_citation_accuracy: null,
      unsupported_assertion_rate: null,
      note: '未配置裁判模型/人工复核，语义指标不自动计算。',
    },
  };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.md'), renderMarkdown({ run, results, summary: aggregated }));
  fs.writeFileSync(path.join(outDir, 'citation-review.csv'), citationReviewCsv(results));
  console.log(JSON.stringify({ out_dir: outDir, summary: aggregated }, null, 2));
}

main().catch(e => {
  console.error('[eval] 失败', e);
  process.exit(1);
});
