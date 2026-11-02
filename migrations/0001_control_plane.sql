-- P0-0 控制面核心表（设计文档 §9.3）
-- 约定：
--   * 所有时间使用 timestamptz，默认 now()（UTC）。
--   * 所有租户数据表都有 tenant_id；复合索引以 tenant_id 开头（§9.1 / §18.3）。
--   * 控制面与知识面（SQLite）跨库不建外键，知识面 ID 只存不透明文本。
--   * 事件/审计为 append-only。

-- ============ A. 身份、配置与能力 ============

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  source_org_id text UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  provider text NOT NULL DEFAULT '',
  base_url text NOT NULL DEFAULT '',
  model_name text NOT NULL DEFAULT '',
  credential_ref text NOT NULL DEFAULT '',
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  context_window integer CHECK (context_window IS NULL OR context_window > 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE agent_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  model_profile_id uuid REFERENCES model_profiles(id),
  system_prompt text NOT NULL DEFAULT '',
  default_kb_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  budget_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_version integer NOT NULL DEFAULT 1 CHECK (config_version >= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_agent_presets_active_name ON agent_presets (tenant_id, name) WHERE status = 'active';

CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  version text NOT NULL,
  manifest_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_path text NOT NULL DEFAULT '',
  content_hash text NOT NULL,
  risk_level text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'deprecated')),
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, version)
);
CREATE INDEX idx_skills_content_hash ON skills (content_hash);

CREATE TABLE agent_preset_skills (
  preset_id uuid NOT NULL REFERENCES agent_presets(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (preset_id, skill_id)
);

CREATE TABLE tool_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  version text NOT NULL,
  source text NOT NULL CHECK (source IN ('builtin', 'custom', 'mcp', 'system')),
  description text NOT NULL DEFAULT '',
  input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_schema jsonb,
  side_effect text NOT NULL CHECK (side_effect IN ('read', 'write_workspace', 'write_business', 'external_send', 'destructive', 'code_exec')),
  approval_policy text NOT NULL DEFAULT 'risk_based' CHECK (approval_policy IN ('never', 'risk_based', 'always')),
  timeout_ms integer NOT NULL DEFAULT 30000 CHECK (timeout_ms > 0),
  idempotency text NOT NULL DEFAULT 'none' CHECK (idempotency IN ('none', 'required', 'provider_key')),
  resource_scope text NOT NULL DEFAULT 'task' CHECK (resource_scope IN ('task', 'knowledge_base', 'external')),
  sandbox_profile text NOT NULL DEFAULT 'read_only' CHECK (sandbox_profile IN ('read_only', 'workspace_write', 'network_allowlist', 'code_exec', 'browser')),
  data_classification text NOT NULL DEFAULT 'internal' CHECK (data_classification IN ('public', 'internal', 'confidential')),
  rate_limit jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, version)
);

CREATE TABLE tool_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  tool_name text NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'role', 'preset', 'tenant')),
  principal_id text NOT NULL,
  approval_mode text NOT NULL DEFAULT 'risk_based' CHECK (approval_mode IN ('never', 'risk_based', 'always')),
  max_calls_per_task integer CHECK (max_calls_per_task IS NULL OR max_calls_per_task >= 0),
  allowed_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tool_name, principal_type, principal_id)
);

CREATE TABLE mcp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  transport text NOT NULL DEFAULT 'streamable_http' CHECK (transport IN ('streamable_http', 'stdio')),
  endpoint text NOT NULL DEFAULT '',
  auth_type text NOT NULL DEFAULT 'none',
  credential_ref text NOT NULL DEFAULT '',
  allowed_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  denied_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
  last_health_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE mcp_tool_cache (
  connection_id uuid NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_hash text NOT NULL,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (connection_id, tool_name)
);

CREATE TABLE service_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ B. 任务与执行 ============

