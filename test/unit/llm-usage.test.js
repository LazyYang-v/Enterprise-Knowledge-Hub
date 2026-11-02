import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chatOnce } from '../../server/llm.js';

function startServer(handler){
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      base_url: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => new Promise(r => server.close(r)),
    }));
  });
}

test('chatOnce 透传 provider usage，缺失时不调用回调', async t => {
  let usageSeen = null;
  const srv = await startServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hello' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }));
    });
  });
  t.after(() => srv.close());
  const out = await chatOnce({ base_url: srv.base_url, model_name: 'm', api_key: '' },
    [{ role: 'user', content: 'hi' }], { onUsage: u => { usageSeen = u; } });
  assert.equal(out, 'hello');
  assert.deepEqual(usageSeen, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });

  let called = false;
  const srv2 = await startServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'no usage' } }] }));
    });
  });
  t.after(() => srv2.close());
  const out2 = await chatOnce({ base_url: srv2.base_url, model_name: 'm', api_key: '' },
    [{ role: 'user', content: 'hi' }], { onUsage: () => { called = true; } });
  assert.equal(out2, 'no usage');
  assert.equal(called, false);
});
