# P0 运行手册（P0-0 … P0-4）

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

## 8. 知识范围、证据与 Skill（P0-3）

### 8.1 首次运行前备份

首次让 P0-3 代码接触既有 `data/app.db` 前先备份：

```bash
mkdir -p backups
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('data/app.db'); db.exec(\"VACUUM INTO 'backups/app-before-p03.db'\")"
```

SQLite 迁移只增列/表并回填（`PRAGMA user_version`），但备份是回滚前提。Web 与 Worker 必须共享同一个 `EKH_DATA_DIR`。

### 8.2 创建带范围与 Skill 的任务

```bash
curl -s -X POST http://localhost:3210/api/tasks \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "goal":"根据制度回答差旅标准并给出引用",
    "preset_id":"<可选>",
    "kb_scope":{"mode":"explicit","kb_ids":["<kb-id>"],"version_policy":"pin_on_first_use"},
    "skill":"knowledge-research"
  }'
```

- `mode`：`visible`（全部可见）/ `explicit`（指定 KB，越权 403）/ `preset`（预设允许 ∩ 可见）/ `none`。
- 未指定 `kb_scope` 且预设含 `default_kb_ids` 时按预设；否则按全部可见 KB。
- 范围在创建时写入 `input_json.knowledge`；Worker 只认快照。
- 预设缩减会写 `policy.scope_reduced`，事件只含数量，不含不可见 KB ID。

### 8.3 证据与引用

```bash
curl -s http://localhost:3210/api/tasks/<task_id>/evidence -H "Authorization: Bearer $TOKEN"
curl -s http://localhost:3210/api/knowledge/citations/<evidence_id> -H "Authorization: Bearer $TOKEN"
```

- `agent_evidence` 按 `(tenant_id, task_id, chunk_id, content_hash)` 去重，kill -9/重试不会重复。
- `finish.citations` 必须是本任务 `agent_evidence.id`；未知 ID 返回 `model_invalid_output`，任务不会进入 `completed`。
- 文档更新/软删除后，旧证据仍返回旧 `document_version` 与 `content_hash`；`superseded` / `document_deleted` 标记当前状态。

### 8.4 Skill

```bash
curl -s http://localhost:3210/api/skills -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://localhost:3210/api/skills/reload \
  -H "Authorization: Bearer $TOKEN"   # 需 PLATFORM_ADMIN_EMAILS
```

- Skill 目录：`skills/<name>/{skill.json,SKILL.md,references/*.md,evals/cases.json}`。
- 同 name/version 内容变化但未升版本 → reload 拒绝该 Skill，保留旧行。
- `spreadsheet-audit` 依赖 `file.read/spreadsheet.read`，P0-3 可列出但不可选。
- 启动时 Web 进程在 `AGENT_PLATFORM_ENABLED=1` 且配置 `DATABASE_URL` 后异步 reload。

### 8.5 配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `EKH_KNOWLEDGE_CANDIDATE_LIMIT` | `5000` | 检索候选上限 |
| `EKH_KNOWLEDGE_CANDIDATE_CAP` | 同上（兼容） | 候选上限别名 |
| `EKH_KNOWLEDGE_TOP_K_MAX` | `20` | 单次返回上限 |
| `EKH_KNOWLEDGE_FTS_LIMIT` | `80` | FTS 命中上限 |
| `EKH_KNOWLEDGE_EXCERPT_CHARS` | `2000` | 引用摘录上限 |
| `EKH_KNOWLEDGE_EVIDENCE_MAX` | `8` | 注入任务的证据条数 |
| `EKH_SKILLS_DIR` | `<repo>/skills` | Skill 根目录 |
| `EKH_SKILL_INSTRUCTION_MAX_CHARS` | `8000` | SKILL.md 上限（超出拒绝加载） |
| `EKH_SERVICE_KB_SCOPE` | 空 | 服务令牌可访问的 KB，逗号分隔 |

## 9. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3210` | HTTP 端口 |
| `NODE_ENV` | `development` | `production` 禁用演示数据 |
| `DATABASE_URL` | 空 | 控制面 PostgreSQL |
| `EKH_DATA_DIR` | `<repo>/data` | SQLite 与上传目录覆盖 |
| `AGENT_PLATFORM_ENABLED` | `0` | 启用 `/api/tasks` 与 `/api/approvals`（P0-2） |
| `EKH_ENABLE_DEMO_SEED` | `1` | 非生产环境是否初始化演示数据；生产忽略 |
| `EKH_SERVICE_TOKEN` | 空 | MCP/检索服务令牌；为空时在 `data/service-token` 生成 |
| `PLATFORM_ADMIN_EMAILS` | 空 | 平台管理员邮箱（Skill reload、模型/MCP/服务主体/内置工具管理） |
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

## 10. 工具、审批、沙箱、MCP 与服务身份（P0-4）

### 工具快照与审批

创建任务时用 `tools` 固定工具清单（不传则默认 4 个只读 `knowledge.*`）：

