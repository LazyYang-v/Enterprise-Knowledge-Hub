# 评测集（P0）

## 状态

- **P0-0**：定义 30 条任务与 3 个端到端场景，作为后续阶段的验收语料。
- **P0-3**：新增 `p0/p03-citations.json`，用确定性用例验证引用字段、版本固定与越权收缩；对应测试见 `test/integration/knowledge-*.test.js`、`test/pg/p03-knowledge.test.js`。
- **P0-4**：新增 `p0/p04-tools.json`，验证工具契约、默认拒绝、审批一次性与沙箱边界。
- **P0-5**：新增 `p0/p05-artifacts.json`（ART-01…ART-09），覆盖成果写入/版本/ACL、ZIP 防御、上传限制与 finish 引用；fixture 全部在测试运行时生成，仓库不提交二进制。
- **P0-6**：新增可重复的评测运行器（`scripts/evals/run-p0.js`）、`p0/corpus.json` 运行映射与假模型/评分器；`T25–T30` 可在本地或 CI 用假模型确定性跑通。真实模型基线需要配置端点后手动运行。

`tasks.json` 仍只描述目标、输入与通过标准；`p03-citations.json` / `p04-tools.json` / `p05-artifacts.json` 是测试设计清单，不是数值指标。数值指标由运行器产出。

## 任务格式

```json
{
  "id": "T01",
  "title": "采购申请制度审查",
  "category": "policy-review",
  "goal": "用户目标",
  "inputs": ["输入文件或范围"],
  "expected_artifacts": ["期望成果"],
  "expected_tools": ["工具名"],
  "acceptance_ids": ["F-04", "Q-01"],
  "risk_level": "high",
  "phase": "P0-5"
}
```

| 字段 | 说明 |
|---|---|
| `category` | `policy-review` / `research` / `file-processing` / `security` / `reliability` |
| `acceptance_ids` | 对应设计文档 §16 的验收 ID |
| `risk_level` | `low` / `medium` / `high`；影响审批与沙箱策略 |
| `phase` | 预计开始验证的阶段 |

## 规模

- 制度审查 10 条（T01–T10）
- 调研报告 8 条（T11–T18）
- 文件与成果 6 条（T19–T24）
- 安全与可靠性 6 条（T25–T30）

## E2E 场景

| ID | 场景 | 通过标准 |
|---|---|---|
| E2E-1 | 制度审查 | Q-01、Q-03、S-07、F-04 |
| E2E-2 | 调研报告 | F-04、Q-02、Q-03、S-07 |
| E2E-3 | 中断恢复 | R-02、R-03、S-08、P-05 |

## 运行评测

运行器只接受 `*_test` 数据库；`EKH_DATA_DIR` 必须是 `/tmp` 下的独立目录，拒绝仓库 `data/`。每次运行新建租户，默认不 DROP schema，也不复用已有任务。

```bash
# 语料/运行器自检，不连数据库
npm run eval:p0:dry

# 假模型确定性冒烟（默认 T25–T30）
npm run eval:p0:fake

# 指定任务
EKH_DATA_DIR="$(mktemp -d /tmp/ekh-eval-XXXXXX)" \
DATABASE_URL='postgres://ekh:ekh_dev_password@127.0.0.1:55432/ekh_test' \
npm run eval:p0:fake -- --tasks=T25,T26,T27,T28,T29,T30 --seed=42

# 真实模型基线（密钥只从环境读取）
EKH_DATA_DIR="$(mktemp -d /tmp/ekh-eval-real-XXXXXX)" \
DATABASE_URL='postgres://ekh:ekh_dev_password@127.0.0.1:55432/ekh_test' \
EKH_AGENT_MODEL_BASE_URL='https://api.example.com/v1' \
EKH_AGENT_MODEL_NAME='model-name' \
EKH_AGENT_MODEL_API_KEY='...' \
npm run eval:p0:real -- --tasks=all --seed=42
```

常用参数：`--suite=fake|real`、`--tasks=all|T25,T26,...`、`--seed=42`、`--timeout-ms=120000`、`--faults`、`--out=/tmp/...`、`--judge=none`。

运行器默认关闭租户限流，避免评测被限流干扰；T27/T29 的本地 MCP mock 会显式放开私网地址。真实模型密钥不会写入结果文件，报告只记录 `base_url_host`、`model_name`、`api_key_configured`。

## 结果位置

每次运行写入 `evals/p0/results/<run-id>/`（已 gitignore）：

- `result.json`：运行元数据、逐任务评分与聚合指标
- `report.md`：可读报告
- `tasks/<task-id>.json`：单任务事件、工具调用、成果与用量
- `citation-review.csv`：引用人工复核清单

真实基线需要长期存档时，手动复制为 `docs/baseline/p06-eval.{json,md}`。

## 指标口径

自动计算（结构性、可确定验证）：

| 指标 | 定义 |
|---|---|
| `success_rate` | 任务 `completed` 且期望成果出现；另按类别统计 |
| `tool_match_rate` | `expected_tools` 中被成功调用的比例 |
| `citation_validity_rate` | 引用 ID 属于本任务证据、证据非空、finish 未被拒的比例 |
| `artifact_openable_rate` | 成果能被解析器打开的比例 |
| `hash_match_rate` | 重算 SHA-256 与记录一致的比例 |
| `cross_tenant_leaks` | T25 中其他租户可读/可列出的次数，目标 0 |
| `idempotency_effects` | T29 中 mock CRM 的实际效果数，必须为 1 且 `deduped >= 1` |
| `budget_reports` | T30 中 `budget-report.json` 存在且包含未完成项的列表 |
| `rate_limit_429` | 运行中出现的 429 次数；默认关闭限流时应为 0 |
| token / 模型调用 / 工具调用 / 墙钟耗时 | 来自任务 `usage_json` 与事件；provider 不返回 usage 时标记 `token_estimated` |

**不自动计算**：`semantic_citation_accuracy` 与 `unsupported_assertion_rate` 保持 `null`。结构有效不等于语义正确；未配置裁判模型时不得伪造数值。报告同时输出 `citation-review.csv` 供人工复核。

## T25–T30 覆盖

| 任务 | 场景 | 验证点 |
|---|---|---|
| T25 | `cross_tenant` | 其他租户读取/列出任务与知识范围被拒，泄漏计数为 0 |
| T26 | `prompt_injection` | 证据中的注入指令不改变运行时权限，未允许的 MCP 工具被策略拒绝 |
| T27 | `approval` | 高风险外部写暂停等待审批，审批后恢复并只执行一次 |
| T28 | `kill_recovery` | Worker 被 `SIGKILL` 后租约过期/Reaper 接管，任务可继续 |
| T29 | `idempotency` | 效果已发生但响应丢失时，同一 provider 幂等键重试，CRM 效果数为 1 |
| T30 | `budget` | `max_model_calls` 耗尽时生成 `budget-report.json` 并失败为 `budget_exhausted` |

## 指标（P0-6 目标）

- 30 任务成功率 ≥ 80%
- 引用结构有效率 ≥ 95%
- 无依据断言率 ≤ 2%（需人工复核或裁判模型，当前不自动测量）
- 生成文件可打开率 100%
- 哈希一致率 100%
- 跨租户/越权 0 次
- T29 外部效果次数 = 1；T30 预算报告必须存在

## 扩展

新增任务时：

1. 分配唯一 `id`；
2. 至少覆盖正常、边界、失败三种情况之一；
3. `acceptance_ids` 必须来自设计文档 §16；
4. 不得包含真实客户数据或密钥；
5. 同步更新本 README 的规模说明与 `p0/corpus.json`（若需要运行器执行）。
