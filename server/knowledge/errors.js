// 知识面错误：HTTP 路由与任务执行器共享稳定错误码。
export class KnowledgeError extends Error {
  constructor(message, { code = 'knowledge_error', status = 500, retryable = false } = {}){
    super(message);
    this.name = 'KnowledgeError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class KnowledgeForbiddenError extends KnowledgeError {
  constructor(message = '无权访问知识库', code = 'forbidden'){
    super(message, { code, status: 403 });
    this.name = 'KnowledgeForbiddenError';
  }
}

export class KnowledgeNotFoundError extends KnowledgeError {
  constructor(message = '知识资源不存在', code = 'not_found'){
    super(message, { code, status: 404 });
    this.name = 'KnowledgeNotFoundError';
  }
}

export class KnowledgeUnavailableError extends KnowledgeError {
  constructor(message = '知识库暂不可用', code = 'knowledge_unavailable'){
    super(message, { code, status: 503, retryable: true });
    this.name = 'KnowledgeUnavailableError';
  }
}
