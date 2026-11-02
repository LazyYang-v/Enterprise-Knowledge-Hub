// 工具结果归一化：统一截断、不可信标记与哈希；所有结果回传模型前都经这里。
import crypto from 'node:crypto';
import { config } from '../config.js';

export class ToolRunError extends Error {
  constructor(code, message, { retryable = false } = {}){
    super(message);
    this.name = 'ToolRunError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function stringifyToolResult(value){
  if (value == null) return 'null';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function normalizeToolResult({
  status = 'succeeded', value = null, errorCode = null, errorMessage = null,
  untrusted = true, maxChars = config.tools.maxOutputChars,
} = {}){
  const raw = status === 'succeeded' ? stringifyToolResult(value) : String(errorMessage || errorCode || '工具执行失败');
  const content = raw.length > maxChars ? raw.slice(0, maxChars) + '\n…(结果已截断)' : raw;
  const resultHash = crypto.createHash('sha256').update(raw).digest('hex');
  const out = {
    status,
    content,
    untrusted: status === 'succeeded' ? !!untrusted : false,
    truncated: content.length !== raw.length,
    original_size: raw.length,
    result_hash: resultHash,
  };
  if (status !== 'succeeded') out.error_code = errorCode || 'tool_failed';
  return out;
}

/** 模型上下文中的工具结果：明确标注不可信，避免工具输出提升为指令。 */
export function toolMessageContent(result){
  if (result.untrusted){
    return `=== UNTRUSTED_TOOL_RESULT_START ===\n${result.content}\n=== UNTRUSTED_TOOL_RESULT_END ===`;
  }
  return result.content;
}
