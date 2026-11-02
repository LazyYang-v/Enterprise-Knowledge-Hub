-- P0-4：领取级 fencing。lease_epoch 只在领取时递增，不随 resume 或重试重置。
-- 证据行记录写入时的领取，完成事务只接受本次领取产生的引用。

ALTER TABLE agent_tasks
  ADD COLUMN lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0);

ALTER TABLE agent_evidence
  ADD COLUMN lease_epoch bigint;

CREATE INDEX idx_agent_evidence_claim
  ON agent_evidence (tenant_id, task_id, lease_epoch);
