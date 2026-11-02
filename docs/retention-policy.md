# 保留与删除策略（P0-0 草案）

> 来源：设计文档 §9.7。具体期限需与业务/合规确认；本文件是 P0 默认建议，不是最终合同。

## 1. 保留周期

| 数据 | P0 建议 | 说明 |
|---|---|---|
| `agent_tasks` 元数据 | 1 年 | 软删除，可配置 |
| `agent_events` | 90 天热 + 1 年归档 | 审计可能需要更长 |
| `agent_steps` / `agent_tool_calls` / `agent_tool_attempts` | 1 年 | 与任务一致 |
| `agent_evidence` | 1 年 | 引用审计需要 |
| `agent_checkpoints` | 任务完成后 30 天 | 恢复窗口后可清理 |
| `artifacts` | 任务删除后 30 天 | 软删除 + blob GC |
| `audit_log` | 3 年 | 合规可配置 |
| `idempotency_keys` | 1–7 天 | 按端点 |
| 知识面文档/分块 | 不自动删除 | P0 仍由现有知识库管理 |

## 2. 删除流程

1. 任务软删除，写 `task.deleted` 事件。
2. 成果软删除（`artifacts.deleted_at`），立即停止下载。
3. 保留期内可恢复；恢复需要 owner/admin 且写审计。
4. 到期后 GC blob；事件/审计按策略归档或删除。
5. 法律保留（legal hold）优先于自动删除；有保留标记的数据不得 GC。
6. 审计记录不物理删除；归档走独立、受审计的流程。

## 3. Blob GC（P0-5 已实现）

- blob 按 SHA-256 内容寻址并去重；`storage_key` 只存 `blobs/aa/bb/<sha>`。
- 软删除只写 `artifacts.deleted_at`，列表/下载立即不可见；`ref_count` 与数据库引用为准。
- GC 先锁定 blob，清理超过宽限期（默认 24h）的软删除行；仍有引用则跳过；删除行后再删文件。
- 孤儿文件（数据库无记录且超过宽限期）进入 `artifacts/quarantine`，不自动物理删除。
- 运维命令：`npm run artifacts:gc -- --dry-run` / `npm run artifacts:gc` / `--grace-ms=0`（仅维护）。
- 所有删除操作写审计；法律保留（legal hold）优先于自动删除，有保留标记的数据不得 GC。

## 4. 事件与审计不可变

- `agent_events`、`audit_log` 在 P0-0 迁移中已有 append-only 触发器，拒绝 UPDATE/DELETE。
- 归档只允许“复制到归档存储 + 受审计的特权清理”，不得由普通 Worker/API 执行。
- 事件序号 `(task_id, seq)` 唯一；出现缺口必须告警。

## 5. 待确认

- 各保留期限的合规依据。
- 归档存储位置与加密要求。
- 用户注销后的数据删除范围。
- 知识面文档删除与任务证据快照的关系（P0-3 版本化后明确）。
