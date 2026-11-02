# P0 运行手册（P0-0 … P0-2）

## 1. 前置条件

- Node.js 24（见 `.nvmrc`），npm 11+
- Docker 与 Docker Compose（仅控制面迁移/测试需要）
- 本机 `data/` 是开发数据，**不要删除**；测试与基线脚本使用 `/tmp` 独立目录

## 2. 安装与启动旧应用

```bash
npm install
npm start            # http://localhost:3210，开发模式会初始化演示数据
```

演示账号只在非生产环境创建；生产模式（`NODE_ENV=production`）不会创建、也不会打印演示账号。

## 3. 启动控制面 PostgreSQL

```bash
npm run db:up        # 等价于 docker compose up -d postgres
docker compose ps    # ekh-postgres 应为 healthy，端口 127.0.0.1:55432
```

首次初始化会自动创建 `ekh` 与 `ekh_test` 两个数据库。数据在命名卷 `ekh-pgdata` 中。

> `docker compose down -v` 会删除该卷，导致控制面数据丢失；只允许在确认后执行。

## 4. 迁移

```bash
export DATABASE_URL='postgres://ekh:ekh_dev_password@127.0.0.1:55432/ekh'

npm run db:status        # 查看已执行/待执行
npm run db:migrate:dry   # 只读预览
npm run db:migrate       # 执行
npm run db:migrate       # 再执行应为幂等（跳过）
```

迁移规则：

- 只允许向前追加新文件，不改写已执行的迁移。
- 每个文件在独立事务中执行；不要写 `BEGIN/COMMIT`。
- 已执行文件的校验和变化会被拒绝。

## 5. 测试

```bash
npm test          # unit + integration，使用临时 SQLite，不需要 Docker
npm run test:pg   # PostgreSQL 迁移/结构 + 任务运行时/API/kill 恢复测试
```

`test:pg` 需要 `DATABASE_URL` 指向名称以 `_test` 结尾的数据库，否则自动 skip：

```bash
export DATABASE_URL='postgres://ekh:ekh_dev_password@127.0.0.1:55432/ekh_test'
npm run test:pg
```

测试数据隔离：每个测试文件使用 `mkdtemp` 创建的 `EKH_DATA_DIR`，结束后删除；不会触碰仓库 `data/`。

## 6. C1–C8 基线

```bash
npm run repro:baseline
```

输出：

- `docs/baseline/c1-c8.json`
- `docs/baseline/c1-c8.md`

脚本只在临时目录创建两个用户、知识库、Agent 和工具；不会读写仓库 `data/`，也不会访问生产数据库。结果状态：`reproduced` / `safe` / `static_evidence` / `not_reproduced`。

> 已提交的 `docs/baseline/c1-c8.{json,md}` 是 **P0-0 冻结快照**。脚本记录的是“当前代码行为”，直接重跑会覆盖快照。P0-1 修复 G2 后，C2 会变为 `not_reproduced`（预期结果，不是回归）；如需保留历史，请先复制旧文件或人工确认后再提交。

## 7. Agent 任务 API 与 Worker（P0-2）

任务 API 默认关闭；启用后需要至少一个 Worker 进程。

```bash
export AGENT_PLATFORM_ENABLED=1
export EKH_AGENT_MODEL_BASE_URL='https://api.example.com/v1'
export EKH_AGENT_MODEL_NAME='your-model'
export EKH_AGENT_MODEL_API_KEY='...'

npm start            # Web/API
npm run worker       # 持续领取任务（另开终端）
```

其他 Worker 模式：

```bash
npm run worker:once  # 领取并执行一个任务后退出
npm run worker:reap  # 只回收：过期租约、退避到期、取消确认、审批/输入超时
```

任务示例：

```bash
TOKEN='<登录令牌>'
curl -s -X POST http://localhost:3210/api/tasks \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"goal":"审查员工手册并输出结论"}'

curl -s http://localhost:3210/api/tasks/<task_id> -H "Authorization: Bearer $TOKEN"
# SSE（必须用 Bearer 头，不接受 query token）
curl -N http://localhost:3210/api/tasks/<task_id>/events \
  -H "Authorization: Bearer $TOKEN" -H 'Last-Event-ID: 0'
```

