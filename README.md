# 企业知识库（Enterprise Knowledge Hub）

大模型驱动的企业级知识管理平台：**RAG 问答 · 智能体 · 共享空间**，开箱即用、数据完全本地化。

![技术栈](https://img.shields.io/badge/Node.js-24+-339933) ![数据库](https://img.shields.io/badge/SQLite-内置-003B57) ![前端](https://img.shields.io/badge/前端-原生JS零构建-07c05f)

## 功能总览

| 模块 | 能力 |
|------|------|
| 知识库 | 文档与问答对统一管理；文件与文件夹批量上传（保留目录结构）、解析进度、失败重试、分块预览、重建知识、批量打包下载、收藏与置顶 |
| 文档解析 | PDF（pdfjs）、Word（mammoth）、Excel、PPT、Markdown / 文本 / HTML / CSV / JSON，问答对直接入库；图片等其余文件存档管理 |
| 检索 | 混合检索：FTS5 trigram 关键词 + 向量余弦加权融合；会话附件自动参与检索 |
| 对话 | SSE 流式输出、思考过程摘要、引用角标与原文片段溯源、快速问答 / 智能推理双模式、⌘K 全局搜索 |
| 智能体 | 组合模型 + 知识库 + 工具 + 系统提示词，一键发起对话 |
| 共享空间 | 多成员协作（Owner / Admin / Contributor / Viewer 四级角色）、邀请码加入、知识库按空间共享 |
| 产物 | 会话附件与文件集中管理、下载 |
| 工具箱 | 网络搜索（Tavily）、MCP / 浏览器自动化占位开关、上传自定义 JS 工具（function calling，智能体对话中自动调用） |
| 系统设置 | 模型管理（OpenAI 兼容，含连接测试）、我的记忆（长期记忆注入对话）、用户信息、成员管理 |
| 其他 | 深浅色主题、侧边栏拖拽、会话自动分组（今天 / 昨天 / 7 天内）、多用户认证（scrypt + 令牌） |

## 快速开始

需要 Node.js ≥ 22.5（内置 `node:sqlite`，推荐 24+），无其他外部依赖。

```bash
npm install
npm start        # 默认 http://localhost:3210，可用 PORT=xxxx 覆盖
```

启动后自动注入演示数据（**仅开发环境**），使用演示账号登录：

```
邮箱：lzy@example.com
密码：password
```

> 生产环境（`NODE_ENV=production`）不会创建演示账号，也不会在启动日志打印凭据。参考 `docs/threat-model.md` G7。

数据全部保存在本地 `data/` 目录（SQLite 数据库 + 上传文件）。**删除该目录会清空账号、知识库与上传文件**；重置前请先备份。

## P0-0 … P0-5：测试、Runtime、任务、知识、工具与成果面

本仓库正在按 `Enterprise-Knowledge-Hub-Agent-P0-Design.md` 分阶段升级为 Agent 任务执行平台。当前完成：

**P0-0 基线与护栏**

- Node 内置 `node:test` 单元/集成测试与 GitHub Actions CI
- PostgreSQL 16 控制面 + 可重复 SQL 迁移（任务/事件/审批/检查点等核心表）
- `AGENT_PLATFORM_ENABLED` 特性开关（默认关闭）
- 生产环境禁用演示数据
- C1–C8 基线复现脚本与安全/数据/保留文档
- 30 条评测任务 + 3 个端到端场景

**P0-1 Runtime 解耦**

- `server/agent/actions.js`：AgentAction 严格解析（plan/call_tool/ask_user/finish/fail）
- `server/agent/context-builder.js`：上下文组装与不可信证据边界；旧聊天提示词逐字兼容
- `server/agent/model-adapter.js`：模型流式/非流式入口与错误分类
- `server/agent/runner.js`：受控“模型 → 工具”循环；旧聊天路径复用同一 Runner
- 修复 G2：会话创建/加载/回显均校验 `agent_id` 归属；跨用户返回 403

**P0-2 任务持久化与 Worker**

- `/api/tasks`：创建、列表、快照、取消、恢复、补充指令、输入；`/api/approvals` 骨架
- PostgreSQL 任务状态机、事件序号连续、租约/心跳/fencing、SKIP LOCKED 领取
- Worker：`npm run worker`；崩溃恢复、重试退避、优雅停机、取消确认
- SSE：`Last-Event-ID` 续传、缺口检测、终端 `end` 事件
- 20 次 `kill -9` 恢复测试（`test/pg/task-kill-recovery.test.js`）
- 特性开关 `AGENT_PLATFORM_ENABLED` 默认关闭，关闭时不连接 PostgreSQL

**P0-3 知识与 Skills**

- `server/knowledge/`：统一 ACL（G1）、SQL 下推的受控混合检索（G10）、文档版本/哈希（G9）
- `KnowledgeService`：`listBases / resolveScope / search / getDocument / getChunk / getCitation / getVersion`
- 文档重解析生成新版本，旧分块保留；删除改为软删除，历史引用仍可回读
- 证据快照写入 PostgreSQL `agent_evidence`，幂等去重；`finish.citations` 必须是本任务证据
- 任务创建时快照知识范围（`input_json.knowledge`）；执行器每次检索重新校验 ACL，最多自动检索两次
- SkillRegistry：`skill.json` + `SKILL.md` + references + evals；内置 `knowledge-research`、`spreadsheet-audit`
- 新 API：`/api/knowledge/*`、`/api/skills`、`GET /api/tasks/:id/evidence`（均受特性开关控制）

**P0-4 工具、审批、沙箱、MCP 与服务身份**

- 任务创建时快照完整工具描述（schema/版本/代码哈希/副作用），执行阶段只认快照并校验漂移
- PolicyEngine 默认拒绝；审批一次性绑定 `tool_call_id + args_hash`，审批暂停/恢复，执行前原子消费
- 自定义工具不可变版本（SQLite v2 `custom_tool_versions`）；代码变化生成新版本
- 自定义工具在独立 Node 子进程沙箱运行；`require/process/fetch/fs` 被阻断，超时/内存/输出受限
- 出站 MCP Streamable HTTP 客户端与连接/工具缓存；入站 `service_principals` 哈希令牌 + KB scope
- `model_profiles` + `credential_ref`：PlatformAdmin 管理，密钥不回显；`base_url` 拒绝私网/元数据地址
- 新 API：`/api/tools/registry`、`/api/mcp/connections`、`/api/model-profiles`、`/api/service-principals`
- 前端「任务」工作台：创建任务、SSE 事件时间线、计划/工具/证据/用量、审批（展示真实调用参数）与输入、取消/恢复/补充指令
- 系统设置新增「Agent 平台」：工具注册表策略、MCP 连接、平台模型、服务主体；入口按 PlatformAdmin / 组织管理员权限显示
- `/api/auth/me` 返回 `is_platform_admin` / `is_admin`，前端据此隐藏无权操作

**P0-5 成果面与基础文件工具**

- 内容寻址 blob（`data/artifacts/blobs/aa/bb/<sha256>`）：原子写、去重、`ref_count`、软删除与 GC
- 成果 API：`GET /api/tasks/:id/artifacts`、下载、`POST /api/tasks/:id/attachments`、`DELETE /api/tasks/:id/artifacts/:artifactId`
- 下载每次重新校验任务 ACL；失败统一 404；`attachment`/`nosniff`/`private, no-store` + 审计 `artifact.download`
- 内置文件工具：`artifact.create`、`document.read/write`、`spreadsheet.read/write`、`archive.read/create`
- ZIP 护栏：路径遍历、绝对路径、符号链接、加密条目、重复名、条目/大小/压缩比上限；只内存解压
- `finish.artifact_refs` 双层校验；带幂等键的写崩溃后可重领，不进入人工对账
- DOCX 最小 OOXML 写入；PDF/DOCX/XLSX/PPTX 文本读取复用统一解析与限额
- 前端任务详情新增「成果」卡：列表、下载、上传附件、删除；新建任务可选附件
- 关闭 S-09（成果路径遍历与未授权下载）；`spreadsheet-audit` 升至 1.1.0 并可选

```bash
npm test                 # 单元 + 集成（临时 SQLite，无需 Docker）
npm run db:up            # 启动专用 PostgreSQL（127.0.0.1:55432）
export DATABASE_URL='postgres://ekh:ekh_dev_password@127.0.0.1:55432/ekh'
npm run db:migrate       # 再执行一次应为幂等
npm run test:pg          # 需 DATABASE_URL 指向 *_test 数据库（含 kill 恢复测试）
npm run worker           # 另开终端：领取 Agent 任务（需 AGENT_PLATFORM_ENABLED=1）
npm run artifacts:gc -- --dry-run   # 成果 blob GC 演练
npm run repro:baseline   # 生成当前行为快照（会覆盖 docs/baseline）
```

P0-2 起的任务执行还需要 `EKH_AGENT_MODEL_BASE_URL` / `EKH_AGENT_MODEL_NAME`（及可选 `EKH_AGENT_MODEL_API_KEY`），或在预设中配置 `model_profile_id`。平台管理员通过 `PLATFORM_ADMIN_EMAILS` 指定。

> Web 与 Worker 必须共享同一个 `EKH_DATA_DIR`（SQLite 知识面 + `artifacts/` 成果 blob）。首次对现有 `data/app.db` 运行新代码前请先备份；SQLite 迁移只增列/表，但备份是回滚前提。

详细步骤见 `docs/p0/runbook.md`；决策见 `docs/adr/0001-p0-baseline-decisions.md`、`0002-p0-1-runtime-decoupling.md`、`0003-p0-2-task-persistence.md`、`0004-p0-3-knowledge-and-skills.md`、`0005-p0-4-tools-approvals-sandbox-mcp.md`、`0006-p0-5-artifacts-file-tools.md`。


## 配置模型

应用开箱即用：**未配置模型时**，对话以抽取方式直接返回检索到的知识片段（含引用），检索、知识库、智能体等功能均可正常使用。

在「系统设置 → 模型管理」添加 OpenAI 兼容接口后即可获得完整生成式回答：

| 类型 | 用途 | 示例 |
|------|------|------|
| 对话模型 | RAG 问答、智能体、生成推荐问题 | `https://api.deepseek.com/v1` + `deepseek-chat` |
| Embedding 模型 | 文档向量化 + 向量检索（不配则仅关键词通道） | `https://dashscope.aliyuncs.com/compatible-mode/v1` + `text-embedding-v3` |
| Rerank 模型 | 检索结果重排 | 本地 / 云端 Rerank 服务 |

支持 DeepSeek、Qwen（百炼）、智谱、OpenAI、Ollama、vLLM 等任何 OpenAI 兼容服务；本地 Ollama 填 `http://localhost:11434/v1` 即可。

## 架构

```
├── server/                后端（Node.js + Express + node:sqlite）
│   ├── index.js           进程入口：seed + 监听端口
│   ├── app.js             Express 应用工厂（测试可导入，不 listen）
│   ├── config.js          环境变量与特性开关
│   ├── bootstrap.js       演示数据门禁（生产禁用）
│   ├── db.js              SQLite 初始化、建表、种子
│   ├── auth.js            注册 / 登录 / 令牌认证中间件
│   ├── parse.js           多格式文本抽取 + 分块
│   ├── ingest.js          解析 → 分块 → 向量化摄取管线（版本化）
│   ├── search.js          兼容导出：混合检索（实现位于 knowledge/retrieval.js）
│   ├── sqlite-migrations.js SQLite PRAGMA user_version 迁移（P0-3）
│   ├── knowledge/         ACL、受控检索、KnowledgeService、版本与引用
│   ├── skills/            Skill manifest 校验、Registry、密钥扫描
│   ├── llm.js             OpenAI 兼容客户端（流式对话 / Embeddings）
│   ├── custom-tools.js    自定义工具：上传 JS 的沙箱解析与执行
│   ├── control/           PostgreSQL 控制面（任务/证据/审计/预设/Skill 仓储）
│   ├── seed-demo.js       演示数据
│   └── routes/            kbs、chat、agents、orgs、misc、tasks、knowledge、skills
├── skills/                内置 Skill（manifest/instructions/references/evals）
├── migrations/            控制面 SQL 迁移（P0-0 起，P0-3 为 0003）
├── test/                  node:test 单元、集成、PostgreSQL 测试
├── scripts/               迁移 CLI、C1–C8 基线复现
├── docs/                  威胁模型、数据分类、保留策略、ADR、Runbook、基线报告
├── evals/                 30 条评测任务与 3 个 E2E 场景（P0-0 定义）
├── public/                前端（原生 HTML/CSS/JS，无构建步骤）
│   ├── index.html         应用骨架
│   ├── styles.css         主题变量 + 全部样式（源自 WeKnora 主题）
│   └── app.js             视图渲染、SSE 客户端、极简 Markdown 渲染
├── prototype.html         最初的 UI 设计原型（留档）
├── docker-compose.yml     控制面 PostgreSQL（端口 55432）
└── data/                  运行时数据（自动创建，勿提交）
```

### 关键设计

- **混合检索**：查询拆成滑动 trigram 做 FTS5 OR 匹配，以 bm25 归一化为关键词分；配置 Embedding 模型后与向量余弦按 0.45 / 0.55 加权融合。范围、删除、版本条件全部下推到 SQL，候选默认上限 5000，topK 上限 20。未选中知识库时默认检索全部可见知识库。
- **知识 ACL**：知识库按「所有者 / 空间角色」判定可见性；聊天、Agent、任务范围都调用同一 `intersectVisibleKbIds`，历史越权绑定不会泄露。
- **版本与引用**：重解析生成 `document_version`，旧分块保留；证据快照记录版本、哈希与 locator，引用不随文档更新漂移。
- **Skill**：平台级 JSON manifest，内容哈希固定版本；同版本内容变化必须升版本。P0-3 只提供 `knowledge.*` 能力，`spreadsheet-audit` 可查看但不可选。
- **摄取管线**：上传后台异步处理（解析 → 段落聚合分块约 520 字符带重叠 → 向量化），文档状态 `pending / processing / ready / failed`，前端轮询刷新，失败可一键重建。
- **SSE 对话**：`POST /api/sessions/:id/chat` 返回事件流（`meta` 引用与思考摘要 → `delta` 增量 → `done` 落库消息），客户端断开自动中止上游生成。
- **权限模型**：知识库按「所有者 / 空间角色」判定可见性与写权限；Viewer 只读、Contributor 可上传、Admin/Owner 可管理、仅创建者可删除。
- **未信任数据**：检索到的知识片段仅作为上下文注入提示词，不改变权限或业务状态。

## API 一览（节选）

```
POST /api/auth/register|login|logout      GET|PUT /api/auth/me
GET|POST /api/kbs                         PUT|DELETE /api/kbs/:id
POST /api/kbs/:id/favorite                GET /api/kbs/:id/documents
POST /api/kbs/:id/documents（multipart）  POST /api/kbs/:id/qa
GET /api/documents/:id                    POST /api/documents/:id/reparse
POST /api/kbs/:id/batch-download
GET|POST /api/sessions                    GET /api/sessions/:id（含消息）
POST /api/sessions/:id/chat（SSE）        POST /api/sessions/:id/attachments
GET|POST|PUT|DELETE /api/agents
GET|POST /api/orgs                        POST /api/orgs/join
GET|POST /api/models                      POST /api/models/test
GET|POST /api/artifacts                   GET|PUT /api/tools
GET|POST /api/memories                    GET /api/search?q=（⌘K）
POST /api/tasks                           GET /api/tasks/:id
GET /api/tasks/:id/events（SSE）          GET /api/tasks/:id/evidence
GET|POST /api/tasks/:id/messages          GET /api/approvals?status=pending
POST /api/approvals/:id/decision          GET /api/tools/registry
PATCH /api/tools/registry/:name/policy    GET|POST /api/mcp/connections
GET /api/model-profiles                   GET|POST /api/service-principals
POST /api/knowledge/search                GET /api/knowledge/bases
GET /api/knowledge/documents/:id          GET /api/knowledge/citations/:id
GET /api/knowledge/versions/:id           GET /api/skills
POST /api/skills/reload（PlatformAdmin）
```

## 参考与致谢

- UI 设计与主题变量参考 [WeKnora](https://github.com/Tencent/WeKnora)（腾讯开源知识库框架），产品概念（知识库 / 会话 / 混合检索 / 引用溯源）亦受其启发；本项目为独立实现。
- 依赖：express、multer、pdfjs-dist、mammoth、xlsx、adm-zip、pg（控制面）。
- 设计文档：`Enterprise-Knowledge-Hub-Agent-P0-Design.md`（P0-0…P0-6 分阶段规划）。
