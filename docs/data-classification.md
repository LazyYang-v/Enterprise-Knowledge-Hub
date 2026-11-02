# 数据分类（P0-0 草案）

> 来源：设计文档 §14.8、§14.12、§9.7。分类用于决定存储、传输、日志、模型可见性和保留策略。

## 1. 分类级别

| 级别 | 定义 | 示例 | 默认处理 |
|---|---|---|---|
| `public` | 可公开的信息 | 产品介绍、公开文档 | 可进入普通日志；可用于外部模型 |
| `internal` | 仅组织内部使用 | 内部流程、普通知识库 | ACL 控制；日志只记 ID/摘要 |
| `confidential` | 敏感业务数据 | 合同、财务、采购申请、人事 | 最小化传递；禁止进入调试日志；外部模型需策略允许 |
| `restricted` | 密钥与高敏凭证 | API Key、服务令牌、密码、私钥 | 只存 `credential_ref`/哈希；**永不**进入 prompt、事件、日志、成果 |

## 2. 按数据对象映射

| 数据 | 默认级别 | 存储 | 日志/事件 | 模型/工具 |
|---|---|---|---|---|
| 用户身份（email、name） | `internal` | SQLite `users` | 可记 user_id，不记密码哈希 | 不进 prompt |
| 密码哈希 | `restricted` | SQLite（scrypt） | 禁止 | 禁止 |
| API Key / MCP token / 服务 token | `restricted` | P0-0 仍在 SQLite（G4）；目标 `credential_ref` + Secret Manager | 禁止 | 禁止 |
| 知识库文档与分块 | `internal` / `confidential`（按知识库） | SQLite + uploads | 检索审计记 query 摘要与结果数 | 作为不可信证据 |
| 任务目标与输入 | `internal` / `confidential` | PostgreSQL（P0-2） | 事件只存摘要 | 按任务范围 |
| 工具参数 | 取决于工具 | PostgreSQL `agent_tool_calls` | 密钥参数脱敏；只留哈希/掩码 | 只传必要参数 |
| 证据快照 | 与来源同级 | PostgreSQL `agent_evidence` | 可记引用 ID、哈希 | 标记 `untrusted` |
| 成果文件 | 与任务同级 | 内容寻址 blob（`EKH_DATA_DIR/artifacts`） | 创建/附加/删除/下载事件与审计只记 ID、大小、sha 前缀 | 文件工具结果标记 `untrusted`；文本写入前做密钥扫描 |
| 审计日志 | `internal` | PostgreSQL `audit_log` | append-only | 禁止 |

## 3. 控制规则

1. **最小化**：模型供应商只接收完成任务所需的最小数据；`restricted` 永不出站。
2. **分离**：知识面（SQLite）与控制面（PostgreSQL）跨库只存不透明 ID。
3. **脱敏**：工具参数中的 token、密码、Authorization 头在持久化前脱敏，只保留哈希或掩码。
4. **日志**：默认不记录完整 prompt、完整文档、完整工具输出；需要排障时记录哈希、长度、模型、耗时。
5. **前端**：不返回 system prompt、隐藏思维链、存储路径、其他用户的工具参数。
6. **模型输出**：Markdown 安全渲染；禁止原始 HTML；成果交付前做密钥/PII 扫描（P0-6）。
7. **外部模型**：机密任务可配置禁用外部模型（P1）；P0 至少按知识库/任务标记并在审计中体现。

## 4. 待业务确认

- 哪些知识库属于 `confidential`，由谁标注。
- 是否允许 `confidential` 数据进入第三方模型。
- 审计日志与成果的合规保留年限。
- 个人信息范围与脱敏规则（PII 字段清单）。
