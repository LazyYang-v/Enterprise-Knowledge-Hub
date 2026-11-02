# ADR-0005：P0-4 工具、审批、沙箱、MCP 与服务身份

- 状态：已接受
- 日期：2026-11-02
- 关联：`Enterprise-Knowledge-Hub-Agent-P0-Design.md` §5.11、§7、§9.4、§16.3；ADR-0002、ADR-0003、ADR-0004

## 背景

P0-1 … P0-3 完成了 Runtime 解耦、任务持久化与知识/证据/ Skill。P0-4 前的缺口：

- 任务 `call_tool` 一律 `tool_unavailable`；没有统一工具契约、策略与审计。
- 自定义工具仅用进程内 `node:vm`，并注入宿主 `fetch`；归属只在部分路由校验。
- 模型管理无平台管理员限制，API Key 明文存 SQLite。
- MCP 入站使用单一全局服务令牌；出站无客户端。
- 高风险动作没有一次性审批，无法暂停/恢复。

## 决策

1. **任务创建时快照完整工具描述**：`input_json.tools` 保存名称、版本、`schema_hash`、`code_hash`、来源、schema、副作用、审批策略、超时、幂等、范围与沙箱 profile。Worker 只认快照；无快照任务不加载工具运行时。
2. **默认工具**：未指定时快照 4 个只读 `knowledge.*` 工具；请求体 `tools` 最多 20 项，支持内置与 `custom:<id>` / `mcp.*`。
3. **统一工具契约**：`server/tools/contract.js` 定义命名、版本、枚举、canonical JSON 与稳定哈希。`canonicalJson` 拒绝循环、非有限数字与非纯 JSON；`args_hash` 不依赖键顺序。
4. **JSON Schema 子集**：`server/tools/schema.js` 支持 object/array/标量、required/properties/additionalProperties、enum/const、anyOf/oneOf、长度/数值/数量限制；拒绝 `$ref`、`$defs`、`allOf`、`patternProperties`、未知关键字与超过 8 层嵌套。
5. **执行流水线**：严格解析 Action → 快照存在 → 当前注册表/版本/哈希 → schema → args_hash → PolicyEngine → 持久化 `agent_tool_calls` → attempt → 执行 → 归一化 → 事件 + 工具消息。没有持久化调用不执行；没有 allow/approval 不执行。
6. **策略默认拒绝**：快照缺失、注册表缺失/停用、版本或哈希漂移、自定义工具非 owner、policy 禁用、scope 不允许、单任务次数超限、预算耗尽均拒绝。普通拒绝作为工具结果回传模型；预算耗尽直接 `failed/budget_exhausted`。
7. **策略优先级**：user > role > preset > tenant；`enabled=false` 拒绝。审批模式：`always`；`risk_based` + `write_business/external_send/destructive/code_exec`；任务 `approval_mode=always`。`never` 不得降级高风险副作用。
8. **一次性审批绑定参数**：`agent_approvals` 绑定 `tool_call_id + args_hash`；`decideApproval` 校验参数哈希、禁止自批、校验过期。Worker 恢复时在同一事务内 `FOR UPDATE` + 原子 `consume` 后执行一次；拒绝/过期绝不执行（批准后在恢复前过期同样不执行）。对账审批只标记 `reconciled`。
9. **子进程沙箱**：自定义工具的 `define` 与 `execute` 都在独立 Node 子进程运行；vm context 不注入任何宿主函数，`require/process/fetch/fs/child_process` 等以 stub 抛 `sandbox_violation`；禁用 `eval`/WASM 代码生成；父进程 15s 超时、SIGKILL 进程组、256MB 堆、512KB stdout、8KB 模型上下文结果。
10. **Node 权限模型**：默认 `EKH_TOOL_SANDBOX_MODE=process`，在支持时使用 `--permission --allow-fs-read=<worker>`；`required` 在无权限能力时拒绝执行；`off` 仅用于受控开发。**残留风险**：vm 逃逸后仍可能触达 Node 内置网络能力，OS 级网络命名空间/容器沙箱留 P0-6。
11. **自定义工具不可变版本**：SQLite v2 新增 `custom_tool_versions` 与 `custom_tools.current_version/code_hash/deleted_at`；上传/改代码生成新版本，旧版本保留。任务快照固定版本与代码哈希；代码变化不影响运行中任务，同一版本内容变化拒绝覆盖。
12. **出站 MCP 仅 Streamable HTTP**：连接配置存 `mcp_connections`，凭证只存 `credential_ref`；发现工具写 `mcp_tool_cache` 与 `tool_registry`。工具描述与结果一律不可信；允许/拒绝列表在调用前校验；schema 变化使旧任务因 hash 不匹配失败。stdio 默认关闭。
13. **入站服务身份**：`service_principals` 只存 SHA-256 token_hash；校验吊销与过期并更新 `last_used_at`。KB scope 白名单默认拒绝；`/api/retrieve` 与 `/mcp` 使用 principal。旧 `EKH_SERVICE_TOKEN` 仅作显式兼容 principal（`EKH_SERVICE_LEGACY_TOKEN_ENABLED=1`），生产建议关闭。
14. **模型 profile 与凭证引用**：PG `model_profiles`（PlatformAdmin CRUD），`credential_ref` 仅支持 `env:NAME` 与 `file:<EKH_MODEL_SECRET_DIR 下相对路径>`；API 只返回 `credential_configured`，不回显引用值或密钥。`base_url` 只允许 http/https 且拒绝本机/私网/元数据地址。Worker 按 preset `model_profile_id` 解析，缺失时回退环境变量。
15. **审计与 ResultVerifier**：策略拒绝、审批、工具执行摘要、自定义工具/模型/MCP/服务主体管理操作写 `audit_log`，只含 ID、工具名、args_hash、决策。`finish` 前检查未终态工具调用、待审批、输出密钥扫描；沙箱违规直接失败任务。
16. **API 命名偏差**：旧应用占用 `GET /api/tools`，新注册表使用 `GET /api/tools/registry`、`GET /api/tools/registry/:name`、`PATCH /api/tools/registry/:name/policy`，避免破坏旧前端。
17. **Reaper 恢复**：读调用与有幂等键的写可直接失败/重试；无幂等键的外部写置 `unknown` 并创建对账审批，禁止盲目重放。
18. **领取级 fencing**：所有 Worker 写入同时校验 `lease_owner + lease_epoch + lease_expires_at > now()`；`finishStep` 还要求 Step 属于给定任务。`finishToolAttempt` / `finishToolCall` 进一步绑定 `attempt_id + worker_id + lease_epoch`，失去租约的旧 Worker 不能把工具调用标记为成功。
19. **前端任务工作台**：侧边栏「任务」使用 `/api/tasks`、SSE 事件与 `/api/approvals`；审批卡展示 `agent_tool_calls.args_json`（仅任务所有者/管理员可见）、`args_hash` 与过期时间。系统设置「Agent 平台」按 `is_admin` / `is_platform_admin` 显示工具注册表策略、MCP、平台模型与服务主体；`/api/auth/me` 返回这两个标志。任务消息通过新增的 `GET /api/tasks/:id/messages` 读取。

