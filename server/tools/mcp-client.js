// MCP 出站客户端：仅 Streamable HTTP（P0 不启用 stdio）。
// 每次调用完成 initialize → initialized → tools/call；结果一律视为不可信文本。
import { config } from '../config.js';
import { resolveCredentialRef } from '../control/credentials.js';
import { connectionForToolName, touchConnectionHealth } from '../control/mcp-repo.js';
import { ToolRunError } from './result.js';
import { schemaHashFor } from './contract.js';
import { assertSchemaDefinition } from './schema.js';

const PROTOCOL_VERSION = '2025-03-26';
const CLIENT_INFO = Object.freeze({ name: 'enterprise-knowledge-hub', version: '1.0.0' });

function authHeaders(credential){
  return credential ? { Authorization: `Bearer ${credential}` } : {};
}

function parseSse(text){
  const out = [];
  for (const block of String(text).split(/\r?\n\r?\n/)){
    const data = block.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') continue;
    try { out.push(JSON.parse(data)); } catch {}
  }
  return out;
}

async function readRpcResponse(res, expectedId){
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')){
    const text = await res.text();
    const messages = parseSse(text);
    const match = messages.find(m => m && (m.id === expectedId || m.error));
    if (!match) throw new ToolRunError('mcp_invalid_response', 'MCP 响应缺少匹配的 JSON-RPC 消息');
    return match;
  }
  const json = await res.json().catch(() => null);
  if (!json || typeof json !== 'object') throw new ToolRunError('mcp_invalid_response', 'MCP 响应不是 JSON');
  return json;
}

async function postRpc({ endpoint, credential, sessionId, payload, timeoutMs }){
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
    ...authHeaders(credential),
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e){
    throw new ToolRunError('mcp_unavailable', `MCP 连接失败：${e?.name === 'TimeoutError' ? '超时' : e.message}`, { retryable: true });
  }
  if (!res.ok){
    throw new ToolRunError('mcp_unavailable', `MCP 服务返回 ${res.status}`, { retryable: res.status >= 500 });
  }
  return res;
}

/** 建立一次性 MCP 会话并执行 fn(client)。 */
export async function withMcpSession({ endpoint, credentialRef = '', timeoutMs = config.mcp.clientTimeoutMs } = {}, fn){
  if (!/^https?:\/\//i.test(String(endpoint || ''))){
    throw new ToolRunError('mcp_invalid_endpoint', 'MCP endpoint 必须是 http/https URL');
  }
  let credential;
  try { credential = resolveCredentialRef(credentialRef); }
  catch (e){ throw new ToolRunError('mcp_credential_unavailable', e.message); }

  const init = await postRpc({
    endpoint, credential, timeoutMs,
    payload: {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    },
  });
  const sessionId = init.headers.get('mcp-session-id') || null;
  const initMsg = await readRpcResponse(init, 1);
  if (initMsg.error) throw new ToolRunError('mcp_initialize_failed', String(initMsg.error.message || 'MCP 初始化失败'));

  // initialized 通知没有响应体；部分服务要求必须发送。
  await postRpc({
    endpoint, credential, sessionId, timeoutMs,
    payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
  }).catch(() => {});

  let id = 2;
  return fn({
    async request(method, params){
      const res = await postRpc({
        endpoint, credential, sessionId, timeoutMs,
        payload: { jsonrpc: '2.0', id: id++, method, params },
      });
      const msg = await readRpcResponse(res, id - 1);
      if (msg.error){
        throw new ToolRunError('mcp_rpc_error', `MCP 错误：${String(msg.error.message || 'unknown').slice(0, 300)}`);
      }
      return msg.result;
    },
  });
}

export async function listMcpTools({ endpoint, credentialRef = '', timeoutMs } = {}){
  return withMcpSession({ endpoint, credentialRef, timeoutMs }, async client => {
    const result = await client.request('tools/list', {});
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    const out = [];
    for (const tool of tools){
      if (!tool || typeof tool.name !== 'string') continue;
      const inputSchema = tool.inputSchema || tool.input_schema || { type: 'object', properties: {} };
      try { assertSchemaDefinition(inputSchema); }
      catch { continue; }
      out.push({
        name: tool.name.slice(0, 120),
        description: String(tool.description || '').slice(0, 2000),
        input_schema: inputSchema,
        read_only: tool.annotations?.readOnlyHint === true,
        schema_hash: schemaHashFor({ name: tool.name, version: '1.0.0', description: String(tool.description || ''), input_schema: inputSchema }),
      });
    }
    return out;
  });
}

export async function callMcpTool({ task, descriptor, args, signal = null }){
  const { connection, tool } = await connectionForToolName({
    tenantId: task.tenant_id, toolName: descriptor.name,
  }) || {};
  if (!connection) throw new ToolRunError('mcp_connection_missing', 'MCP 连接不存在');
  if (connection.status !== 'active') throw new ToolRunError('mcp_unavailable', 'MCP 连接未启用', { retryable: true });
  const allowed = Array.isArray(connection.allowed_tools) ? connection.allowed_tools : [];
  const denied = Array.isArray(connection.denied_tools) ? connection.denied_tools : [];
  if (denied.includes(tool) || (allowed.length && !allowed.includes(tool))){
    throw new ToolRunError('mcp_tool_denied', 'MCP 工具不在连接允许列表内');
  }
  if (signal?.aborted) throw new ToolRunError('mcp_aborted', 'MCP 调用已取消');
  try {
    const result = await withMcpSession({
      endpoint: connection.endpoint,
      credentialRef: connection.credential_ref,
      timeoutMs: descriptor.timeout_ms || config.mcp.clientTimeoutMs,
    }, client => client.request('tools/call', { name: tool, arguments: args }));
    await touchConnectionHealth({ connectionId: connection.id, ok: true });
    const parts = [];
    for (const item of result?.content || []){
      if (item?.type === 'text') parts.push(String(item.text ?? ''));
      else parts.push(JSON.stringify(item));
    }
    return {
      is_error: !!result?.isError,
      untrusted: true,
      content: parts.join('\n') || JSON.stringify(result || {}),
    };
  } catch (e){
    await touchConnectionHealth({ connectionId: connection.id, ok: false });
    throw e;
  }
}
