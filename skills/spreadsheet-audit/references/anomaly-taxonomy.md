# 异常分类

| 类型 | 说明 | 严重程度 |
| --- | --- | --- |
| missing_required | 必填字段为空 | high |
| type_mismatch | 类型与数据字典不一致 | medium |
| out_of_range | 超出允许范围或业务阈值 | medium |
| duplicate_key | 主键/业务键重复 | high |
| orphan_reference | 引用了不存在的编码 | medium |
| date_invalid | 日期无法解析或逻辑倒置 | medium |
| currency_mixed | 同一汇总口径混用币种 | high |
| mapping_unconfirmed | 列映射无法确认 | low |

每条异常必须包含：行号、列名、原值、类型、依据、建议。不得只给统计数字。