```bash
curl -s -X POST http://localhost:3210/api/tasks \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"goal":"计算 1+2","tools":["custom:<tool_id>"]}'
```

自定义工具与高风险副作用（`code_exec/external_send/write_business/destructive`）会进入 `waiting_approval`。审批必须由任务所有者/管理员完成，并提交快照中的 `args_hash`；批准后 Worker 只执行一次。

```bash
curl -s http://localhost:3210/api/tasks/<task_id> -H "Authorization: Bearer $TOKEN"   # pending.approval
curl -s -X POST http://localhost:3210/api/approvals/<approval_id>/decision \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"decision":"approve","args_hash":"<snapshot args_hash>"}'
```

前端路径：侧边栏「任务」→ 新建任务 → 打开任务详情。待审批卡片展示工具名、副作用、真实调用参数（`agent_tool_calls.args_json`）、参数哈希与过期时间；批准/拒绝后任务重新入队或取消。事件时间线通过 SSE 实时更新；右侧显示计划、工具快照、证据与用量。系统设置 →「Agent 平台」提供工具注册表策略、MCP 连接、平台模型与服务主体（按管理员权限显示）。注意：任务需要另开终端运行 `npm run worker` 才会被执行。

### 沙箱

| 变量 | 默认 | 说明 |
|---|---|---|
| `EKH_TOOL_SANDBOX_MODE` | `process` | `process` / `required` / `off`；生产建议 `required` |
| `EKH_TOOL_TIMEOUT_MS` | `15000` | 子进程执行超时 |
| `EKH_TOOL_MAX_OUTPUT_CHARS` | `8000` | 回传模型的结果上限 |
| `EKH_TOOL_SANDBOX_MEMORY_MB` | `256` | 子进程堆上限 |
| `EKH_TOOL_APPROVAL_TTL_MS` | `86400000` | 普通审批有效期 |
| `EKH_TOOL_HIGH_RISK_APPROVAL_TTL_MS` | `3600000` | 高风险审批有效期 |
| `EKH_TOOL_CATALOG_MAX_CHARS` | `12000` | 工具目录注入系统提示词上限 |
| `EKH_TOOL_MAX_PER_TASK` | `20` | 任务快照工具数量上限 |
| `EKH_MCP_CLIENT_TIMEOUT_MS` | `15000` | 出站 MCP 超时 |
| `EKH_MODEL_SECRET_DIR` | 空 | `file:` 凭证根目录，必须在其中 |
| `EKH_SERVICE_LEGACY_TOKEN_ENABLED` | `1` | 是否兼容旧全局服务令牌；生产建议 `0` |

沙箱只使用 Node 权限模型阻断文件读取；网络命名空间/容器隔离留 P0-6，不要把自定义工具当作强隔离边界。

### MCP、模型 profile、服务主体

- `POST /api/mcp/connections`：Streamable HTTP 连接；`credential_ref` 只存引用，刷新后写入工具缓存与注册表。
- `POST /api/model-profiles`：PlatformAdmin；`credential_ref` 支持 `env:NAME` / `file:<相对路径>`；`base_url` 拒绝私网与元数据地址。
- `POST /api/service-principals`：返回明文 token **仅一次**；`scopes` 形如 `{"kb_ids":["kb-a"],"tools":["search_knowledge"]}`；`DELETE` 吊销，`/rotate` 轮换。

## 11. 成果面与文件工具（P0-5）

### 目录与权限

成果存储在 `$EKH_DATA_DIR/artifacts/`：

```text
artifacts/
├── blobs/<aa>/<bb>/<sha256>   # 内容寻址，去重；0700 目录 / 0600 文件
├── tmp/                       # 写入临时文件（fsync 后 rename）
└── quarantine/                # 无数据库记录的孤儿文件
```

Web 与 Worker 必须共享同一个 `EKH_DATA_DIR`；不要把 `data/artifacts` 挂成静态目录，下载只能走 API。

### 任务中使用文件工具

默认任务仍快照 4 个只读知识工具。需要写文件时，在创建任务的 `tools` 中显式加入：

```json
{"goal": "汇总附件并生成交付包", "tools": ["document.read", "spreadsheet.read", "archive.create", "archive.read"]}
```

可用工具：`artifact.create`、`document.read/write`、`spreadsheet.read/write`、`archive.read/create`。写工具为 `write_workspace`（medium，默认不审批）；任务 `approval_mode=always` 时仍会暂停审批。模型每轮会收到当前任务成果目录（ID/名称/版本/大小，不含内容）；`finish.artifact_refs` 只能引用本任务成果。

### HTTP API

