import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// 测试服务在 127.0.0.1；必须在 config 求值前显式放开私网，验证默认拒绝的用例单独覆盖。
process.env.EKH_MCP_ALLOW_PRIVATE_HOSTS = '1';
process.env.EKH_MCP_TEST_TOKEN = 'mcp-bearer-secret';

const { listMcpTools, withMcpSession } = await import('../../server/tools/mcp-client.js');
const { ToolRunError } = await import('../../server/tools/result.js');

function startMcpServer(){
  const seen = { auth: [], sessions: [], methods: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let rpc = {};
      try { rpc = JSON.parse(body || '{}'); } catch {}
      seen.auth.push(req.headers.authorization || '');
      seen.sessions.push(req.headers['mcp-session-id'] || '');
      seen.methods.push(rpc.method || '');
      const send = (payload, headers = {}) => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      if (rpc.method === 'initialize'){
        return send({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26', capabilities: {} } },
          { 'Mcp-Session-Id': 'session-1' });
      }
      if (rpc.method === 'notifications/initialized'){
        res.writeHead(202);
        return res.end();
      }
      if (rpc.method === 'tools/list'){
        return send({ jsonrpc: '2.0', id: rpc.id, result: { tools: [
          {
            name: 'lookup', description: '查询', inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'bad', description: '非法 schema',
            inputSchema: { type: 'object', $ref: '#/defs/x' },
          },
        ] } });
      }
      if (rpc.method === 'tools/call'){
        return send({ jsonrpc: '2.0', id: rpc.id, result: {
          content: [{ type: 'text', text: 'found 1' }],
        } });
      }
      return send({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'unknown method' } });
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        endpoint: `http://127.0.0.1:${server.address().port}/mcp`,
        seen,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

test('MCP Streamable HTTP：initialize、工具发现过滤非法 schema、调用与凭证', async t => {
  const srv = await startMcpServer();
  t.after(() => srv.close());

  const tools = await listMcpTools({ endpoint: srv.endpoint, credentialRef: 'env:EKH_MCP_TEST_TOKEN' });
  assert.deepEqual(tools.map(x => x.name), ['lookup']);
  assert.equal(tools[0].read_only, true);
  assert.match(tools[0].schema_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(srv.seen.methods.slice(0, 3), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.ok(srv.seen.auth.every(h => h === 'Bearer mcp-bearer-secret'));
  assert.equal(srv.seen.sessions[1], 'session-1', '初始化后必须携带 session id');

  const result = await withMcpSession({ endpoint: srv.endpoint, credentialRef: 'env:EKH_MCP_TEST_TOKEN' },
    client => client.request('tools/call', { name: 'lookup', arguments: { q: 'x' } }));
  assert.deepEqual(result, { content: [{ type: 'text', text: 'found 1' }] });
  assert.deepEqual(srv.seen.methods.slice(5), ['tools/call']);
});

test('MCP 客户端拒绝非 http(s) endpoint 与远程调用错误', async t => {
  await assert.rejects(() => listMcpTools({ endpoint: 'file:///etc/passwd' }),
    e => e instanceof ToolRunError && e.code === 'mcp_invalid_endpoint');

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'initialize failed' } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  await assert.rejects(
    () => listMcpTools({ endpoint: `http://127.0.0.1:${server.address().port}/mcp` }),
    e => e instanceof ToolRunError && e.code === 'mcp_initialize_failed',
  );
});
