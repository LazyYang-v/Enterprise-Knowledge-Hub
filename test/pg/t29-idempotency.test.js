// T29：MCP 外部写跨 Worker 崩溃的 provider 幂等。
// 期望：效果只发生一次、同一 tool_call_id/幂等键、attempt_no 递增、任务完成。
process.env.AGENT_PLATFORM_ENABLED = '1';
process.env.EKH_MCP_ALLOW_PRIVATE_HOSTS = '1';

import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { ensureSchema, canUseTestDatabase, createTenant, getPool, closeTestDb, waitFor } = await import('../helpers/pg.js');
const { startFakeModel } = await import('../helpers/fake-model.js');
const { startCrmMock } = await import('../../evals/p0/fixtures/crm-mock/server.js');
const { TaskService } = await import('../../server/control/task-service.js');
const { resolveTools } = await import('../../server/tools/registry.js');
const { schemaHashFor } = await import('../../server/tools/contract.js');
const { createConnection } = await import('../../server/control/mcp-repo.js');
const { upsertToolRegistry } = await import('../../server/control/tool-registry-repo.js');
const { finishToolCall, LeaseLostError } = await import('../../server/control/task-repo.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skip = !canUseTestDatabase();

const TOOL_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, amount: { type: 'number' } },
  required: ['name'],
  additionalProperties: false,
};
const TOOL_NAME = 'mcp.crm.create_record';