## 兼容与回滚

- 旧聊天、旧 `/api/retrieve`、旧 `/api/tools` 响应结构保持不变。
- `AGENT_PLATFORM_ENABLED=0` 时新增管理路由返回 404；旧任务无工具快照时不加载工具运行时。
- PG 0004 只加列/索引；SQLite v2 只加表/列并回填。回滚到 P0-3 代码时新表/列可被忽略。
- 审批/工具事件全部走 `appendEvent`，seq 连续，不改写创建期事件。

## 验证

- `npm test`：契约、schema、策略、凭证、结果归一化、SQLite v2、工具归属/管理员、聊天沙箱、MCP 客户端。
- `DATABASE_URL=..._test npm run test:pg`：任务审批暂停/参数绑定/自批/拒绝/一次性执行、策略拒绝/预算/漂移/归属、服务主体 scope/吊销/过期、模型 profile 与 Worker 解析、迁移。
- 手工：创建带 custom 工具的审批任务 → `waiting_approval` → 参数错误 409 → 批准 → 执行一次 → `completed`；越权自定义工具 403；沙箱访问 `fetch` 失败；服务主体错误 KB 403。

## 后续

P0-5：成果文件 ACL 与工作台审批 UI；P0-6：容器/网络命名空间沙箱、模型级评测、per-tenant 限流。
