-- P0-4：工具注册表归属、工具调用结果哈希、审批一次性消费。
-- 只增列/索引，不重写已有数据；迁移框架负责事务与校验和。

ALTER TABLE tool_registry
  ADD COLUMN owner_id text NOT NULL DEFAULT '';

ALTER TABLE agent_tool_calls
  ADD COLUMN code_hash text NOT NULL DEFAULT '',
  ADD COLUMN result_hash text NOT NULL DEFAULT '';

ALTER TABLE agent_approvals
  ADD COLUMN consumed_at timestamptz,
  ADD COLUMN consumed_by text;

ALTER TABLE service_principals
  ADD COLUMN revoked_at timestamptz;

CREATE INDEX idx_agent_tool_calls_task_tool
  ON agent_tool_calls (tenant_id, task_id, tool_name);

CREATE INDEX idx_tool_registry_owner
  ON tool_registry (tenant_id, source, owner_id);

CREATE INDEX idx_agent_approvals_consumed
  ON agent_approvals (tenant_id, consumed_at);

CREATE INDEX idx_service_principals_active
  ON service_principals (token_hash) WHERE revoked_at IS NULL;
