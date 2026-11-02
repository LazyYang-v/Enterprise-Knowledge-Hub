# 评测数据（P0-0 约定）

P0-0 只定义评测任务与 E2E 场景，**不提交真实业务数据或大文件**。P0-5 起，PDF/DOCX/XLSX/ZIP 等二进制 fixture 全部由测试在运行时生成（`buildZip`、`xlsx`、最小 DOCX writer），仓库只保留本说明与 JSON 用例；需要真实语料时由测试环境注入。

## 目录

```text
evals/
  p0/
    tasks.json                  # 30 条评测任务
    p03-citations.json          # 引用与版本用例
    p04-tools.json              # 工具/审批/沙箱用例
    p05-artifacts.json          # 成果面与文件工具用例
    e2e/
      e2e-1-policy-audit.json   # 制度审查
      e2e-2-research-report.json
      e2e-3-interrupt-recovery.json
    fixtures/
      README.md                 # 本文件（不提交二进制）
```

## Fixture 约定

| 文件 | 用途 | 何时生成 |
|---|---|---|
| `policy-采购制度.pdf` / `.docx` | 制度审查依据 | 测试时生成（P0-5） |
| `applications-采购申请.xlsx` | 正常与异常申请 | 测试时生成（P0-5） |
| `injection-恶意指令.md` | 提示注入测试 | P0-4 |
| `research-行业资料/*.md` | 调研语料 | 测试时生成（P0-5） |
| `crm-mock/` | 支持/不支持幂等的假 CRM | P0-6 |

要求：

- 所有 fixture 使用虚构公司、人名与金额。
- 不得包含真实密钥、客户数据或未脱敏个人信息。
- 提示注入 fixture 只用于安全测试，不接入生产知识库。
- ZIP fixture 需包含路径遍历、符号链接、重复名与高压缩比样例，用于 S-09/Q-05 测试；使用 `server/artifacts/zip-guard.js` 的 `buildZip`/`inspectZip` 生成与验证。
- `data/artifacts/**` 属于运行时数据，必须在 `.gitignore` 中，不得提交。
