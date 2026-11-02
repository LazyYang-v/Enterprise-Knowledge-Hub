// 任务状态、筛选与预算展示模型。
export const TASK_STATUS_META = {
  queued: { label: '排队中', tone: 'info' },
  running: { label: '运行中', tone: 'info' },
  waiting_approval: { label: '待审批', tone: 'warning' },
  waiting_input: { label: '等待输入', tone: 'warning' },
  retry_wait: { label: '等待重试', tone: 'warning' },
  cancel_requested: { label: '取消中', tone: 'neutral' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
};

export const TASK_FILTERS = [
  { key: 'all', label: '全部', statuses: '' },
  { key: 'running', label: '进行中', statuses: 'queued,running,cancel_requested,waiting_input,retry_wait' },
  { key: 'waiting_approval', label: '待审批', statuses: 'waiting_approval' },
  { key: 'finished', label: '已结束', statuses: 'completed,failed,cancelled' },
];

export const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting_approval', 'waiting_input', 'retry_wait', 'cancel_requested']);
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function statusMeta(status){
  return TASK_STATUS_META[status] || { label: status || '未知', tone: 'neutral' };
}

export function statusForFilter(filter){
  const found = TASK_FILTERS.find(item => item.key === filter);
  return found ? found.statuses : '';
}

export function budgetMeters(snapshot){
  const budget = snapshot?.budget || {};
  const usage = snapshot?.usage || {};
  const totalTokens = Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0);
  const defs = [
    { key: 'steps', label: '步骤', used: usage.steps, limit: budget.max_steps },
    { key: 'model_calls', label: '模型调用', used: usage.model_calls, limit: budget.max_model_calls },
    { key: 'tool_calls', label: '工具调用', used: usage.tool_calls, limit: budget.max_tool_calls },
    { key: 'tokens', label: 'Token', used: totalTokens, limit: budget.max_tokens },
    { key: 'wall_ms', label: '时长', used: usage.wall_ms, limit: budget.max_wall_ms, duration: true },
  ];
  return defs.map(item => {
    const used = Number(item.used || 0);
    const limit = Number(item.limit || 0);
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    return {
      ...item, used, limit, pct,
      tone: pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : 'neutral',
    };
  });
}

const EVENT_LABELS = {
  'task.created': '任务创建',
  'task.queued': '任务入队',
  'task.started': '开始执行',
  'task.completed': '任务完成',
  'task.failed': '任务失败',
  'task.cancelled': '任务取消',
  'task.cancel_requested': '请求取消',
  'task.recovered': '租约恢复',
  'task.resumed': '人工恢复',
  'step.started': '步骤开始',
  'step.completed': '步骤完成',
  'plan.updated': '计划更新',
  'tool.snapshot': '工具快照',
  'tool.started': '工具调用',
  'tool.completed': '工具完成',
  'tool.failed': '工具失败',
  'tool.reused': '工具结果复用',
  'tool.retry_reopened': '工具重试重开',
  'approval.requested': '请求审批',
  'approval.decided': '审批决定',
  'input.requested': '请求输入',
  'input.received': '收到输入',
  'message.created': '新消息',
  'instruction.received': '收到指令',
  'artifact.created': '生成产物',
  'artifact.attached': '附加文件',
  'artifact.deleted': '删除产物',
  'evidence.retrieved': '检索证据',
  'skill.selected': '选择 Skill',
  'policy.scope_reduced': '知识范围收窄',
  'policy.denied': '策略拒绝',
  'budget.exhausted': '预算耗尽',
  'rate_limit.unavailable': '限流不可用',
  'fault.injected': '故障注入',
};

export function eventLabel(type){
  return EVENT_LABELS[type] || type;
}

export function eventTone(type){
  if (!type) return 'neutral';
  if (type.includes('failed') || type.includes('denied') || type === 'budget.exhausted') return 'danger';
  if (type.includes('approval') || type.includes('input') || type.includes('retry')) return 'warning';
  if (type.endsWith('completed') || type.includes('created')) return 'success';
  return 'neutral';
}

export function taskHasPending(snapshot){
  return !!(snapshot?.pending?.approval || snapshot?.pending?.input);
}
