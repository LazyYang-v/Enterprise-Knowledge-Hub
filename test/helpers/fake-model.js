// 可控的 OpenAI 兼容模型服务（非流式 chat/completions），用于任务测试。
import http from 'node:http';

export async function startFakeModel(responder){
  const requests = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch {}
      calls += 1;
      requests.push({ body: payload, call: calls });
      let out;
      try {
        out = await responder({ body: payload, call: calls, requests });
      } catch (e){
        out = { status: 500, body: e.message };
      }
      if (out?.delayMs) await new Promise(r => setTimeout(r, out.delayMs));
      if (out?.hang){
        // 客户端被杀后释放连接；超时兜底避免孤儿请求。
        setTimeout(() => {
          if (!res.writableEnded){ res.writeHead(504, { 'Content-Type': 'text/plain' }); res.end('model timeout'); }
        }, 10000).unref();
        return;
      }
      if (out?.status && out.status !== 200){
        res.writeHead(out.status, { 'Content-Type': 'text/plain' });
        res.end(String(out.body || 'model error'));
        return;
      }
      const content = typeof out === 'string' ? out : (out?.content ?? '');
      const usage = typeof out === 'object' ? out?.usage : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content } }],
        ...(usage ? { usage } : {}),
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    base_url: `http://127.0.0.1:${server.address().port}/v1`,
    model_name: 'fake-model',
    api_key: '',
    requests,
    get calls(){ return calls; },
    close: () => new Promise(resolve => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

export const finish = summary => JSON.stringify({ type: 'finish', summary, artifact_refs: [], citations: [] });
export const plan = items => JSON.stringify({ type: 'plan', plan_items: items });
export const askUser = (question, properties) => JSON.stringify({
  type: 'ask_user', question, input_schema: { type: 'object', properties },
});
export const fail = (code, message) => JSON.stringify({ type: 'fail', error_code: code, message });
