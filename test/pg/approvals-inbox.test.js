// 审批收件箱 API：富字段、状态/任务过滤与 can_decide 判定。
process.env.AGENT_PLATFORM_ENABLED = '1';

import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { ensureSchema, canUseTestDatabase, closeTestDb } = await import('../helpers/pg.js');
const { startApp } = await import('../helpers/app.js');
const { getPool } = await import('../../server/control/pg.js');

const skip = !canUseTestDatabase();

test('审批列表返回任务/工具/参数并支持过滤', { skip }, async t => {
  await ensureSchema();
  const app = await startApp({ AGENT_PLATFORM_ENABLED: '1' });
  t.after(async () => { await app.close(); await closeTestDb(); });

  const user = await app.register('approval-inbox@example.com', '审批用户');
  const stranger = await app.register('approval-stranger@example.com', '陌生人');
  const created = await app.request('POST', '/api/tasks', {
    token: user.token, body: { goal: '需要审批的任务', title: '审批任务' },
  });
  assert.equal(created.status, 201);
  const taskId = created.data.task.id;
  const tenantId = (await getPool().query(
    'SELECT tenant_id FROM agent_tasks WHERE id = $1', [taskId],
  )).rows[0].tenant_id;
  await getPool().query(
    `UPDATE agent_tasks SET status = 'waiting_approval' WHERE tenant_id = $1 AND id = $2`,
    [tenantId, taskId],
  );

  const toolCall = (await getPool().query(
    `INSERT INTO agent_tool_calls
       (tenant_id, task_id, tool_name, tool_version, args_json, args_hash, side_effect, status)
     VALUES ($1, $2, 'mcp.crm.update', '1.0.0', '{"id":1}'::jsonb, $3, 'external_send', 'awaiting_approval')
     RETURNING id`,
    [tenantId, taskId, 'a'.repeat(64)],
  )).rows[0];

  const pending = (await getPool().query(
    `INSERT INTO agent_approvals
       (tenant_id, task_id, tool_call_id, kind, risk_level, request_payload_json, args_hash,
        requested_by, expires_at)
     VALUES ($1, $2, $3, 'tool_call', 'high', '{"tool":"mcp.crm.update"}'::jsonb, $4,
             'agent:worker-1', now() + interval '1 hour')
     RETURNING id`,
    [tenantId, taskId, toolCall.id, 'a'.repeat(64)],
  )).rows[0];
  const approved = (await getPool().query(
    `INSERT INTO agent_approvals
       (tenant_id, task_id, tool_call_id, kind, risk_level, request_payload_json, args_hash,
        requested_by, expires_at, status, decided_by, decided_at)
     VALUES ($1, $2, $3, 'tool_call', 'low', '{}'::jsonb, $4, 'agent:worker-1',
             now() + interval '1 hour', 'approved', 'someone', now())
     RETURNING id`,
    [tenantId, taskId, toolCall.id, 'a'.repeat(64)],
  )).rows[0];

  const list = await app.request('GET', '/api/approvals', { token: user.token });
  assert.equal(list.status, 200);
  assert.equal(list.data.count, 1);
  const item = list.data.approvals[0];
  assert.equal(item.id, pending.id);
  assert.equal(item.task_title, '审批任务');
  assert.equal(item.task_status, 'waiting_approval');
  assert.equal(item.task_owner_id, user.user.id);
  assert.equal(item.tool_name, 'mcp.crm.update');
  assert.equal(item.tool_version, '1.0.0');
  assert.equal(item.side_effect, 'external_send');
  assert.deepEqual(item.arguments, { id: 1 });
  assert.deepEqual(item.request, { tool: 'mcp.crm.update' });
  assert.equal(item.can_decide, true);

  const filtered = await app.request('GET', `/api/approvals?task_id=${taskId}&limit=10`, { token: user.token });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.data.approvals.length, 1);
  assert.equal(filtered.data.approvals[0].id, pending.id);

  const approvedList = await app.request('GET', `/api/approvals?status=approved&task_id=${taskId}`, { token: user.token });
  assert.equal(approvedList.status, 200);
  assert.deepEqual(approvedList.data.approvals.map(x => x.id), [approved.id]);

  const badStatus = await app.request('GET', '/api/approvals?status=nope', { token: user.token });
  assert.equal(badStatus.status, 400);

  const foreign = await app.request('GET', '/api/approvals', { token: stranger.token });
  assert.equal(foreign.status, 200);
  assert.equal(foreign.data.count, 0);

  // 自己发起的审批不可自批。
  await getPool().query(
    'UPDATE agent_approvals SET requested_by = $3 WHERE tenant_id = $1 AND id = $2',
    [tenantId, pending.id, user.user.id],
  );
  const self = await app.request('GET', '/api/approvals', { token: user.token });
  assert.equal(self.data.approvals[0].can_decide, false);
});
