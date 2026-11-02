// ModelAdapter：统一模型协议、流式输出、工具调用解析与错误映射（设计文档 §5.6）。
// P0-1 复用现有 OpenAI 兼容客户端 llm.js，仅增加错误分类与稳定入口。
import { streamChat, chatOnce } from '../llm.js';

export class ModelError extends Error {
  constructor(code, message, cause){
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.cause = cause;
  }
}

export function mapModelError(e){
  if (e instanceof ModelError) return e;
  const message = e?.message || String(e);
  let code = 'model_error';
  if (e?.name === 'AbortError') code = 'model_aborted';
  else if (e?.name === 'TimeoutError' || /timeout|timed out/i.test(message)) code = 'model_timeout';
  else if (/\(429\)|rate.?limit/i.test(message)) code = 'model_rate_limited';
  else if (/\((5\d\d)\)|\(5\d\d\)/.test(message)) code = 'model_unavailable';
  else if (/\(401\)|\(403\)/.test(message)) code = 'model_auth_failed';
  else if (/\(400\)/.test(message)) code = 'model_bad_request';
  return new ModelError(code, message, e);
}

export async function* streamModel(model, messages, options = {}){
  try {
    yield* streamChat(model, messages, options);
  } catch (e){
    // 客户端取消保持原样，调用方据此区分“用户中止”和“模型失败”。
    if (options.signal?.aborted || e?.name === 'AbortError') throw e;
    throw mapModelError(e);
  }
}

export async function completeModel(model, messages, options = {}){
  try {
    return await chatOnce(model, messages, options);
  } catch (e){
    if (options.signal?.aborted || e?.name === 'AbortError') throw e;
    throw mapModelError(e);
  }
}

