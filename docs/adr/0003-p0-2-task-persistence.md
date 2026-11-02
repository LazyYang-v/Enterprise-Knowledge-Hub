# ADR-0003：P0-2 任务持久化与 Worker 恢复

- 状态：已接受（P0-2）
- 日期：2026-11-02
- 依据：`Enterprise-Knowledge-Hub-Agent-P0-Design.md` §5.2、§9、§10、§13、§15.2

## 背景

P0-1 已把模型/工具循环抽成进程内 Runner，但任务状态仍只存在于 HTTP 请求中。P0-2 要求任务可持久化、可异步执行、可取消/恢复、可回放事件，并在 Worker 崩溃后不重复已完成步骤。

## 决策

### 1. 控制面 PostgreSQL 作为唯一任务事实源

- 新增 `migrations/0002_p0_2_task_runtime.sql`：`recovery_count`、`cancel_requested_by`、`cancelled_by`、重试队列索引。
- `server/control/task-repo.js` 负责所有 SQL；`server/control/task-service.js` 是**唯一**允许改 `agent_tasks.status` 的入口。
- 每次状态迁移都带 `version` 乐观锁，并与 `agent_events` 同事务提交；事件序号通过锁定任务行后 `event_seq + 1` 生成，保证连续。
- 所有查询都带 `tenant_id`；Worker 写入额外带 `lease_owner`。

### 2. 租户映射：组织租户 + 个人租户

- 有组织的用户映射为 `org:<org_id>`；无组织用户映射为 `user:<user_id>`。
- 现有 SQLite 组织 ID 只作为不透明 `source_org_id`，不跨库建外键。
- 这样 P0-2 即可实现跨租户隔离测试，无需先完成组织迁移。

### 3. 领取/心跳/回收

- 领取：`status='queued' AND ready_at <= now()`，`FOR UPDATE SKIP LOCKED`，数据库时间。
- 心跳：`lease_owner + status='running'` 条件续租。**不**使用 `version` 条件：Step 迁移会递增 version，心跳与执行并发时会导致误判失租；状态写入仍严格使用 version fencing。
- 回收：Reaper 处理过期租约、退避到期、取消确认、审批/输入超时。
  - 无在途工具 → 回 `queued`；
  - 只读或带幂等键的外部写 → 回 `queued`，保留同一幂等键；
  - 不支持幂等的外部写 → 工具调用标记 `unknown`，任务进入 `waiting_approval` 生成 `reconciliation` 审批。
- 崩溃时正在执行的 Step 标记 `failed/worker_lost`，恢复后作为新 Step 执行；已完成 Step 不重复。

### 4. Worker 执行器

- `server/control/task-executor.js`：一个 Step = 一次模型调用 + 一个严格解析的 AgentAction。
- P0-2 支持 `plan` / `finish` / `fail` / `ask_user`；`call_tool` 在 ToolRegistry（P0-4）接入前以 `tool_unavailable` 失败，避免“无策略执行工具”。
- 模型配置从 `EKH_AGENT_MODEL_*` 环境变量读取；P0-4 迁移到 `model_profiles` + `credential_ref`，避免明文密钥入库。
- 预算：默认 40 Step / 40 模型调用 / 30 分钟墙钟；耗尽进入 `failed(budget_exhausted)`。
- 可重试错误（模型超时/限流/非法输出等）进入 `retry_wait`，指数退避；超过 `max_attempts` 进入 `failed(retry_exhausted)`。
- 单 Worker 进程串行执行（并发度 1）；多 Worker 通过 SKIP LOCKED 协作，P0-2 不引入进程内并发池。

### 5. 事件与 SSE

- 事件信封遵循 §13.5；`id = seq`，支持 `Last-Event-ID` 续传。
- SSE 使用轮询（默认 500ms）而非 LISTEN/NOTIFY：实现简单、事务后可见、无额外连接状态；P0 规模足够。缺口检测返回 `gap` 事件，客户端应改用快照。
- 终端任务在事件发送完后发送 `event: end` 并关闭；等待状态保持连接。
- 新端点只接受 `Authorization: Bearer`，拒绝 query token（与旧端点兼容策略分离）。

### 6. 特性开关与旧路径

- `AGENT_PLATFORM_ENABLED=1` 才挂载 `/api/tasks`、`/api/approvals`；关闭时返回 404，且不会连接 PostgreSQL。
- 旧 `/api/sessions/:id/chat` 完全不变；P0-1 的 Runner 仍服务旧聊天。

### 7. 取消与恢复

- 取消 `queued`/等待态：直接 `cancelled`。
- 取消 `running`：只设置 `cancel_requested_at`，Worker 在 Step 安全点确认；Worker 死亡时 Reaper 确认取消。
- 恢复只允许 `failed` 且错误可重试、`resume_count < 3`；恢复会重置 attempt、写 `task.resumed`。

## 后果

- 任务不再依赖浏览器连接；关页后 Worker 继续执行，重连可回放事件。
- 需要运行至少一个 Worker（`npm run worker`）；不启动 Worker 时任务停留在 `queued`。
- P0-2 的限制（明确记录，不是遗漏）：
  - 工具执行与审批策略尚未接入（P0-4）；
  - token 用量暂记为 0（当前 `chatOnce` 不返回 usage）；
  - 无成果存储/下载（P0-5）；
  - 审批/输入 API 为骨架，未接入完整 PolicyEngine；
  - SSE 为轮询，不是推送。

## 被否决的方案

| 方案 | 否决原因 |
|---|---|
| 用 Redis/BullMQ 做队列 | 引入第二套一致性/运维，P0 任务量用 PG 足够 |
| 浏览器请求内执行任务 | 无法满足 F-03（关页继续）与 R-01（崩溃恢复） |
| 心跳也带 version 条件 | 与 Step 迁移竞争导致误判失租 |
| Worker 直接读 SQLite 选模型 | 控制面与知识面耦合，且 Worker 不应依赖本地数据目录 |
| 用 LISTEN/NOTIFY 实现 SSE | 增加连接与锁语义；轮询已满足 P0 实时性 |
