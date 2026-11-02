# ADR-0006：P0-5 成果面与基础文件工具

- 状态：已接受
- 日期：2026-11-02
- 关联：`Enterprise-Knowledge-Hub-Agent-P0-Design.md` §5.12、§9.5、§14.9；ADR-0003、ADR-0005

## 背景

P0-0 … P0-4 已完成测试/CI、Runtime 解耦、任务持久化、知识/证据/Skill、工具/审批/沙箱/MCP。P0-5 前的缺口：

- PostgreSQL 已有 `artifact_blobs` / `artifacts` / `task_attachments`，但没有仓储、路由或工具；`GET /api/tasks/:id/artifacts` 恒为 `[]`，`finish.artifact_refs` 只校验字符串数组。
- 评测 T19–T24 需要 `artifact.create`、`document.read/write`、`spreadsheet.read/write`、`archive.read/create`，全部不存在。
- 威胁模型 S-09（成果路径遍历、未授权下载）仍开放。

## 决策

1. **不新增迁移**：复用 0001 的 `artifact_blobs` / `artifacts` / `task_attachments`；版本用 `(task_id, name, version)` 唯一约束；创建/附加/删除写 `agent_events`；`migrations.test.js` 的 pending 列表保持 0001–0005。
2. **内容寻址 blob**：磁盘布局 `$EKH_DATA_DIR/artifacts/blobs/<aa>/<bb>/<sha256>`，`storage_key` 只存 `blobs/aa/bb/<sha>`；目录 0700、文件 0600；临时文件写后 fsync + rename；Web 与 Worker 必须共享同一 `EKH_DATA_DIR`。
3. **名称与路径安全**：`normalizeArtifactName` 只接受单段 basename，NFC 规范化，拒绝空/超长/控制字符/双向控制符/`/`、`\`、绝对路径、盘符、`.`/`..`、前导点、Windows 保留名；`storage_key` 只接受 `blobs/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}`；`canonicalBlobPath` 做 lstat 非符号链接 + realpath 根内校验。
4. **下载只认 artifact_id**：每次重新解析 `(tenant_id, task_id)` 并走任务 ACL；所有失败统一 404；响应头 `attachment` + ASCII fallback + `filename*=UTF-8''` + `nosniff` + `private, no-store` + sandbox CSP；流式发送；审计 `artifact.download` 只记 ID、大小、sha 前缀。
5. **ACL 矩阵**：任务 owner 或同租户 admin 可列表/下载/上传/删除；同租户非 owner 非 admin 与跨租户一律 404；终态任务禁止上传附件（409），下载仍可；软删除后不可见、不可下载。组织级共享成果（`visibility='org'`）不在本轮。
6. **文件工具是内置工具**，名称严格匹配评测：`artifact.create`、`document.read`、`document.write`、`spreadsheet.read`、`spreadsheet.write`、`archive.read`、`archive.create`。默认任务工具仍是 4 个知识工具；文件工具需在任务 `tools` 中显式选择。
7. **写工具元数据**：`side_effect='write_workspace'`、`approval_policy='risk_based'`、`idempotency='required'`、`resource_scope='task'`、`sandbox_profile='workspace_write'`。`write_workspace` 为 medium，默认不审批；任务 `approval_mode='always'` 或用户/租户策略可强制审批。
8. **幂等**：文件写不触达外部系统。`createToolCall` 写入 `idempotency_key = '<tool>:<args_hash>:<step.id>:<usage.tool_calls>'`，使 Reaper 直接重领而不是创建人工对账；成果层再按 `(tenant, task, name, kind, sha256)` 复用，同名不同内容 `version+1`。
9. **finish.artifact_refs 双层校验**：executor 在 citations 之后校验所有 ID 属于本任务且未删除；`completeTask` 事务内再校验一次（`ArtifactClaimError`），失败任务不得 completed。
10. **ZIP 统一护栏**：读/写都检查条目名（绝对路径、盘符、`..`、控制字符、重复名、超长）、符号链接/设备条目、加密条目、条目数、单条/总解压大小、压缩比；只内存解压，绝不按条目名落盘；嵌套 ZIP 只列出不展开。
11. **DOCX 只写最小 OOXML**：`adm-zip` 手写 `[Content_Types].xml`、`_rels/.rels`、`docProps/core.xml`、`word/document.xml`，保证 Word/WPS/LibreOffice 可打开与文本正确；无样式/图片/表格。PDF 只读，`document.write('.pdf')` 返回 `document_write_unsupported`。
12. **解析复用**：`server/parse.js` 抽出 `extractTextFromBuffer(buffer, ext, limits)`，PDF 页数、XLSX 行列与总字符受限；`extractText(path, ext)` 读文件后委托；`document.read` / `archive.read` 不产生临时文件。
13. **限额**：单文件 25 MiB、单任务 100 MiB / 100 个、上传 25 MiB、ZIP 200 条/单条 10 MiB/总 40 MiB/压缩比 100、表格 5000 行/100 列、单次文本读取 6000 字符。
14. **前端**：任务详情新增「成果」卡（列表、下载、上传、删除）；新建任务支持选择附件并在创建后上传；事件标签补 `artifact.created/attached/deleted`；下载走现有 Bearer 下载函数。
15. **Skill 可用性动态化**：`availableBuiltinTools()` 从内置工具描述符计算；`spreadsheet-audit` 升到 `1.1.0`，改用 `document.read` / `spreadsheet.read`，reload 后可选。
16. **Schema 校验修正**：对象级 `anyOf` 与父级 `properties/additionalProperties` 同时生效；未声明 `additionalProperties` 时按 JSON Schema 默认允许扩展字段，显式 `false` 仍严格拒绝。

## 明确不做

P0-6：容器/网络命名空间沙箱、真实模型评测运行、per-tenant 限流。PDF 写入、DOCX 样式保真、旧 `.doc/.xls/.ppt`、组织共享成果、在线预览/版本回滚、跨任务复制。旧 SQLite `/api/artifacts` 保持原行为。

## 兼容与回滚

- 无新迁移；回滚到 P0-4 代码时新表无需变更，成果文件可保留在 `data/artifacts` 由后续重新引入。
- 旧聊天附件与旧 `/api/artifacts` 语义不变。
- `AGENT_PLATFORM_ENABLED=0` 时任务成果路由仍返回 404。
- 新事件类型只追加，不改写既有事件。

## 验证

- `npm test`：路径/名称、blob 原子写与校验、ZIP 护栏、DOCX 可读、文件工具契约与往返、对象级 anyOf。
- `DATABASE_URL=..._test npm run test:pg`：去重/版本/ref_count、租约/配额/密钥扫描、上传与 finish 引用、软删除与 GC、T19/T21/T24 假模型循环、崩溃重领不进入对账、成果 API、S-09 ACL。
- 手工：创建带文件工具的任务 → 上传 ZIP/文档 → Worker 执行 → 下载成果 → 跨用户/跨租户确认 404。
