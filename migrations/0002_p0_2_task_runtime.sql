-- P0-2 任务持久化：恢复计数、取消来源与重试队列索引（设计文档 §5.2、§10.5）
-- 迁移只允许向前追加；不要修改 0001。

ALTER TABLE agent_tasks
  ADD COLUMN recovery_count integer NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
  ADD COLUMN cancel_requested_by text,
  ADD COLUMN cancelled_by text;

CREATE INDEX idx_agent_tasks_retry_due ON agent_tasks (ready_at) WHERE status = 'retry_wait';

CREATE INDEX idx_agent_events_replay ON agent_events (tenant_id, task_id, seq);

CREATE INDEX idx_agent_steps_status ON agent_steps (tenant_id, task_id, status);
