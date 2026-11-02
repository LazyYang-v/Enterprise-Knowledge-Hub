# ADR-0004：P0-3 知识与 Skills

- 状态：已接受
- 日期：2026-11-02
- 关联：`Enterprise-Knowledge-Hub-Agent-P0-Design.md` §6、§8、§15.2；ADR-0002、ADR-0003

## 背景

P0-2 完成任务持久化后，知识与技能仍是缺口：

- **G1**：Agent/会话声明的 `kb_ids` 未与用户可见集合求交集，越权可读。
- **G9**：文档重解析会删除旧分块，引用无法固定版本/哈希。
- **G10**：检索候选无上限，FTS 不按范围过滤，全量 chunk 读入内存。
- 没有统一的 KnowledgeService，也没有可发现的 Skill 机制。

P0-3 引入 KnowledgeService、证据快照、文档版本与 SkillRegistry。工具执行、审批、沙箱与成果文件仍属于 P0-4/P0-5。

## 决策

1. **ACL 唯一入口**：`server/knowledge/acl.js` 提供 `kbAccess/visibleKbs/intersectVisibleKbIds`；路由与 `KnowledgeService` 不再各自实现。
2. **每次检索重新求交集**：范围在任务创建时快照（`input_json.knowledge`），但执行时仍按当前可见集合收缩；权限撤销立即生效。
3. **范围快照字段**：`{mode, requested_kb_ids, effective_kb_ids, input_doc_ids, version_policy, reduced_count, scope_hash}`；Worker 只认快照，不读 Agent 当前配置。
4. **默认范围 = 可见 ∩ 预设**：未指定且预设存在 `default_kb_ids` 时使用预设；否则使用全部可见 KB；`mode:'none'` 显式关闭。
5. **越权语义**：显式 `kb_ids` 越权返回 403；预设/可见范围缩减只记录 `reduced_count` 与 `policy.scope_reduced`，事件不写不可见 KB ID。
6. **SQLite 最小迁移**：使用 `PRAGMA user_version`，只加列/表并回填；单事务，失败回滚。旧文档视为版本 1，旧 chunk 哈希惰性计算。
7. **保留旧分块**：重解析生成新版本，不删除旧版本 chunks；检索默认只取 `document_version = current_version`。
8. **软删除**：删除文档/KB/会话只标记 `deleted_at`，保留 chunks 与版本供历史引用回读；列表/检索/读取排除。
9. **证据快照**：检索结果写入 `agent_evidence`（标题、KB 名、版本、哈希、locator、摘录）；部分唯一索引 `(tenant_id, task_id, chunk_id, content_hash)` + `ON CONFLICT DO NOTHING` 保证 kill -9/重试幂等。
10. **引用固定版本**：`pin_on_first_use` 用本任务已有证据的最早版本约束后续检索；`latest` 允许看到新版本并发 `evidence.version_changed`。
11. **Skill manifest 使用 `skill.json`**：字段语义同设计文档 §6.3，但不引入 YAML 依赖。目录结构：`skill.json` + `SKILL.md` + `references/*.md` + `evals/cases.json`。
12. **Skill 内容哈希与版本固定**：哈希覆盖 manifest、instructions 与 references；同 name/version 内容变化但未升版本时拒绝 reload，保留旧行。任务只记录 `{id,name,version,content_hash}`，执行器按哈希读取冻结 instructions。
13. **平台级 Skill**：P0-3 的 Skill 归属平台租户（`source_org_id='platform'`），所有租户可见；组织级 Skill 留 P0-4。
14. **渐进加载**：`list()` 只返回元数据；`get()` 返回 instructions；references 正文不写入数据库，只存哈希，按需从磁盘读取。
15. **可选性**：显式 Skill > 预设唯一 enabled Skill；要求 `active`、非 `high` risk、`required_tools ⊆ 可用工具`。P0-3 可用工具只有 `knowledge.*`，因此 `spreadsheet-audit` 可列出但不可选。
16. **引用校验**：`finish.citations` 必须是本任务 `agent_evidence.id`；未知/非法 ID 返回 `model_invalid_output`（可重试），不进入 `task.completed`。
17. **自动检索过渡**：P0-3 执行器最多检索两次（goal；首次 plan 后 goal + plan 标题），证据注入现有 `buildAgentSystemPrompt`。P0-4 再暴露 `knowledge.*` 工具。
18. **`input_ids` 桥接**：P0-3 指向当前用户拥有的 SQLite `documents.id`（会话附件/知识库文档），校验 owner、未删除、`ready`；artifact 上传留 P0-5。
19. **服务令牌兼容**：`/api/retrieve` 与 MCP 保持旧行为；`EKH_SERVICE_KB_SCOPE` 可收窄。完整 `service_principals` 留 P0-4。
20. **Worker 解耦**：`server/control/*` 不静态导入知识面/Skill；Worker 通过惰性工厂注入；无范围任务不加载 SQLite。

## 偏差与取舍

- **`ingest_jobs` 延后**：仍使用进程内串行队列。多进程/多实例可靠摄取需要持久队列，留 P0-4/P0-5。
- **Rerank / 查询改写延后**：P0-3 只做候选裁剪与融合，不改变排序模型。
- **Skill 脚本与 references 工具延后**：P0-3 的 references 仅供人工/后续工具读取；Skill 不执行代码。
- **`finish.citations` 使用 UUID 而非展示编号**：`E1` 只是本轮上下文标签，跨轮次会变化；持久化必须使用 `evidence_id`。
- **组织级 Skill 未实现**：平台级满足 P0-3 两个内置 Skill；组织隔离在 P0-4 与 ToolRegistry 一起做。

## 兼容与回滚

- 旧聊天、`/api/retrieve`、MCP、自定义工具、会话附件保持原行为；新增字段均为增量。
- `AGENT_PLATFORM_ENABLED=0` 时 `/api/tasks`、`/api/knowledge`、`/api/skills` 均返回 404。
- 回滚代码到 P0-2 安全：新列/表/索引可被旧代码忽略；旧 Worker 不认识 `input_json.knowledge`，但新任务由新 Worker 消费。
- SQLite 迁移只增不删；首次对现有 `data/app.db` 运行前应备份。

## 验证

- `npm test`：单元 + 集成（ACL、版本、候选上限、Skill manifest、迁移）。
- `DATABASE_URL=..._test npm run test:pg`：任务范围快照、证据幂等、固定版本引用、Skill reload、finish 引用校验。
- P0-3 退出条件：S-01、Q-04、P-02 通过；无权 KB 检索为 0；引用字段完整。

## 后续

P0-4 将引入 ToolRegistry/PolicyEngine/审批/沙箱/MCP 改造，并把 KnowledgeService 暴露为 `knowledge.*` 工具；P0-5 增加成果文件与工作台。
