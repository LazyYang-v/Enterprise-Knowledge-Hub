import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { db } from './db.js';
import { retrieve } from './search.js';
import { isServiceToken, bearerToken } from './service-auth.js';

const MAX_DOC_CHARS = 50000;

function refRow(r){
  return {
    chunk_id: r.chunk_id, document_id: r.document_id, kb_id: r.kb_id,
    doc_name: r.doc_name, kb_name: r.kb_name, idx_in_doc: r.idx,
    score: Math.round(r.score * 1000) / 1000, content: r.content,
  };
}

function getServer(){
  const server = new McpServer({ name: 'enterprise-knowledge-hub', version: '1.0.0' });

  server.registerTool('search_knowledge', {
    title: '知识检索',
    description: '在企业知识库中做混合检索（关键词 + 向量），返回最相关的知识片段及其来源（文档名、知识库名、分数）。',
    inputSchema: {
      query: z.string().describe('检索问题或关键词'),
      kb_ids: z.array(z.string()).optional().describe('限定检索的知识库 id；留空检索全部知识库'),
      top_k: z.number().int().min(1).max(20).optional().describe('返回片段数，默认 6'),
    },
  }, async ({ query, kb_ids, top_k }) => {
    const text = String(query || '').trim();
    if (!text) return { content: [{ type: 'text', text: 'query 不能为空' }], isError: true };
    let ids = db.prepare('SELECT id FROM knowledge_bases').all().map(r => r.id);
    if (kb_ids?.length) {
      const unknown = kb_ids.filter(id => !ids.includes(id));
      if (unknown.length) return { content: [{ type: 'text', text: `知识库不存在: ${unknown.join(', ')}` }], isError: true };
      ids = kb_ids;
    }
    const refs = ids.length ? await retrieve({ kbIds: ids, query: text, topK: top_k ?? 6 }) : [];
    const body = refs.length
      ? JSON.stringify({ refs: refs.map(refRow) }, null, 2)
      : '未检索到相关内容。';
    return { content: [{ type: 'text', text: body }] };
  });

  server.registerTool('get_document', {
    title: '读取知识文档',
    description: '按文档 id 读取企业知识库文档的元数据与全文（由分块拼接，超长截断）。',
    inputSchema: {
      document_id: z.string().describe('文档 id（来自 search_knowledge 结果的 document_id）'),
    },
  }, async ({ document_id }) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(String(document_id));
    if (!doc) return { content: [{ type: 'text', text: '文档不存在' }], isError: true };
    const chunks = db.prepare('SELECT idx, content FROM chunks WHERE document_id = ? ORDER BY idx').all(doc.id);
    let text = chunks.map(c => c.content).join('\n\n');
    if (text.length > MAX_DOC_CHARS) text = text.slice(0, MAX_DOC_CHARS) + '\n\n…[已截断]';
    const meta = {
      id: doc.id, name: doc.name, kb_id: doc.kb_id, kind: doc.kind,
      status: doc.status, chunk_count: doc.chunk_count || chunks.length,
      created_at: doc.created_at, updated_at: doc.updated_at,
    };
    return { content: [{ type: 'text', text: JSON.stringify({ document: meta, text }, null, 2) }] };
  });

  return server;
}

// 无状态 Streamable HTTP：每个请求一套 transport，凭服务令牌访问。
export function mcpHandler(req, res){
  if (!isServiceToken(bearerToken(req))) {
    return res.status(401).json({ error: '需要服务令牌（Authorization: Bearer <EKH service token>）' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: '仅支持 POST' });
  const server = getServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  server.connect(transport).then(() => transport.handleRequest(req, res, req.body)).catch(() => {
    if (!res.headersSent) res.status(500).json({ error: 'MCP 处理失败' });
  });
}
