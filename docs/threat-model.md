# 威胁模型（P0-6）

> 来源：`Enterprise-Knowledge-Hub-Agent-P0-Design.md` §14.11、§14.9、§3.6。
> 本文件描述 P0 目标系统的信任边界与威胁。P0-1 修复 G2，P0-3 修复 G1/G9/G10，P0-4 修复 G3–G6/G8，P0-5 修复 S-09（成果文件 ACL），P0-6 收口容器沙箱、MCP 出网、租户限流、外部写幂等与预算报告。

## 1. 信任边界

| 边界 | 可信 | 不可信 |
|---|---|---|
| 浏览器 ↔ API | 已登录用户身份（Bearer 令牌） | 请求体中的 user_id、owner_id、kb_ids、工具参数 |
| API ↔ 知识面（SQLite） | 服务端 ACL 计算结果 | 文档内容、文件名、解析结果 |
| Worker ↔ 模型 | 系统规则、工具 schema（内置） | 模型输出、Action 参数、工具调用意图 |
| Worker ↔ 外部系统 | 受控工具实现 | MCP 工具描述、外部返回内容、网页 |
| 任务 ↔ 证据 | 证据快照的哈希与版本 | 证据正文中的“指令” |
| 成果存储 ↔ 下载 | 任务 ACL | 客户端传入的路径/文件名 |

## 2. 资产与威胁

| 资产 | 威胁 | P0 控制目标 | 当前状态 |
|---|---|---|---|
| 知识库内容 | 跨用户/跨租户读取、越权检索 | SQL 层 ACL 交集、服务主体 scope | **C1 已修复（P0-3）**：`KnowledgeService` 在创建任务与每次检索时重新求交集；聊天/Agent 同样交集；显式越权 403。测试：`test/integration/knowledge-acl.test.js`、`test/pg/p03-knowledge.test.js` |
| 任务与配置 | 使用他人 Agent、读取他人任务参数 | 任务 ACL、owner 校验、参数脱敏 | **C2 已修复（P0-1）**：会话创建/加载/回显均校验 agent owner |
| 自定义工具 | 非所有者删除/停用、代码逃逸、SSRF | owner/role 校验、独立进程沙箱、网络默认关闭 | **C3 已修复（P0-4）**：工具归属 + 不可变版本；子进程沙箱阻断 `fetch/process/require/fs`。测试：`test/integration/tool-admin.test.js`、`test/integration/chat-sandbox.test.js`、`test/pg/tool-policy.test.js` |
| 模型凭证 | 普通用户改模型、API Key 明文泄露 | PlatformAdmin、`credential_ref` | **C4 已修复（P0-4）**：模型写操作仅 PlatformAdmin；凭证只存 `env:`/受限 `file:` 引用，响应只返回 `credential_configured`。测试：`test/integration/tool-admin.test.js`、`test/pg/model-profile.test.js` |
| MCP 入站服务 | 单一全局令牌泄露后读取全部知识 | 服务主体、KB/工具 scope、可吊销 | **C5 已修复（P0-4）**：`service_principals` 哈希令牌 + KB scope + 吊销/过期；旧全局令牌默认兼容但可关闭。测试：`test/pg/service-principal.test.js` |
| 聊天执行 | 关闭浏览器中止上游、任务不可恢复 | 任务与 HTTP 解耦 | **C6 静态证据**：`res.on('close')` 触发 abort |
| 检索 | 候选集全量读出、内存/延迟不可控 | SQL 预过滤、候选上限 | **C7 已修复（P0-3）**：范围/版本/删除条件下推 SQL，候选上限 + FTS 限量 + topK 上限。测试：`test/integration/retrieval-cap.test.js` |
| 文档版本与引用 | 重解析后引用漂移、旧证据不可回读、删除后仍被检索 | 版本化分块、软删除、证据快照、版本固定 | **G9 已修复（P0-3）**：`document_versions` + `agent_evidence` 快照；引用按 `document_version/content_hash` 固定。测试：`test/integration/knowledge-versioning.test.js`、`test/pg/p03-knowledge.test.js` |
| 用户检索 API | 用户令牌越权 | 可见 KB 过滤 | **C8 基线安全**：越权返回 403 |
| 成果文件 | 路径遍历、未授权下载、ZIP 逃逸/炸弹 | artifact id、canonical path、下载重新校验 ACL、ZIP 护栏 | **S-09 已修复（P0-5）**：文件名单段 basename + 控制字符/保留名拒绝；blob 路径只由 SHA-256 生成并做 realpath 根内校验；下载每次重新校验任务 ACL，失败统一 404，响应 `attachment`/`nosniff`/`private, no-store`；审计 `artifact.download`；ZIP 拒绝 `..`/绝对路径/符号链接/加密/重复名/超限/高压缩比。测试：`test/unit/artifact-paths.test.js`、`test/unit/zip-guard.test.js`、`test/pg/artifacts-api.test.js`、`test/pg/artifact-acl.test.js` |
| 工具执行 | 模型越权调用、危险副作用无人确认、重放 | 任务快照、默认拒绝、一次性审批绑定参数、预算 | **G8 已修复（P0-4）**：PolicyEngine + `agent_approvals`（`args_hash`/`consumed_at`）+ 执行前持久化；审批过期不执行；工具尝试/调用完成按 `attempt+worker+lease_epoch` fencing。测试：`test/pg/tool-approval.test.js`、`test/pg/task-fencing.test.js`、`test/unit/tool-policy.test.js` |
| 审计与事件 | 篡改、删除 | append-only、权限分离 | 控制面表已有 append-only 触发器；**P0-4 运行时审计已接入**（策略拒绝/审批/工具/管理操作，只写 ID 与哈希） |
| 沙箱逃逸与网络 | 自定义工具逃逸、横向移动、资源耗尽、孤儿进程 | 容器隔离、无网络、只读根、非 root、cap-drop、pids/memory/cpu 限额、生命周期回收 | **P0-6**：`container` 显式启用且失败关闭；`--network=none`、只读根、uid 10001、`cap-drop=ALL`、`no-new-privileges`、pids/memory/cpu/ulimit；abort/超时/停机杀容器；容器内硬超时兜底。残余风险：容器运行时本身是信任边界，非 VM 级隔离 |
| MCP 出站（SSRF） | 私网/元数据地址、重定向绕过、DNS rebinding、私网 mock 误用 | 解析后拒绝、禁重定向、allowlist、每次调用重校验 | **P0-6**：默认拒绝私网/元数据/userinfo/3xx；连接 CRUD 与调用都校验；本机 mock 必须显式放开。残余风险：DNS rebinding 无法完全消除，需出网代理/固定 IP |
| 租户资源滥用 | 单租户刷任务/模型/工具拖垮共享 PG/Worker | per-tenant 固定窗口、原子计数、429 + Retry-After、fail-closed | **P0-6**：`tenant_rate_limits`/`rate_limit_counters`；模型超限可重试，工具超限非致命；PG 故障默认拒绝，显式 `fail_open` 才降级 |
| 外部写重放 | Worker 崩溃后重复创建订单/记录 | provider 幂等键跨恢复稳定、外部系统去重 | **P0-6**：`sha256(tenant+task+tool+args_hash)` 写入 `Idempotency-Key` 与 `_meta.idempotency_key`；同一逻辑 `tool_call_id` 复用、attempt 递增；无幂等键的写仍进入人工对账 |
| 预算耗尽 | 无上限消耗 token/时间/工具，丢失已完成工作 | 五类预算硬检查 + 部分成果报告 | **P0-6**：`max_steps/max_wall_ms/max_model_calls/max_tokens/max_tool_calls`；耗尽先写 `budget-report.json` 与 `budget.exhausted`，任务仍 `failed/budget_exhausted` |

