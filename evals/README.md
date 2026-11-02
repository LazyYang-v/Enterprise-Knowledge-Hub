# 评测集（P0）

## 状态

- **P0-0**：定义 30 条任务与 3 个端到端场景，作为后续阶段的验收语料。
- **P0-3**：新增 `p0/p03-citations.json`，用确定性用例验证引用字段、版本固定与越权收缩；对应测试见 `test/integration/knowledge-*.test.js`、`test/pg/p03-knowledge.test.js`。
- **P0-4**：新增 `p0/p04-tools.json`，验证工具契约、默认拒绝、审批一次性与沙箱边界。
- **P0-5**：新增 `p0/p05-artifacts.json`（ART-01…ART-09），覆盖成果写入/版本/ACL、ZIP 防御、上传限制与 finish 引用；fixture 全部在测试运行时生成，仓库不提交二进制。
- **P0-6**：接入真实模型评测与故障注入，记录指标。
- 当前没有自动评分器；`tasks.json` 只描述目标、输入与通过标准；`p03-citations.json` / `p04-tools.json` / `p05-artifacts.json` 是测试设计清单，不是数值指标。

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

## 指标（P0-6 目标）

- 30 任务成功率 ≥ 80%
- 引用准确率 ≥ 95%
- 无依据断言率 ≤ 2%
- 生成文件可打开率 100%
- 哈希一致率 100%
- 跨租户/越权 0 次

## 扩展

新增任务时：

1. 分配唯一 `id`；
2. 至少覆盖正常、边界、失败三种情况之一；
3. `acceptance_ids` 必须来自设计文档 §16；
4. 不得包含真实客户数据或密钥；
5. 同步更新本 README 的规模说明。
