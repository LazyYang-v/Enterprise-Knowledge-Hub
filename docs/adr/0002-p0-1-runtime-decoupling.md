# ADR-0002：P0-1 Runtime 解耦

- 状态：已接受（P0-1）
- 日期：2026-11-02
- 依据：`Enterprise-Knowledge-Hub-Agent-P0-Design.md` §5.1、§5.4、§5.6、§15.2

## 背景

旧聊天路由 `server/routes/chat.js` 同时承担检索、提示词拼装、模型流式调用、工具循环与 SSE 输出。P0-1 要求把模型协议、上下文组装和 AgentAction 解析从路由中抽出，为 P0-2 的任务执行、P0-4 的工具注册与沙箱化提供稳定接口，同时保持旧聊天路径可用，并修复 G2（跨用户 `agent_id`）。

## 决策

### 1. 抽出四个模块，旧路由只做编排

| 模块 | 职责 |
|---|---|
| `server/agent/actions.js` | `AgentAction` 严格解析：类型、字段白名单、大小/深度限制、plan DAG 与环检测、工具允许集合 |
| `server/agent/context-builder.js` | 证据/网络/记忆块与系统提示词；不可信内容边界 |
| `server/agent/model-adapter.js` | 包装现有 `llm.js`，统一流式/非流式入口与错误码，消息文本保持不变 |
| `server/agent/runner.js` | 受控“模型 → 工具 → 模型”循环，最多 6 轮，支持注入 `streamModel` 与 `executeTool` |

`server/routes/chat.js` 只保留会话、检索、SSE 事件与落库，工具循环改为调用 `runAgentLoop`。

### 2. 旧聊天提示词逐字兼容

`buildChatSystemPrompt()` 复刻 P0-0 前的拼装顺序与分隔符，并用单测锁定输出。这样 P0-1 不改变用户可见回答风格，也不需要数据库迁移。

### 3. 旧聊天作为适配器，不在 P0-1 引入任务表

`runAgentLoop` 是纯进程内函数，不读写 PostgreSQL 任务/事件表。P0-2 将在其外层增加租约、检查点、事件与恢复；P0-1 只用注入 `streamModel` 的单测验证循环行为，满足“单 Agent 调用不依赖任务表”的验收。

`AGENT_PLATFORM_ENABLED` 在 P0-1 仍不改变旧聊天行为：本次没有新增入口，Runner 是旧路径的内部重构，开关将用于 P0-2 的任务接口。

### 4. G2 在会话入口统一校验

- `POST /api/sessions`：`agent_id` 必须属于当前用户，否则 403。
- `POST /api/sessions/:id/chat`：会话指向的智能体若存在但不属于当前用户，403；智能体已删除时保持旧行为回退到会话配置。
- `sessionRow()`：回显智能体名称/颜色时同时按 `owner_id` 过滤。

跨用户会话本身仍返回 404（不泄露存在性）。

### 5. 自定义工具继续沿用 vm 沙箱，不改执行语义

P0-1 只把工具循环移入 Runner；`custom-tools.js` 的解析、缓存、超时和结果截断保持不变。真正的隔离、权限与审计在 P0-4 ToolRegistry 处理（G3/G6）。

### 6. 错误分类不改变文案

`ModelAdapter` 为错误附加 `code`（`model_timeout`、`model_rate_limited` 等），但保留原始 `message`。旧 SSE 仍输出 `模型调用失败：<原消息>`，避免前端与既有测试回归。

## 后果

- 后续 Agent Runtime 可以直接复用 Runner/Action/ContextBuilder，不必再改聊天路由。
- 旧聊天路径与自定义工具仍有集成测试覆盖（含真实 SSE 与 function calling）。
- P0-1 不修复 G1/G3–G6/G8–G10；这些仍按阶段处理。
- 重新运行 `npm run repro:baseline` 时 C2 会显示 `not_reproduced`（G2 已修复），属预期变化。

## 被否决的方案

| 方案 | 否决原因 |
|---|---|
| 直接把新 Agent Runtime 接到生产聊天路径 | 缺少任务表、审批与沙箱，风险过大且超出 P0-1 |
| 为旧聊天重写提示词模板 | 会引入回答风格回归，且与 P0-1 目标无关 |
| 在 P0-1 引入任务表并写事件 | 属于 P0-2，且需要租约/恢复语义 |
| 仅在前端隐藏他人智能体 | 服务端仍可被直接调用，无法修复 G2 |