说明：

- 任务状态：`queued → running → completed/failed/cancelled`；人工介入为 `waiting_approval` / `waiting_input`；可重试错误进入 `retry_wait`。
- 关闭浏览器/断开 SSE 不影响 Worker；重连用 `Last-Event-ID` 续传，缺口时 `event: gap`，应重新拉取快照。
- P0-2 的 Agent 只支持 `plan` / `finish` / `fail` / `ask_user`；工具调用在 P0-4 接入前会以 `tool_unavailable` 失败。
- Worker 崩溃后由 Reaper 回收；`kill -9` 恢复测试：`EKH_KILL_ITERATIONS=20 npm run test:pg`。

## 8. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3210` | HTTP 端口 |
| `NODE_ENV` | `development` | `production` 禁用演示数据 |
| `DATABASE_URL` | 空 | 控制面 PostgreSQL |
| `EKH_DATA_DIR` | `<repo>/data` | SQLite 与上传目录覆盖 |
| `AGENT_PLATFORM_ENABLED` | `0` | 启用 `/api/tasks` 与 `/api/approvals`（P0-2） |
| `EKH_ENABLE_DEMO_SEED` | `1` | 非生产环境是否初始化演示数据；生产忽略 |
| `EKH_SERVICE_TOKEN` | 空 | MCP/检索服务令牌；为空时在 `data/service-token` 生成 |
| `PLATFORM_ADMIN_EMAILS` | 空 | 平台管理员邮箱（P0-4 起使用） |
| `EKH_AGENT_MODEL_BASE_URL` | 空 | Worker 使用的 OpenAI 兼容地址 |
| `EKH_AGENT_MODEL_NAME` | 空 | Worker 模型 ID |
| `EKH_AGENT_MODEL_API_KEY` | 空 | Worker 模型密钥（仅环境变量，不入库） |
| `EKH_WORKER_ID` | 自动 | Worker 标识 |
| `EKH_WORKER_LEASE_TTL_MS` | `60000` | 任务租约时长 |
| `EKH_WORKER_HEARTBEAT_MS` | `20000` | 心跳间隔 |
| `EKH_WORKER_REAPER_MS` | `15000` | 回收扫描间隔 |
| `EKH_WORKER_POLL_MS` | `1000` | 空队列轮询间隔 |
| `EKH_TASK_RETRY_BASE_MS` | `5000` | 重试退避基数 |
| `EKH_WORKER_SHUTDOWN_GRACE_MS` | `10000` | 优雅停机等待上限 |
| `TAVILY_API_KEY` | 空 | 网络搜索工具 |

`.env` 不会被自动加载；可使用 `node --env-file=.env server/index.js`，或直接导出环境变量。

## 9. CI

`.github/workflows/ci.yml`：

1. `sqlite-tests`：Node 24 + `npm ci` + `npm test`
2. `postgres-tests`：PostgreSQL 16 service + 两次 `db:migrate` + `test:pg`

基线脚本不作为门禁。

## 10. 常见问题

| 问题 | 处理 |
|---|---|
| `DATABASE_URL 未配置` | 启动容器并导出 `DATABASE_URL` |
| 任务一直 `queued` | 没有运行 Worker，或 `AGENT_PLATFORM_ENABLED=0` 时未创建任务 |
| Worker 报 `model_unavailable` | 未配置 `EKH_AGENT_MODEL_BASE_URL/NAME` |
| 端口 55432 被占用 | 修改 `docker-compose.yml` 端口映射，并同步 `DATABASE_URL` |
| 迁移校验和不一致 | 已执行迁移被改写；恢复原文件或人工核对后处理，不要直接删记录 |
| `test:pg` 全部 skipped | `DATABASE_URL` 缺失或数据库名不以 `_test` 结尾（安全护栏） |
| 测试残留临时目录 | 正常会自动清理；异常退出可清理 `/tmp/ekh-*` |
| 生产启动没有演示账号 | 预期行为（G7） |