function spawnWorker(env, args = []){
  const child = spawn(process.execPath, ['scripts/worker.js', ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env, AGENT_PLATFORM_ENABLED: '1', EKH_MCP_ALLOW_PRIVATE_HOSTS: '1' },
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
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}

async function taskRow(tenantId, taskId){
  const r = await getPool().query(
    `SELECT status, lease_owner, lease_epoch, lease_expires_at < now() AS lease_expired
       FROM agent_tasks WHERE tenant_id = $1 AND id = $2`,
    [tenantId, taskId],
  );
  return r.rows[0] || null;
}

async function callRows(tenantId, taskId){
  const r = await getPool().query(
    `SELECT c.*, (SELECT COUNT(*)::int FROM agent_tool_attempts a WHERE a.tool_call_id = c.id) AS attempts
       FROM agent_tool_calls c WHERE c.tenant_id = $1 AND c.task_id = $2 ORDER BY c.created_at`,
    [tenantId, taskId],
  );
  return r.rows;
}

async function approvalRows(tenantId, taskId){
  const r = await getPool().query(
    'SELECT * FROM agent_approvals WHERE tenant_id = $1 AND task_id = $2 ORDER BY created_at',
    [tenantId, taskId],
  );
  return r.rows;
}

test('T29：外部写崩溃恢复只产生一次外部效果', { skip, timeout: 120000 }, async t => {
  await ensureSchema();
  const tenantId = await createTenant('t29-idempotency');
  const ownerId = 'owner-crm';
  const children = new Set();
  t.after(async () => {
    for (const child of children){
      if (child.exitCode == null && child.signalCode == null) killGroup(child);
    }
    await closeTestDb();
  });

  // 响应延迟给测试足够时间在“效果已发生、响应未返回”时杀掉 Worker。
  const crm = await startCrmMock({ responseDelayMs: 4000 });
  t.after(() => crm.close());

  const model = await startFakeModel(({ body }) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    // 执行器把工具结果作为 user 消息注入（兼容旧聊天协议），因此按内容识别。
    const hasToolResult = messages.some(m => m.role === 'tool' || m.role === 'function'
      || String(m.content || '').includes(`工具 ${TOOL_NAME} `));
    if (hasToolResult){
      return JSON.stringify({ type: 'finish', summary: 'CRM 记录已创建', artifact_refs: [], citations: [] });
    }
    return JSON.stringify({
      type: 'call_tool', tool_name: TOOL_NAME, arguments: { name: 'ACME', amount: 42 },
    });
  });
  t.after(() => model.close());

  const connection = await createConnection({
    tenantId, name: 'crm', endpoint: crm.endpoint, authType: 'none',
  });
  assert.equal(connection.name, 'crm');
  await upsertToolRegistry({
    tenantId, name: TOOL_NAME, version: '1.0.0', source: 'mcp',
    description: 'CRM 创建记录', inputSchema: TOOL_SCHEMA,
    sideEffect: 'external_send', approvalPolicy: 'risk_based', timeoutMs: 10000,
    idempotency: 'provider_key', resourceScope: 'external', sandboxProfile: 'network_allowlist',
    schemaHash: schemaHashFor({ name: TOOL_NAME, version: '1.0.0', description: 'CRM 创建记录', input_schema: TOOL_SCHEMA }),
    enabled: true,
  });

  const service = new TaskService({ resolveTools });
  const task = await service.createTask({
    tenantId, ownerId, goal: '创建 CRM 记录',
    input: { tools: [TOOL_NAME], approval_mode: 'risk_based' },
  });
  assert.deepEqual(task.input_json.tools.map(x => x.name), [TOOL_NAME]);
  assert.equal(task.input_json.tools[0].idempotency, 'provider_key');

  const baseEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    EKH_AGENT_MODEL_BASE_URL: model.base_url,
    EKH_AGENT_MODEL_NAME: model.model_name,
    EKH_WORKER_LEASE_TTL_MS: '700',
    EKH_WORKER_HEARTBEAT_MS: '100',
    EKH_WORKER_REAPER_MS: '60',
    EKH_WORKER_POLL_MS: '20',
    EKH_TASK_RETRY_BASE_MS: '20',
  };

  // 第一次执行：生成审批并暂停，不触达外部系统。
  const w1 = spawnWorker({ ...baseEnv, EKH_WORKER_ID: 't29-w1' });
  children.add(w1);
  await waitFor(async () => (await taskRow(tenantId, task.id))?.status === 'waiting_approval', { timeout: 15000 });
  children.delete(w1);
  killGroup(w1, 'SIGKILL');
  await w1.exited;

  let calls = await callRows(tenantId, task.id);
  assert.equal(calls.length, 1, '审批前应只有一个逻辑调用');
  const callId = calls[0].id;
  const idemKey = calls[0].idempotency_key;
  assert.match(idemKey, /^[0-9a-f]{64}$/);
  assert.equal(calls[0].status, 'awaiting_approval');
  assert.equal(crm.effects, 0, '审批前不得产生外部效果');

  let approvals = await approvalRows(tenantId, task.id);
  assert.equal(approvals.length, 1);
  await service.decideApproval({
    tenantId, approvalId: approvals[0].id, userId: ownerId,
    decision: 'approve', argsHash: calls[0].args_hash,
  });

  // 第二次执行：外部效果已发生但响应被延迟；此时 SIGKILL。
  const w2 = spawnWorker({ ...baseEnv, EKH_WORKER_ID: 't29-w2' });
  children.add(w2);
  await waitFor(async () => crm.effects === 1, { timeout: 20000 });
  const w2Task = await taskRow(tenantId, task.id);
  const staleEpoch = Number(w2Task.lease_epoch);
  killGroup(w2, 'SIGKILL');
  await w2.exited;
  children.delete(w2);

  await waitFor(async () => (await taskRow(tenantId, task.id))?.lease_expired === true, { timeout: 8000 });
  const stats = await service.reapExpired({ workerId: 't29-reaper' });
  assert.ok(stats.recovered >= 1);
  assert.equal((await taskRow(tenantId, task.id)).status, 'queued');
  calls = await callRows(tenantId, task.id);
  assert.equal(calls.length, 1, '恢复不得创建第二个逻辑调用');
  assert.equal(calls[0].id, callId);
  assert.equal(calls[0].status, 'failed');
  assert.equal(calls[0].error_code, 'worker_lost');

  // 恢复后的写仍按高风险策略重新审批（幂等键保证安全）。
  const w3 = spawnWorker({ ...baseEnv, EKH_WORKER_ID: 't29-w3' });
  children.add(w3);
  await waitFor(async () => (await taskRow(tenantId, task.id))?.status === 'waiting_approval', { timeout: 15000 });
  children.delete(w3);
  killGroup(w3, 'SIGKILL');
  await w3.exited;

  approvals = await approvalRows(tenantId, task.id);
  assert.equal(approvals.length, 2, '恢复后应重新请求审批');
  calls = await callRows(tenantId, task.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, callId, '重开必须复用同一 tool_call_id');
  assert.equal(calls[0].idempotency_key, idemKey);
  await service.decideApproval({
    tenantId, approvalId: approvals[1].id, userId: ownerId,
    decision: 'approve', argsHash: calls[0].args_hash,
  });

  const w4 = spawnWorker({ ...baseEnv, EKH_WORKER_ID: 't29-w4' }, ['--once']);
  children.add(w4);
  const exit = await Promise.race([
    w4.exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`恢复 Worker 超时\n${w4.output.join('')}`)), 30000)),
  ]);
  children.delete(w4);
  assert.equal(exit.code, 0, `恢复 Worker 退出码非 0\n${w4.output.join('')}`);

  const done = await taskRow(tenantId, task.id);
  assert.equal(done.status, 'completed', `任务应完成：${JSON.stringify(done)}\n${w4.output.join('')}`);
  assert.equal(crm.effects, 1, '外部效果必须恰好一次');
  assert.ok(crm.deduped >= 1, 'CRM 应命中去重');
  assert.ok(crm.keys.every(k => k === idemKey), '所有外部调用必须携带同一幂等键');

  calls = await callRows(tenantId, task.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, callId);
  assert.equal(calls[0].idempotency_key, idemKey);
  assert.equal(calls[0].status, 'succeeded');
  assert.equal(calls[0].attempts, 2, 'try 1 崩溃、try 2 成功');

  const attempts = await getPool().query(
    'SELECT attempt_no, status, worker_id FROM agent_tool_attempts WHERE tenant_id = $1 AND tool_call_id = $2 ORDER BY attempt_no',
    [tenantId, callId],
  );
  assert.deepEqual(attempts.rows.map(r => Number(r.attempt_no)), [1, 2]);
  assert.deepEqual(attempts.rows.map(r => r.status), ['failed', 'succeeded']);

  // 旧租约的迟到写入必须被 fence。
  await assert.rejects(
    () => finishToolCall({
      tenantId, toolCallId: callId, status: 'succeeded',
      workerId: 't29-w2', leaseEpoch: staleEpoch,
    }),
    e => e instanceof LeaseLostError,
  );

  const events = await getPool().query(
    'SELECT seq, type FROM agent_events WHERE tenant_id = $1 AND task_id = $2 ORDER BY seq',
    [tenantId, task.id],
  );
  const seqs = events.rows.map(r => Number(r.seq));
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), '事件序号必须连续');
  assert.ok(events.rows.some(r => r.type === 'tool.retry_reopened'));
});
