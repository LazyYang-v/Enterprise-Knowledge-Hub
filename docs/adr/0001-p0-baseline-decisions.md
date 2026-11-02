# ADR-0001：P0-0 基线与护栏决策

- 状态：已接受（P0-0）
- 日期：2026-11-02
- 依据：`Enterprise-Knowledge-Hub-Agent-P0-Design.md` §15.2、§18、附录 D

## 背景

现有应用是 Express + `node:sqlite` 的单体问答系统，没有测试、CI、迁移或控制面数据库。设计文档要求先建立基线与护栏，再进入 Runtime 和任务持久化。P0-0 的目标是让后续阶段有可回归、可迁移、可开关的基础，同时不改变旧业务语义。

## 决策

### 1. 控制面 PostgreSQL，知识面继续 SQLite

- 任务、步骤、事件、审批、检查点、成果元数据进入 PostgreSQL。
- 知识库、文档、分块、FTS5、摄取继续由现有 SQLite 提供。
- 控制面所有租户数据表（含 `agent_messages`、`agent_events`、`artifacts` 等子表）都带 `tenant_id`，复合索引以 `tenant_id` 开头；子表通过 `(task_id, tenant_id)` 复合外键保证租户一致。
- 跨库只存不透明 ID；一致性靠证据快照、幂等键和事件，不做分布式事务。
- 原因：一次性迁移知识面会同时引入 FTS 语义、向量索引、文件路径和权限核对风险，与“让 Agent 能干活”不是同一风险等级。

### 2. 特性开关 `AGENT_PLATFORM_ENABLED`，默认关闭

- P0-0 只提供配置读取与测试，不接线到路由。
- 关闭时旧应用行为不变；P0-1 起按开关逐步启用新路径。
- 原因：允许旧路径作为回滚通道，避免新旧双写。

### 3. 测试使用 Node 内置 `node:test`

- 不引入 Jest/Vitest/Supertest。
- 每个测试文件独立进程；通过 `EKH_DATA_DIR` 使用临时 SQLite 数据目录。
- 集成测试直接启动 `createApp()` 到随机端口，用 `fetch` 调用真实路由。
- 原因：零新增测试依赖、贴近真实 HTTP 行为、进程隔离天然避免数据库串扰。

### 4. 迁移使用纯 SQL + `schema_migrations`

- `migrations/*.sql` 按文件名排序，单文件一个事务。
- SHA-256 校验和防止已执行迁移被改写。
- 支持 `up`、`status`、`--dry-run`；dry-run 只读。
- 测试只允许在名称以 `_test` 结尾的数据库上重建 `public` schema。
- 拒绝 ORM/迁移库：P0-0 需要的是可审计、可重放的 DDL，而不是运行时映射。

### 5. 生产环境禁止演示数据（G7）

- `demoSeedEnabled = !isProduction && EKH_ENABLE_DEMO_SEED !== 0`。
- 生产模式即使显式设置开启也会跳过；启动日志不打印演示账号。
- 原因：默认弱口令是生产部署的直接风险。

### 6. C1–C8 作为非门禁基线

- `npm run repro:baseline` 在临时目录复现当前行为，输出 `docs/baseline/c1-c8.{json,md}`。
- 不进入 CI 门禁，不把当前漏洞写成测试期望。
- 无法无侵入复现的检查标记为 `static_evidence` 并附源码位置。
- 原因：P0-0 的职责是记录现状；修复按阶段进行。

## 后果

- 需要维护两套数据存储和两套连接配置，但避免了知识面迁移风险。
- 测试与迁移可在无 Docker 的情况下运行 SQLite 部分；PostgreSQL 测试需要 `DATABASE_URL`。
- P0-1 起必须保持旧聊天路径可用，直到回归通过。
- P0-0 不修复 G1–G6/G8–G10，安全评审时需明确这些是已知缺口而非遗漏。

## 被否决的方案

| 方案 | 否决原因 |
|---|---|
| 一次性把知识库迁移到 PostgreSQL | 风险大、与 Agent 控制面耦合、回滚困难 |
| 引入 Jest/Vitest + Supertest | 增加依赖与配置，内置 runner 已满足 P0-0 |
| 使用 ORM/迁移框架 | 黑盒 DDL，不利于审计与 DBA 复核 |
| 在 P0-0 直接修复全部安全缺口 | 与文档阶段划分冲突，且缺少 Runtime/审批/沙箱基础 |
| C1–C8 写成失败测试 | 会把已知漏洞固化为预期，且阻碍 CI |
