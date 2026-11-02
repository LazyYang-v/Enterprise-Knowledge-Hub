// API 错误标准化：兼容任务 API 的结构化 envelope 与旧 API 的字符串 error。
export class ApiError extends Error {
  constructor({
    code = 'request_error', message = '请求失败', details = null,
    retryable = false, requestId = null, status = 0, retryAfter = null,
  } = {}){
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    this.requestId = requestId;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function parseApiError(status, data, retryAfter = null){
  const raw = data && typeof data === 'object' ? data.error : null;
  if (raw && typeof raw === 'object'){
    return new ApiError({
      code: raw.code || 'request_error',
      message: raw.message || `请求失败 (${status})`,
      details: raw.details ?? null,
      retryable: !!raw.retryable,
      requestId: raw.request_id || null,
      status,
      retryAfter: retryAfter == null ? null : Number(retryAfter),
    });
  }
  if (typeof raw === 'string' && raw){
    return new ApiError({ code: 'request_error', message: raw, status });
  }
  if (typeof data?.message === 'string' && data.message){
    return new ApiError({ message: data.message, status });
  }
  return new ApiError({ message: `请求失败 (${status})`, status });
}

export function describeApiError(error){
  if (!error) return '请求失败';
  if (error.name !== 'ApiError') return error.message || String(error);
  const map = {
    rate_limited: '请求过于频繁，请稍后再试',
    rate_limit_unavailable: '限流服务暂不可用，请稍后重试',
    approval_expired: '审批已过期，任务状态已变化',
    approval_args_mismatch: '审批参数已变化，请刷新后重试',
    sandbox_unavailable: '沙箱不可用，请检查容器运行时',
    mcp_egress_denied: 'MCP 出网被拒绝，请检查允许列表',
    artifact_too_large: '文件超过大小上限',
    artifact_forbidden: '没有权限访问该成果',
    builtin_tool_immutable: '内置工具不可启停，请使用工具策略',
    not_found: '资源不存在或无权访问',
  };
  return map[error.code] || error.message || `请求失败 (${error.status})`;
}
