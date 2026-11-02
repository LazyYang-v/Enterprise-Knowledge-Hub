#!/usr/bin/env node
// C1–C8 基线复现（P0-0，非门禁）。
// 目的：用临时 SQLite 数据目录记录当前行为，不修复、不把漏洞固化为测试预期。
// 安全：只使用 /tmp 下的临时数据目录，不会读写仓库的 data/。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs', 'baseline');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-baseline-'));
if (path.resolve(dataDir) === path.resolve(ROOT, 'data') || path.resolve(dataDir).startsWith(path.resolve(ROOT) + path.sep)){
  console.error('拒绝在工作区目录内运行基线脚本');
  process.exit(1);
}

process.env.EKH_DATA_DIR = dataDir;
process.env.EKH_ENABLE_DEMO_SEED = '0';
process.env.NODE_ENV = 'test';
process.env.EKH_SERVICE_TOKEN = 'b'.repeat(64);

const { createApp } = await import('../server/app.js');
const { db } = await import('../server/db.js');

const app = createApp();
const server = await new Promise((resolve, reject) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
  s.on('error', reject);
});
const base = `http://127.0.0.1:${server.address().port}`;

function jsonBody(method, url, { token, body } = {}){
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined){
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return fetch(base + url, { method, headers, body: payload }).then(async res => {
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text };
  });
}

async function register(email, name){
  const r = await jsonBody('POST', '/api/auth/register', { body: { email, name, password: 'password123' } });
  if (r.status !== 200) throw new Error(`注册失败：${r.text}`);
  return { token: r.data.token, user: r.data.user };
}

