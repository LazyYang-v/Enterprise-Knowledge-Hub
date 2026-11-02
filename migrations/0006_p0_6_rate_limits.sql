-- P0-6：per-tenant 固定窗口限流与 MCP 出网允许列表。
-- 计数表只保留短周期窗口，由 reaper 清理；配置表允许单租户覆盖默认限额。

CREATE TABLE tenant_rate_limits (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bucket text NOT NULL,
  max_requests integer NOT NULL CHECK (max_requests > 0),
  window_ms integer NOT NULL CHECK (window_ms >= 1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, bucket)
);

CREATE TABLE rate_limit_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (tenant_id, bucket, window_start)
);

CREATE INDEX idx_rate_limit_counters_expiry ON rate_limit_counters (window_start);
CREATE INDEX idx_rate_limit_counters_tenant_bucket ON rate_limit_counters (tenant_id, bucket);

ALTER TABLE mcp_connections
  ADD COLUMN egress_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb;