CREATE TABLE agent_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_id text NOT NULL,
  preset_id uuid REFERENCES agent_presets(id),
  preset_version integer,
  title text NOT NULL DEFAULT '',
  goal text NOT NULL,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'running', 'waiting_approval', 'waiting_input', 'retry_wait',
    'cancel_requested', 'completed', 'failed', 'cancelled'
  )),
  priority integer NOT NULL DEFAULT 100,
  ready_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  resume_count integer NOT NULL DEFAULT 0 CHECK (resume_count >= 0),
  current_step_seq bigint NOT NULL DEFAULT 0,
  event_seq bigint NOT NULL DEFAULT 0,
  plan_version integer NOT NULL DEFAULT 0,
  budget_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  last_error_code text,
  last_error_detail text,
  result_summary text,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CHECK (status <> 'running' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (status <> 'completed' OR result_summary IS NOT NULL),
  CHECK (status <> 'failed' OR last_error_code IS NOT NULL)
);
CREATE INDEX idx_agent_tasks_queue ON agent_tasks (status, ready_at, priority, created_at) WHERE status = 'queued';
CREATE INDEX idx_agent_tasks_owner ON agent_tasks (tenant_id, owner_id, created_at DESC);
CREATE INDEX idx_agent_tasks_lease ON agent_tasks (lease_expires_at) WHERE status = 'running';
CREATE INDEX idx_agent_tasks_tenant_status ON agent_tasks (tenant_id, status, updated_at DESC);

CREATE TABLE agent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  task_id uuid NOT NULL,
  seq bigint NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content text NOT NULL DEFAULT '',
  content_json jsonb,
  actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, tenant_id) REFERENCES agent_tasks(id, tenant_id) ON DELETE CASCADE,
  UNIQUE (task_id, seq)
);
CREATE INDEX idx_agent_messages_tenant ON agent_messages (tenant_id, task_id, seq);

CREATE TABLE agent_plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  task_id uuid NOT NULL,
  plan_version integer NOT NULL,
  item_key text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'blocked', 'cancelled')),
  depends_on jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, tenant_id) REFERENCES agent_tasks(id, tenant_id) ON DELETE CASCADE,
  UNIQUE (task_id, plan_version, item_key)
);
CREATE INDEX idx_agent_plan_items_tenant ON agent_plan_items (tenant_id, task_id, plan_version);

CREATE TABLE agent_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  task_id uuid NOT NULL,
  seq bigint NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  model_profile_id uuid REFERENCES model_profiles(id),
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  started_at timestamptz,
  ended_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, tenant_id) REFERENCES agent_tasks(id, tenant_id) ON DELETE CASCADE,
  UNIQUE (task_id, seq)
);
CREATE INDEX idx_agent_steps_tenant ON agent_steps (tenant_id, task_id, seq);

CREATE TABLE agent_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  task_id uuid NOT NULL,
  step_id uuid REFERENCES agent_steps(id) ON DELETE SET NULL,
  tool_name text NOT NULL,
  tool_version text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'builtin',
  args_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  args_hash text NOT NULL,
  side_effect text NOT NULL,
  approval_id uuid,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'awaiting_approval', 'running', 'succeeded', 'failed', 'unknown', 'reconciled'
  )),
  idempotency_key text,
  result_json jsonb,
  result_blob_id uuid,
  result_preview text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, tenant_id) REFERENCES agent_tasks(id, tenant_id) ON DELETE CASCADE,
  UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX uq_agent_tool_calls_idem ON agent_tool_calls (task_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_agent_tool_calls_status ON agent_tool_calls (tenant_id, task_id, status);

CREATE TABLE agent_tool_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  tool_call_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  worker_id text NOT NULL DEFAULT '',
  lease_epoch bigint NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  error_code text,
  result_hash text,
  FOREIGN KEY (tool_call_id, tenant_id) REFERENCES agent_tool_calls(id, tenant_id) ON DELETE CASCADE,
  UNIQUE (tool_call_id, attempt_no)
);
CREATE INDEX idx_agent_tool_attempts_tenant ON agent_tool_attempts (tenant_id, tool_call_id);

CREATE TABLE agent_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  task_id uuid NOT NULL,
  tool_call_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'tool_call',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  risk_level text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
  request_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  args_hash text NOT NULL,
  requested_by text NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_by text,
  decision_comment text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, tenant_id) REFERENCES agent_tasks(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tool_call_id, tenant_id) REFERENCES agent_tool_calls(id, tenant_id) ON DELETE CASCADE,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX uq_agent_approvals_pending ON agent_approvals (tool_call_id) WHERE status = 'pending';
CREATE INDEX idx_agent_approvals_due ON agent_approvals (tenant_id, status, expires_at);