async function waitFor(fn, timeout = 8000){
  const start = Date.now();
  while (Date.now() - start < timeout){
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('等待超时');
}

async function chatSse(token, sessionId, message){
  const res = await fetch(`${base}/api/sessions/${sessionId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message }),
  });
  const text = await res.text();
  const events = [];
  for (const block of text.split('\n\n')){
    for (const line of block.split('\n')){
      if (!line.startsWith('data:')) continue;
      try { events.push(JSON.parse(line.slice(5).trim())); } catch {}
    }
  }
  return { status: res.status, events, text };
}

const SECRET = '采购限额为人民币 888 万元';
const checks = [];
function record(id, title, setup, observed, status, evidence){
  checks.push({ id, title, setup, observed, status, evidence });
  console.log(`${id} ${status}: ${title}`);
}

let users, kbB, docB, agentB;
try {
  const alice = await register('baseline-alice@example.com', 'Alice');
  const bob = await register('baseline-bob@example.com', 'Bob');
  users = { alice, bob };

  const kb = await jsonBody('POST', '/api/kbs', { token: bob.token, body: { name: 'Bob 私有制度库' } });
  kbB = kb.data.kb.id;
  const qa = await jsonBody('POST', `/api/kbs/${kbB}/qa`, {
    token: bob.token,
    body: { question: '采购限额是多少？', answer: SECRET },
  });
  docB = qa.data.id;
  await waitFor(async () => {
    const r = await jsonBody('GET', `/api/documents/${docB}`, { token: bob.token });
    return r.data?.doc?.status === 'ready';
  });
  const agent = await jsonBody('POST', '/api/agents', {
    token: bob.token,
    body: { name: 'Bob 的智能体', description: '私有预设', kb_ids: [kbB], tools: [] },
  });
  agentB = agent.data.agent.id;

  // C1：A 的 Agent 预设指向 B 的私有 KB，聊天仍检索到 B 的内容。
  const agentA = await jsonBody('POST', '/api/agents', {
    token: alice.token,
    body: { name: 'Alice 的智能体', kb_ids: [kbB], tools: [] },
  });
  const sessionA = await jsonBody('POST', '/api/sessions', {
    token: alice.token,
    body: { title: 'C1 越权检索', agent_id: agentA.data.agent.id },
  });
  const c1 = await chatSse(alice.token, sessionA.data.session.id, '采购限额是多少？');
  const c1Text = JSON.stringify(c1.events);
  record(
    'C1', 'Agent 预设的 kb_ids 未与用户可见知识库求交集',
    'Alice 创建 Agent，kb_ids 指向 Bob 的私有知识库；Alice 发起聊天',
    c1Text.includes('888') || c1Text.includes('采购限额') ? 'Alice 的聊天响应包含 Bob 知识库内容' : '未观察到内容泄露',
    c1Text.includes('888') ? 'reproduced' : 'not_reproduced',
    c1Text.includes('888') ? 'SSE meta/delta 中出现“888 万元”' : '响应未包含目标内容',
  );

  // C2：会话创建接受任意 agent_id。
  const c2 = await jsonBody('POST', '/api/sessions', {
    token: alice.token,
    body: { title: 'C2 跨用户 Agent', agent_id: agentB },
  });
  record(
    'C2', '会话创建接受任意 agent_id，未校验 owner',
    'Alice 创建会话时把 agent_id 填成 Bob 的 Agent',
    `HTTP ${c2.status}，会话 agent=${c2.data?.session?.agent?.name || '未加载'}`,
    c2.status === 200 && c2.data?.session?.agent?.name === 'Bob 的智能体' ? 'reproduced' : 'not_reproduced',
    c2.status === 200 ? '会话成功加载了 Bob 的 Agent 配置' : '请求被拒绝',
  );

  // C3：自定义工具删除缺少 owner 校验。
  const tool = await jsonBody('POST', '/api/tools/upload', {
    token: bob.token,
    body: { code: `export default { name: 'bob_tool', description: 'Bob 的工具', execute(){ return 'ok'; } };` },
  });
  const toolKey = tool.data.tool.key;
  const c3 = await jsonBody('DELETE', `/api/tools/custom/${toolKey.slice(7)}`, { token: alice.token });
  const c3After = await jsonBody('GET', '/api/tools', { token: bob.token });
  record(
    'C3', '自定义工具的删除/启停缺少 owner 校验',
    'Bob 上传自定义工具；Alice 调用 DELETE /api/tools/custom/:id',
    `Alice 删除返回 HTTP ${c3.status}；工具仍存在=${c3After.data.tools.some(t => t.key === toolKey)}`,
    c3.status === 200 ? 'reproduced' : 'not_reproduced',
    c3.status === 200 ? '非所有者成功删除他人工具' : '请求被拒绝',
  );

  // C4：模型管理接口无管理员校验（最后执行并清理，避免影响其他检查）。
  const c4 = await jsonBody('POST', '/api/models', {
    token: alice.token,
    body: { kind: 'chat', name: 'baseline-model', base_url: 'http://127.0.0.1:1/v1', model_name: 'noop' },
  });
  record(
    'C4', '模型管理接口无管理员校验',
    '普通用户 Alice 调用 POST /api/models',
    `HTTP ${c4.status}`,
    c4.status === 200 ? 'reproduced' : 'not_reproduced',
    c4.status === 200 ? '普通用户成功新增模型配置' : '请求被拒绝',
  );

  // C5：MCP 入站 Server 使用单一全局服务令牌，可读取任意文档。
  let c5Status = 'static_evidence';
  let c5Observed = '未能通过 SDK 完成 MCP 调用，记录静态证据';
  let c5Evidence = 'server/mcp.js:32-38、52-54；server/service-auth.js:8-21';
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'ekh-baseline', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${process.env.EKH_SERVICE_TOKEN}` } },
    });
    await client.connect(transport);
    const result = await client.callTool({ name: 'get_document', arguments: { document_id: docB } });
    const text = JSON.stringify(result);
    c5Observed = text.includes('888') ? '服务令牌成功读取 Bob 私有文档内容' : '调用成功但未返回目标内容';
    c5Status = text.includes('888') ? 'reproduced' : 'not_reproduced';
    c5Evidence = 'MCP tools/call get_document 返回文档文本';
    await client.close();
  } catch (e){
    c5Observed = `MCP 调用失败：${e.message}`;
  }
  record(
    'C5', 'MCP 入站 Server 使用单一全局服务令牌',
    '使用服务令牌调用 MCP get_document 读取 Bob 的文档',
    c5Observed,
    c5Status,
    c5Evidence,
  );

  // C6：浏览器关闭中止上游模型流（静态证据，无法无侵入复现）。
  record(
    'C6', '浏览器关闭会 abort 上游模型流',
    '关闭聊天页面，观察上游模型请求',
    '静态证据：res.on("close") 调用 abortStream.abort()',
    'static_evidence',
    'server/routes/chat.js:173-175',
  );

  // C7：检索候选集全量读出后在 JS 计算。
  const candidateCount = db.prepare(
    'SELECT COUNT(*) AS c FROM chunks WHERE kb_id IN (?) AND embedding IS NOT NULL',
  ).get(kbB).c;
  record(
    'C7', '检索候选集全量读出后在 JS 中算余弦',
    '统计一次检索读取的候选行数',
    `当前知识库候选 chunk 数=${candidateCount}；检索实现无候选上限`,
    'static_evidence',
    'server/search.js:23-29（SELECT 无 LIMIT）、62-93',
  );

  // C8：用户令牌的 /api/retrieve 已做可见性过滤。
  const c8 = await jsonBody('POST', '/api/retrieve', {
    token: alice.token,
    body: { query: '采购限额', kb_ids: [kbB] },
  });
  record(
    'C8', '用户令牌 /api/retrieve 的 ACL 基线',
    'Alice 使用用户令牌检索 Bob 的知识库',
    `HTTP ${c8.status}`,
    c8.status === 403 ? 'safe' : 'not_reproduced',
    c8.status === 403 ? '越权检索被拒绝，可作为 KnowledgeService 基线' : '预期应返回 403',
  );

  // 清理 C4 创建的模型（临时库，仅保持报告干净）。
  if (c4.data?.model?.id) await jsonBody('DELETE', `/api/models/${c4.data.model.id}`, { token: alice.token });
} finally {
  try { server.closeAllConnections?.(); } catch {}
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const report = {
  generatedAt: new Date().toISOString(),
  commit: (() => { try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return ''; } })(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  note: 'P0-0 基线报告，仅记录当前行为，不作为 CI 门禁；不要在生产数据上运行。',
  summary: {
    reproduced: checks.filter(c => c.status === 'reproduced').length,
    safe: checks.filter(c => c.status === 'safe').length,
    static_evidence: checks.filter(c => c.status === 'static_evidence').length,
    not_reproduced: checks.filter(c => c.status === 'not_reproduced').length,
  },
  checks,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'c1-c8.json'), JSON.stringify(report, null, 2) + '\n');

