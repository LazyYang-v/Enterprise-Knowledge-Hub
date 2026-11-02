# 威胁模型（P0-3 草案）

> 来源：`Enterprise-Knowledge-Hub-Agent-P0-Design.md` §14.11、§14.9、§3.6。
> 本文件描述 P0 目标系统的信任边界与威胁。**P0-0 不修复 G1–G6/G8–G10**；P0-1 修复 G2，P0-3 修复 G1/G9/G10。G3–G6、G8 仍开放到 P0-4/P0-5。

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
| 自定义工具 | 非所有者删除/停用、代码逃逸、SSRF | owner/role 校验、独立进程沙箱、网络默认关闭 | **C3 已复现**：删除/启停无 owner 校验；`node:vm` 不作为隔离 |
| 模型凭证 | 普通用户改模型、API Key 明文泄露 | PlatformAdmin、`credential_ref` | **C4 已复现**：模型管理无管理员校验，Key 明文存 SQLite |
| MCP 入站服务 | 单一全局令牌泄露后读取全部知识 | 服务主体、KB/工具 scope、可吊销 | **C5 已复现**：全局服务令牌可读任意文档 |
| 聊天执行 | 关闭浏览器中止上游、任务不可恢复 | 任务与 HTTP 解耦 | **C6 静态证据**：`res.on('close')` 触发 abort |
| 检索 | 候选集全量读出、内存/延迟不可控 | SQL 预过滤、候选上限 | **C7 已修复（P0-3）**：范围/版本/删除条件下推 SQL，候选上限 + FTS 限量 + topK 上限。测试：`test/integration/retrieval-cap.test.js` |
| 文档版本与引用 | 重解析后引用漂移、旧证据不可回读、删除后仍被检索 | 版本化分块、软删除、证据快照、版本固定 | **G9 已修复（P0-3）**：`document_versions` + `agent_evidence` 快照；引用按 `document_version/content_hash` 固定。测试：`test/integration/knowledge-versioning.test.js`、`test/pg/p03-knowledge.test.js` |
| 用户检索 API | 用户令牌越权 | 可见 KB 过滤 | **C8 基线安全**：越权返回 403 |
| 成果文件 | 路径遍历、未授权下载 | artifact id、canonical path、下载重新校验 ACL | P0-5 实现 |
| 审计与事件 | 篡改、删除 | append-only、权限分离 | 控制面表已有 append-only 触发器；运行时审计 P0-4 |

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
| P0-4 | 工具 owner 校验（G3）、PlatformAdmin 与 `credential_ref`（G4）、MCP 服务主体（G5）、沙箱化（G6）、审批与审计 |
| P0-5/P0-6 | 成果 ACL、路径安全、端到端安全与故障注入 |

## 5. 不做什么

- 不在 P0-0 声称上述缺口已修复。
- 不把 C1–C8 的当前行为写成期望行为。
- 不运行基线脚本于生产数据；脚本只使用临时 SQLite 目录。