详细复现记录见 `docs/baseline/c1-c8.md`。

## 3. 提示注入与不可信内容

| 威胁 | 控制原则 |
|---|---|
| 知识文档包含“忽略以上指令” | 证据用 `UNTRUSTED_EVIDENCE_START/END` 包裹；系统规则声明证据只是数据；运行时权限不因文本改变 |
| 网页/工具返回恶意指令 | 结果标记 `untrusted=true`；不自动链式调用 |
| MCP 工具描述诱导越权 | 管理员允许列表；工具描述不可信；策略独立判断 |
| 文件名/路径注入 | basename、控制字符过滤、canonical path 校验 |
| Unicode 双向控制/隐藏文本 | 清洗/转义并在渲染时可见化 |
| 模型输出 HTML/JS | Markdown 安全渲染、CSP、禁止原始 HTML |
| 诱导泄露系统提示 | 系统提示不进入前端；输出 DLP 扫描 |
| 诱导外部发送 | `external_send` 强制审批并展示真实参数 |

**原则：不依赖模型“识别并拒绝”提示注入，必须在运行时用权限、审批、沙箱和输出检查兜底。**

## 4. 分阶段控制

| 阶段 | 控制 |
|---|---|
| P0-0（本轮） | 测试/CI、迁移、特性开关默认关闭、生产禁用演示数据、威胁模型与 C1–C8 基线 |
| P0-1 | 抽取 Runtime；修复 G2（agent owner/租户校验） |
| P0-2 | 任务持久化、租约、检查点、事件 |
| P0-3（已完成） | KnowledgeService ACL 交集（G1）、文档版本与证据快照（G9）、检索上限（G10） |
| P0-4（已完成） | 工具 owner 校验（G3）、PlatformAdmin 与 `credential_ref`（G4）、MCP 服务主体（G5）、沙箱化（G6）、审批与审计（G8） |
| P0-5（已完成） | 成果 ACL（S-09）、内容寻址 blob、下载审计、ZIP 路径遍历/炸弹防御、finish 引用归属校验 |
| P0-6 | 容器/网络命名空间沙箱、真实模型评测与故障注入、per-tenant 限流 |

## 5. 不做什么

- 不在 P0-0 声称上述缺口已修复。
- 不把 C1–C8 的当前行为写成期望行为。
- 不运行基线脚本于生产数据；脚本只使用临时 SQLite 目录。