const md = [
  '# C1–C8 基线报告（P0-0）',
  '',
  `- 生成时间：${report.generatedAt}`,
  `- Commit：\`${report.commit || 'unknown'}\``,
  `- Node：${report.node}`,
  '',
  '> 本报告只记录当前行为，不修复已知缺口，也不作为 CI 门禁。',
  '',
  '| ID | 检查 | 结果 | 观察 | 证据 |',
  '|---|---|---|---|---|',
  ...checks.map(c => `| ${c.id} | ${c.title} | \`${c.status}\` | ${c.observed.replace(/\|/g, '\\|')} | ${c.evidence.replace(/\|/g, '\\|')} |`),
  '',
  '## 说明',
  '',
  '- `reproduced`：当前版本可复现的缺口。',
  '- `safe`：当前版本已有防护，作为后续阶段基线。',
  '- `static_evidence`：无法无侵入复现，仅记录源码事实。',
  '- `not_reproduced`：按预期未复现。',
  '',
].join('\n');
fs.writeFileSync(path.join(OUT_DIR, 'c1-c8.md'), md);

console.log(`\n已写入 ${path.relative(ROOT, path.join(OUT_DIR, 'c1-c8.json'))} 与 c1-c8.md`);
console.log(JSON.stringify(report.summary));
