# 评测数据（P0-0 约定）

P0-0 只定义评测任务与 E2E 场景，**不提交真实业务数据或大文件**。二进制/敏感 fixture 在 P0-5 生成或由测试环境注入。

## 目录

```text
evals/
  p0/
    tasks.json                  # 30 条评测任务
    e2e/
      e2e-1-policy-audit.json   # 制度审查
      e2e-2-research-report.json
      e2e-3-interrupt-recovery.json
    fixtures/
      README.md                 # 本文件
```

## Fixture 约定

| 文件 | 用途 | 何时生成 |
|---|---|---|
| `policy-采购制度.pdf` / `.docx` | 制度审查依据 | P0-5 |
| `applications-采购申请.xlsx` | 正常与异常申请 | P0-5 |
| `injection-恶意指令.md` | 提示注入测试 | P0-4 |
| `research-行业资料/*.md` | 调研语料 | P0-5 |
| `crm-mock/` | 支持/不支持幂等的假 CRM | P0-6 |

要求：

- 所有 fixture 使用虚构公司、人名与金额。
- 不得包含真实密钥、客户数据或未脱敏个人信息。
- 提示注入 fixture 只用于安全测试，不接入生产知识库。
- ZIP fixture 需包含路径遍历样例，用于 S-09/Q-05 测试。
