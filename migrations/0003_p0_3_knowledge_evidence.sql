-- P0-3：证据快照的展示字段、幂等唯一键与检索索引。
-- 迁移只增列/索引，不删除历史数据。

ALTER TABLE agent_evidence
  ADD COLUMN title text NOT NULL DEFAULT '',
  ADD COLUMN kb_name text NOT NULL DEFAULT '';

-- 同一任务内同一分块同一内容只保留一条证据；kill -9/重试不会重复。
CREATE UNIQUE INDEX uq_agent_evidence_chunk
  ON agent_evidence (tenant_id, task_id, chunk_id, content_hash)
  WHERE chunk_id IS NOT NULL;

CREATE INDEX idx_agent_evidence_task_time
  ON agent_evidence (tenant_id, task_id, retrieved_at DESC);

CREATE INDEX idx_agent_evidence_doc_version
  ON agent_evidence (tenant_id, task_id, document_id, document_version);

CREATE INDEX idx_skills_tenant_name
  ON skills (tenant_id, name, version DESC);
