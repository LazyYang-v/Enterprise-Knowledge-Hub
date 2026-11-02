// 预算耗尽时的部分成果报告：在租约仍有效时写入 budget-report.json，
// 记录预算、用量、计划完成度与已提交成果。任务本身仍以 failed/budget_exhausted 结束。
import { withTransaction } from './pg.js';
import { appendEvent, listPlanItems } from './task-repo.js';
import { getArtifactService } from '../artifacts/service.js';

function usageSummary(usage){
  return {
    steps: Number(usage?.steps || 0),
    model_calls: Number(usage?.model_calls || 0),
    tool_calls: Number(usage?.tool_calls || 0),
    input_tokens: Number(usage?.input_tokens || 0),
    output_tokens: Number(usage?.output_tokens || 0),
    total_tokens: Number(usage?.input_tokens || 0) + Number(usage?.output_tokens || 0),
    token_estimated: !!usage?.token_estimated,
    wall_ms: Number(usage?.wall_ms || 0),
  };
}

export async function emitBudgetReport({
  task, workerId = null, leaseEpoch = null, budget = {}, usage = {},
  reasonKey, reasonMessage = '', plan = null,
}){
  const items = Array.isArray(plan) ? plan : await listPlanItems(task.tenant_id, task.id).catch(() => []);
  const artifacts = getArtifactService();
  const committed = await artifacts.list({ tenantId: task.tenant_id, taskId: task.id, limit: 200 })
    .catch(() => []);
  const report = {
    version: 1,
    task_id: task.id,
    tenant_id: task.tenant_id,
    reason_key: reasonKey,
    reason_message: reasonMessage,
    budget,
    usage: usageSummary(usage),
    plan: {
      items: items.map(i => ({
        item_key: i.item_key,
        title: i.title,
        status: i.status,
        completed: i.status === 'completed',
      })),
      completed_count: items.filter(i => i.status === 'completed').length,
      total_count: items.length,
    },
    artifacts: committed.map(a => ({
      id: a.id, name: a.name, kind: a.kind, size_bytes: a.size_bytes, sha256: a.sha256,
    })),
    generated_at: new Date().toISOString(),
  };

  let artifactId = null;
  try {
    const out = await artifacts.ingest({
      tenantId: task.tenant_id, taskId: task.id,
      workerId, leaseEpoch,
      name: 'budget-report.json', kind: 'output',
      buffer: Buffer.from(JSON.stringify(report, null, 2), 'utf8'),
      mime: 'application/json', createdBy: 'system:budget', dedupe: false,
    });
    artifactId = out?.meta?.id || out?.id || null;
  } catch (e){
    // 报告写入失败不能掩盖原始预算错误；事件仍然记录。
    report.report_write_error = String(e?.code || e?.message || e).slice(0, 200);
  }

  await withTransaction(client => appendEvent(client, {
    tenantId: task.tenant_id, taskId: task.id, type: 'budget.exhausted',
    actorType: 'system',
    payload: {
      reason_key: reasonKey,
      budget_key: reasonKey,
      report_artifact_id: artifactId,
      usage: usageSummary(usage),
    },
  })).catch(() => {});

  return { report, artifact_id: artifactId };
}