```bash
# 上传附件（仅 owner 或同租户 admin；终态任务 409）
curl -s -X POST "http://localhost:3210/api/tasks/<task_id>/attachments" \
  -H "Authorization: Bearer $TOKEN" -F "file=@./输入说明.md"

# 列表（不含 storage_key/磁盘路径）
curl -s "http://localhost:3210/api/tasks/<task_id>/artifacts" -H "Authorization: Bearer $TOKEN"

# 下载：每次重新校验任务 ACL；失败统一 404
curl -s -OJ "http://localhost:3210/api/tasks/<task_id>/artifacts/<artifact_id>/download" \
  -H "Authorization: Bearer $TOKEN"

# 软删除：立即停止下载；blob 由 GC 在宽限期后清理
curl -s -X DELETE "http://localhost:3210/api/tasks/<task_id>/artifacts/<artifact_id>" \
  -H "Authorization: Bearer $TOKEN"
```

前端路径：任务详情右侧「成果」卡可列表、下载、上传附件、删除；新建任务对话框可选择附件并在创建后自动上传（Worker 可能已开始执行，建议创建后尽快上传）。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `EKH_ARTIFACT_MAX_BYTES` | `26214400` | 单个成果上限（25 MiB） |
| `EKH_ARTIFACT_MAX_TASK_BYTES` | `104857600` | 单任务成果总量（100 MiB） |
| `EKH_ARTIFACT_MAX_PER_TASK` | `100` | 单任务成果数量 |
| `EKH_ARTIFACT_UPLOAD_MAX_BYTES` | `26214400` | 单次上传上限（25 MiB） |
| `EKH_ARTIFACT_GC_GRACE_MS` | `86400000` | 软删除后 GC 宽限期 |
| `EKH_FILE_MAX_READ_CHARS` | `6000` | `document.read` 单次返回字符数 |
| `EKH_FILE_EXTRACT_MAX_CHARS` | `200000` | 文本抽取总字符上限 |
| `EKH_ZIP_MAX_ENTRIES` | `200` | ZIP 条目数上限 |
| `EKH_ZIP_MAX_ENTRY_BYTES` | `10485760` | 单条解压上限 |
| `EKH_ZIP_MAX_TOTAL_BYTES` | `41943040` | 总解压上限 |
| `EKH_ZIP_MAX_RATIO` | `100` | 压缩比上限 |
| `EKH_SHEET_MAX_ROWS` / `EKH_SHEET_MAX_COLS` | `5000` / `100` | 表格读取上限 |

### GC 与备份

```bash
npm run artifacts:gc -- --dry-run          # 只统计
npm run artifacts:gc                       # 按宽限期清理无引用 blob
npm run artifacts:gc -- --grace-ms=0       # 立即清理（仅测试/维护）
```

- GC 以数据库引用为准：先锁 blob，清理超过宽限期的软删除行；仍有引用则跳过；删除行后再删文件。
- 孤儿文件（无数据库记录）进入 `quarantine/`，不会自动删除，便于人工核对。
- 备份：除 PostgreSQL 外，必须同时备份 `data/artifacts`；恢复时保持目录与数据库一致。
- 删除是软删除；下载/列表立即不可见。法律保留优先于 GC。

## 12. CI

`.github/workflows/ci.yml`：

1. `sqlite-tests`：Node 24 + `npm ci` + `npm test`
2. `postgres-tests`：PostgreSQL 16 service + 两次 `db:migrate` + `test:pg`

基线脚本不作为门禁。

## 13. 常见问题

| 问题 | 处理 |
|---|---|
| `DATABASE_URL 未配置` | 启动容器并导出 `DATABASE_URL` |
| 任务一直 `queued` | 没有运行 Worker，或 `AGENT_PLATFORM_ENABLED=0` 时未创建任务 |
| Worker 报 `model_unavailable` | 未配置 `EKH_AGENT_MODEL_BASE_URL/NAME` |
| Worker 报 `knowledge_unavailable` | 带知识范围的任务没有注入知识服务；检查 Worker 版本与 Web 是否共享 `EKH_DATA_DIR` |
| Skill 未出现在列表 | 未设置 `AGENT_PLATFORM_ENABLED=1`/`DATABASE_URL`，或 reload 报错；查看 `[skills]` 日志 |
| 端口 55432 被占用 | 修改 `docker-compose.yml` 端口映射，并同步 `DATABASE_URL` |
| 迁移校验和不一致 | 已执行迁移被改写；恢复原文件或人工核对后处理，不要直接删记录 |
| `test:pg` 全部 skipped | `DATABASE_URL` 缺失或数据库名不以 `_test` 结尾（安全护栏） |
| 成果下载 404 | 任务不属于当前用户/租户、artifact 已软删除，或 blob 文件缺失；查 `audit_log` 的 `artifact.download` |
| Worker 写入成果报 `artifact_storage_invalid` | Web 与 Worker 的 `EKH_DATA_DIR` 不一致，或 `data/artifacts` 被清理；两者必须共享同一目录 |
| 上传返回 400 `artifact_type_mismatch` | 扩展名与 magic bytes 不符；上传前不要改扩展名 |
| 测试残留临时目录 | 正常会自动清理；异常退出可清理 `/tmp/ekh-*` |
| 生产启动没有演示账号 | 预期行为（G7） |