CREATE TABLE agent_input_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  task_id uuid NOT NULL,
  step_id uuid REFERENCES agent_steps(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'expired', 'cancelled')),
  question text NOT NULL,
  input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  answer_json jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  answered_by text,
  expires_at timestamptz,
  FOREIGN KEY (task_id, tenant_id) REFERENCES agent_tasks(id, tenant_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_agent_inputs_pending ON agent_input_requests (task_id) WHERE status = 'pending';
CREATE INDEX idx_agent_inputs_due ON agent_input_requests (tenant_id, status, expires_at);

CREATE TABLE agent_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  task_id uuid NOT NULL,
  step_seq bigint NOT NULL,
  state_json jsonb NOT NULL,
  state_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, tenant_id) REFERENCES agent_tasks(id, tenant_id) ON DELETE CASCADE,
  UNIQUE (task_id, step_seq)
);
CREATE INDEX idx_agent_checkpoints_tenant ON agent_checkpoints (tenant_id, task_id, step_seq DESC);

CREATE TABLE agent_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  task_id uuid NOT NULL,
  seq bigint NOT NULL,
  type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type text NOT NULL DEFAULT 'system' CHECK (actor_type IN ('user', 'worker', 'system', 'model', 'tool')),
  actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, tenant_id) REFERENCES agent_tasks(id, tenant_id) ON DELETE CASCADE,
  UNIQUE (task_id, seq)
);
CREATE INDEX idx_agent_events_task_seq ON agent_events (tenant_id, task_id, seq DESC);

-- ============ C. 证据与成果 ============

CREATE TABLE agent_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  task_id uuid NOT NULL,
  step_id uuid REFERENCES agent_steps(id) ON DELETE SET NULL,
  tool_call_id uuid REFERENCES agent_tool_calls(id) ON DELETE SET NULL,
  kb_id text,
  document_id text,
  document_version integer,
  chunk_id text,
  content_hash text NOT NULL,
  locator_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  excerpt text NOT NULL DEFAULT '',
  score double precision,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  full_content_blob_id uuid,
  FOREIGN KEY (task_id, tenant_id) REFERENCES agent_tasks(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_evidence_doc ON agent_evidence (tenant_id, task_id, document_id);

CREATE TABLE artifact_blobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 text NOT NULL UNIQUE,
  storage_key text NOT NULL UNIQUE,
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  mime text NOT NULL DEFAULT 'application/octet-stream',
  ref_count integer NOT NULL DEFAULT 0 CHECK (ref_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  task_id uuid NOT NULL,
  step_id uuid REFERENCES agent_steps(id) ON DELETE SET NULL,
  blob_id uuid NOT NULL REFERENCES artifact_blobs(id),
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'output' CHECK (kind IN ('input', 'output', 'intermediate')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  visibility text NOT NULL DEFAULT 'task',
  download_policy text NOT NULL DEFAULT 'task_acl',
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY (task_id, tenant_id) REFERENCES agent_tasks(id, tenant_id) ON DELETE CASCADE,
  UNIQUE (task_id, name, version)
);
CREATE INDEX idx_artifacts_task ON artifacts (tenant_id, task_id, created_at DESC);

CREATE TABLE task_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  task_id uuid NOT NULL,
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'upload',
  source_ref text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, tenant_id) REFERENCES agent_tasks(id, tenant_id) ON DELETE CASCADE,
  UNIQUE (task_id, artifact_id)
);
CREATE INDEX idx_task_attachments_tenant ON task_attachments (tenant_id, task_id);

-- ============ D. 运维与安全 ============

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid,
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  resource_type text NOT NULL DEFAULT '',
  resource_id text NOT NULL DEFAULT '',
  decision text NOT NULL DEFAULT '',
  ip inet,
  user_agent text,
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant_time ON audit_log (tenant_id, created_at DESC);

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL,
  principal_id text NOT NULL,
  endpoint text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress',
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, endpoint, idempotency_key)
);
CREATE INDEX idx_idempotency_expiry ON idempotency_keys (expires_at);

CREATE TABLE worker_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname text NOT NULL,
  pid integer NOT NULL,
  version text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draining', 'stopped'))
);
CREATE INDEX idx_worker_nodes_heartbeat ON worker_nodes (last_heartbeat_at);

-- ============ 不可变日志保护 ============

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table: % does not allow %', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_events_append_only
  BEFORE UPDATE OR DELETE ON agent_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
