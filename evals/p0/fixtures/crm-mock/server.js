// 最小 MCP Streamable HTTP mock CRM：用于 T29 外部写幂等与故障注入测试。
// 只实现 initialize / notifications/initialized / tools/list / tools/call，不依赖外部包。
import http from 'node:http';

const PROTOCOL_VERSION = '2025-03-26';

function readBody(req){
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => resolve(body));
  });
}

function sendJson(res, payload, headers = {}){
  res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

/**
 * startCrmMock({ idempotent=true, dropFirstResponse=false })
 * - idempotent: 同一幂等键只产生一次效果（模拟真实 CRM 的去重）
 * - dropFirstResponse: 第一次 tools/call 已生效后丢弃响应（效果已发生、客户端看到失败）
 */
export async function startCrmMock({ idempotent = true, dropFirstResponse = false, responseDelayMs = 0, host = '127.0.0.1' } = {}){
  const state = {
    records: new Map(),        // idempotency_key -> record
    effects: 0,                // 真实写入次数
    requests: 0,               // tools/call 次数
    deduped: 0,                // 因幂等键命中而未重复写入的次数
    dropped: 0,
    keys: [],
    toolCalls: [],
  };
  let sessionSeq = 0;

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    let rpc = {};
    try { rpc = JSON.parse(body || '{}'); } catch {}
    const sessionId = req.headers['mcp-session-id'] || `crm-session-${++sessionSeq}`;

    if (rpc.method === 'initialize'){
      return sendJson(res, {
        jsonrpc: '2.0', id: rpc.id,
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'crm-mock', version: '1.0.0' } },
      }, { 'Mcp-Session-Id': sessionId });
    }
    if (rpc.method === 'notifications/initialized'){
      res.writeHead(202);
      return res.end();
    }
    if (rpc.method === 'tools/list'){
      return sendJson(res, {
        jsonrpc: '2.0', id: rpc.id,
        result: {
          tools: [{
            name: 'create_record',
            description: 'CRM 创建记录（外部写）',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                amount: { type: 'number' },
              },
              required: ['name'],
              additionalProperties: false,
            },
          }, {
            name: 'lookup_record',
            description: 'CRM 查询记录（只读）',
            inputSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
          }],
        },
      });
    }
    if (rpc.method === 'tools/call'){
      const tool = rpc.params?.name;
      const args = rpc.params?.arguments || {};
      const key = rpc.params?._meta?.idempotency_key
        || req.headers['idempotency-key'] || null;
      state.requests += 1;
      state.toolCalls.push({ tool, args, key });
      if (key) state.keys.push(key);

      if (tool === 'lookup_record'){
        const row = [...state.records.values()].find(r => r.name === args.name);
        return sendJson(res, {
          jsonrpc: '2.0', id: rpc.id,
          result: { content: [{ type: 'text', text: JSON.stringify(row || null) }] },
        });
      }
      if (tool !== 'create_record'){
        return sendJson(res, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'unknown tool' } });
      }

      let record;
      if (idempotent && key && state.records.has(key)){
        state.deduped += 1;
        record = state.records.get(key);
      } else {
        record = { id: `crm-${state.effects + 1}`, name: String(args.name || ''), amount: Number(args.amount || 0) };
        state.effects += 1;
        if (idempotent && key) state.records.set(key, record);
        else state.records.set(`anon-${state.effects}`, record);
      }

      if (dropFirstResponse && state.dropped === 0){
        state.dropped += 1;
        // 效果已发生，但客户端拿不到响应。
        res.destroy();
        return;
      }
      if (responseDelayMs > 0) await new Promise(r => setTimeout(r, responseDelayMs));
      return sendJson(res, {
        jsonrpc: '2.0', id: rpc.id,
        result: { content: [{ type: 'text', text: JSON.stringify(record) }] },
      });
    }
    return sendJson(res, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'unknown method' } });
  });

  await new Promise(resolve => server.listen(0, host, resolve));
  const port = server.address().port;
  return {
    endpoint: `http://${host}:${port}/mcp`,
    state,
    get records(){ return state.records; },
    get effects(){ return state.effects; },
    get requests(){ return state.requests; },
    get deduped(){ return state.deduped; },
    get keys(){ return state.keys; },
    close: () => new Promise(resolve => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain){
  const mock = await startCrmMock({
    dropFirstResponse: process.env.CRM_DROP_FIRST_RESPONSE === '1',
  });
  console.log(JSON.stringify({ endpoint: mock.endpoint }));
  const shutdown = async () => { await mock.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
