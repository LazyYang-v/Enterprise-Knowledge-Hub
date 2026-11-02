# ADR-0007：P0-6 沙箱、限流、故障注入与评测

- 状态：已采纳
- 日期：2026-11-02
- 关联：P0-4 工具沙箱/MCP、P0-5 成果面、设计文档 §14 / §16

## 背景

P0-0…P0-5 已交付工具契约、审批、成果 ACL 与任务恢复，但仍有四个缺口：

1. 自定义工具沙箱只是父进程子进程 + `vm`，继承宿主网络；`sandbox_profile` 只声明未执行。
2. 没有租户级资源控制，`tool_registry.rate_limit` 未消费。
3. 模型/工具预算中的 `max_model_calls`/`max_tokens` 未执行，token 用量恒为 0；MCP 外部写没有 provider 幂等键。
4. 没有可重复的评测运行器，语义指标无法被诚实地报告。

## 决策

### 1. 沙箱后端显式选择，`container` 失败关闭

- `EKH_TOOL_SANDBOX_MODE=process|required|container|off`，默认 `process`。
- `container` 只走 Docker：`--network=none --read-only --user 10001:10001 --cap-drop=ALL --security-opt no-new-privileges --pids-limit --memory --cpus --ulimit`，`/tmp` tmpfs；`workspace_write` 额外挂 `/workspace` tmpfs，不挂宿主目录。
- Docker/镜像不可用即 `sandbox_unavailable`，绝不回退进程沙箱。Worker 启动时预检。
- `read_only`/`workspace_write`/`code_exec` 可进入自定义工具沙箱；`network_allowlist` 仅用于 MCP；`browser` 未实现。
- 活动沙箱登记在 `server/tools/sandbox-registry.js`；abort、超时、Worker 停机都会杀进程组/容器。容器内 `EKH_SANDBOX_HARD_TIMEOUT_MS` 兜底父进程被杀后的残留。

容器运行时不是 VM 级隔离；镜像固定 tag，需定期重建。

### 2. MCP 出网默认拒绝私网，provider 幂等键透传

- 新增 `server/net/ssrf.js` 与 `server/tools/egress-policy.js`：只允许 `http(s)`，拒绝 userinfo、私网、链路本地、元数据地址、重定向（3xx → `mcp_redirect_denied`）。
- 连接创建/更新/测试/刷新/每次调用都校验；单连接 `egress_allowlist` 优先于全局 `EKH_MCP_EGRESS_ALLOWLIST`。
- 本机 mock 必须显式 `EKH_MCP_ALLOW_PRIVATE_HOSTS=1`。
- `(tenant, task, tool, args_hash)` 生成 provider 幂等键，写入 `Idempotency-Key` 头与 JSON-RPC `_meta.idempotency_key`；键不含 step，Worker 崩溃后新 step 仍映射到同一逻辑调用。
- 残余风险：DNS rebinding 只能通过“解析后拒绝 + 禁重定向 + allowlist + 每次重校验”缓解；彻底方案（出网代理/固定 IP）留后续。

### 3. `sandbox_profile` 与执行字段纳入漂移校验

`descriptorHash` 与 `resolvePinned` 比较 `side_effect`、`approval_policy`、`timeout_ms`、`idempotency`、`resource_scope`、`sandbox_profile`。审批 payload 带 `sandbox_profile`/`sandbox_backend`。

### 4. 租户限流使用 PostgreSQL 固定窗口

- `tenant_rate_limits` 允许单租户覆盖；`rate_limit_counters` 用 `INSERT … ON CONFLICT … RETURNING count` 原子消费。
- 默认桶：`task_create` 30/min、`model_call` 120/min、`tool_call` 120/min。
- HTTP 429 + `Retry-After`；模型超限转为可重试 `model_rate_limited`；工具超限以非致命 `rate_limited` 回传模型。
- 默认 fail-closed；`EKH_RATE_LIMIT_FAIL_OPEN=1` 是显式降级，审计 `rate_limit.unavailable`。
- Reaper 顺带清理超保留期窗口。

### 5. 预算耗尽先落部分成果报告

- `max_steps`/`max_wall_ms`/`max_tool_calls`/`max_model_calls`/`max_tokens` 超限时，在租约有效期内写 `budget-report.json`（`kind=output`）与 `budget.exhausted` 事件，然后以 `failed/budget_exhausted` 结束。
- 报告含预算、用量、计划项完成状态、已提交成果元数据、超限键与时间。
- provider 返回 `usage` 时记录真实 token；缺失时按字符数估算并标记 `token_estimated=true`，不静默写 0。

### 6. 故障注入默认关闭且生产禁用

- `EKH_FAULT_INJECTION`、`EKH_FAULT_CONFIG`/`FILE`、`EKH_FAULT_SEED` 控制；`NODE_ENV=production` 下显式开启且未设置 `EKH_FAULT_ALLOW_PRODUCTION=1` 时启动失败。
- 支持 `point/action/after/times/probability/match`；动作 `delay/hang/throw/kill_self/empty/malformed/http_status/drop_response`。
- `fault.injected` 只记录点、动作、seed、序号，不记录参数正文。

### 7. 评测指标只承诺可自动验证的部分

- 自动：成功率、工具匹配、引用结构有效率、成果可打开/哈希一致、跨租户泄漏、T29 外部效果次数、T30 报告完整性、token/时延。
- 语义引用准确率与无依据断言率保持 `null`，输出 `citation-review.csv` 供人工复核；README 明确“结构有效 ≠ 语义正确”。
- runner 只接受 `*_test` 数据库；数据目录必须在 `/tmp`；每次运行新建租户，默认不 DROP schema。真实模型密钥只从环境读取，报告只写 `base_url_host`/`model_name`/`api_key_configured`。
- Worker 支持 `EKH_WORKER_TENANT_ID` 只领取指定租户任务；评测运行器用它避免多场景任务互相抢占，生产默认仍领取全部租户。

## 后果

- 默认部署行为不变（`process` + 限流开启）。
- 生产启用 `container` 需要先构建镜像并保证 Docker 可用；不可用时启动/执行失败，而不是降级。
- 限流默认 fail-closed，PG 故障会传导到任务创建 API；需要监控 `rate_limit.unavailable`。
- 同一任务中故意重复同一外部写会被 provider 去重，这是 `provider_key` 的语义。
- 评测真实基线依赖外部模型与 fixture，语料本身不承诺语义正确性。

## 未做

浏览器沙箱、跨调用持久 workspace、gVisor/Firecracker、Kubernetes 编排、Redis/网关级限流、per-user 计费、LLM-as-judge 自动语义评分、多租户凭证加密、非幂等外部写自动重放、跨集群限流。
