// 内置知识工具：只通过 KnowledgeService（ACL 唯一入口）访问知识面。
// handler 必须再校验任务快照范围，防止模型用文档 id 越过 kb_scope。
import { getEvidence } from '../control/evidence-repo.js';

function toolError(code, message){
  const e = new Error(message);
  e.code = code;
  e.retryable = code === 'knowledge_unavailable';
  return e;
}

function knowledgeOf(ctx){
  if (!ctx?.knowledge?.service) throw toolError('knowledge_unavailable', '知识库服务不可用');
  return ctx.knowledge;
}

function scopeOf(ctx){
  return knowledgeOf(ctx).scope || { kbIds: [], documentIds: [], sessionId: null };
}

function assertDocumentInScope(ctx, doc){
  const scope = scopeOf(ctx);
  const inDocs = (scope.documentIds || []).includes(doc.id);
  const inKbs = !!doc.kb_id && (scope.kbIds || []).includes(doc.kb_id);
  const inSession = !!doc.session_id && scope.sessionId === doc.session_id;
  if (!inDocs && !inKbs && !inSession){
    throw toolError('forbidden', '文档不在当前任务知识范围内');
  }
}

export const BUILTIN_TOOLS = Object.freeze([
  {
    name: 'knowledge.search',
    version: '1.0.0',
    source: 'builtin',
    description: '在当前任务的知识库范围内做混合检索，返回带 evidence_id 的证据片段。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2000, description: '检索问题或关键词' },
        top_k: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认 6' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    side_effect: 'read',
    approval_policy: 'never',
    timeout_ms: 30000,
    idempotency: 'none',
    resource_scope: 'knowledge_base',
    sandbox_profile: 'read_only',
    handler: async (args, ctx) => {
      const { service, scope } = knowledgeOf(ctx);
      const result = await service.search({
        actor: {
          userId: ctx.task.owner_id, tenantId: ctx.task.tenant_id, principalType: 'user',
        },
        scope,
        query: args.query,
        topK: Math.min(Number(args.top_k) || 6, 20),
        taskId: ctx.task.id,
        stepId: ctx.stepId || null,
        toolCallId: ctx.toolCallId || null,
        leaseEpoch: ctx.task.lease_epoch ?? ctx.leaseEpoch ?? null,
      });
      return {
        evidence: result.evidence.map(e => ({
          evidence_id: e.evidence_id,
          document_id: e.document_id,
          document_version: e.document_version,
          chunk_id: e.chunk_id,
          content_hash: e.content_hash,
          title: e.title,
          kb_id: e.kb_id,
          kb_name: e.kb_name,
          locator: e.locator,
          excerpt: e.excerpt,
          score: e.score,
          untrusted: true,
        })),
        citations: result.citations,
        degraded: result.degraded,
        candidate_capped: result.candidateCapped,
        reduced_count: result.reducedCount,
      };
    },
  },
  {
    name: 'knowledge.get_document',
    version: '1.0.0',
    source: 'builtin',
    description: '读取当前任务知识范围内某份文档的正文（可按版本与字符区间）。',
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', minLength: 1, maxLength: 200 },
        version: { type: 'integer', minimum: 1 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100000 },
      },
      required: ['document_id'],
      additionalProperties: false,
    },
    side_effect: 'read',
    approval_policy: 'never',
    timeout_ms: 30000,
    idempotency: 'none',
    resource_scope: 'knowledge_base',
    sandbox_profile: 'read_only',
    handler: async (args, ctx) => {
      const { service } = knowledgeOf(ctx);
      const result = await service.getDocument(
        { userId: ctx.task.owner_id, tenantId: ctx.task.tenant_id, principalType: 'user' },
        args.document_id,
        {
          version: args.version ?? null,
          range: { offset: args.offset ?? 0, limit: args.limit ?? 50000 },
        },
      );
      assertDocumentInScope(ctx, result.document);
      return result;
    },
  },
  {
    name: 'knowledge.get_citation',
    version: '1.0.0',
    source: 'builtin',
    description: '按 evidence_id 读取当前任务的证据快照与版本状态。',
    input_schema: {
      type: 'object',
      properties: {
        evidence_id: { type: 'string', minLength: 36, maxLength: 36 },
      },
      required: ['evidence_id'],
      additionalProperties: false,
    },
    side_effect: 'read',
    approval_policy: 'never',
    timeout_ms: 15000,
    idempotency: 'none',
    resource_scope: 'task',
    sandbox_profile: 'read_only',
    handler: async (args, ctx) => {
      const row = await getEvidence({
        tenantId: ctx.task.tenant_id, taskId: ctx.task.id, evidenceId: args.evidence_id,
      });
      if (!row) throw toolError('not_found', '证据不存在或不属于当前任务');
      const knowledge = knowledgeOf(ctx);
      return knowledge.service.getCitation(
        { userId: ctx.task.owner_id, tenantId: ctx.task.tenant_id, principalType: 'user' },
        args.evidence_id,
      );
    },
  },
  {
    name: 'knowledge.list_bases',
    version: '1.0.0',
    source: 'builtin',
    description: '列出当前任务可访问的知识库（已按任务范围收窄）。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    side_effect: 'read',
    approval_policy: 'never',
    timeout_ms: 15000,
    idempotency: 'none',
    resource_scope: 'knowledge_base',
    sandbox_profile: 'read_only',
    handler: async (args, ctx) => {
      const { service, scope } = knowledgeOf(ctx);
      const all = await service.listBases({
        userId: ctx.task.owner_id, tenantId: ctx.task.tenant_id, principalType: 'user',
      });
      const allowed = new Set(scope.kbIds || []);
      return { bases: all.filter(kb => allowed.has(kb.id)) };
    },
  },
]);

const BY_NAME = new Map(BUILTIN_TOOLS.map(t => [t.name, t]));

export function getBuiltinTool(name){
  return BY_NAME.get(String(name)) || null;
}

export function builtinDescriptor(name){
  const def = BY_NAME.get(String(name));
  if (!def) return null;
  const { handler, ...rest } = def;
  return rest;
}

export function builtinDescriptors(){
  return BUILTIN_TOOLS.map(({ handler, ...rest }) => rest);
}
