// 模型选择：从 SQLite 读取指定类型的默认模型；没有配置时返回 null。
// 与 llm.js 分离，使 Worker / Runtime 不必加载知识面 SQLite。
import { defaultModel } from './db.js';

export function getModel(kind){
  return defaultModel(kind);
}
