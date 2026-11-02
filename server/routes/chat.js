import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { db, UPLOAD_DIR } from '../db.js';
import { $uuid, now, err, trimTitle, sseInit, sseSend, fixFileName } from '../util.js';
import { authRequired } from '../auth.js';
import { retrieve } from '../search.js';
import { chatOnce, getModel } from '../llm.js';
import { enqueue } from '../ingest.js';
import { resolveAgentCustomTools, runCustomTool, toolFnName } from '../custom-tools.js';
import { runAgentLoop } from '../agent/runner.js';
import { buildChatSystemPrompt } from '../agent/context-builder.js';
import { docRow } from './kbs.js';

const router = Router();
router.use(authRequired);

function sessionRow(s){
  // G2：只展示当前用户自己的智能体，避免会话回显他人的 agent 元数据。
  const agent = s.agent_id
    ? db.prepare('SELECT id, name, color FROM agents WHERE id = ? AND owner_id = ?').get(s.agent_id, s.user_id)
    : null;
  return {
    id: s.id, title: s.title, agent_id: s.agent_id, agent: agent || null,
    kb_ids: JSON.parse(s.kb_ids || '[]'), model: s.model, mode: s.mode,
    created_at: s.created_at, updated_at: s.updated_at,
  };
}
function messageRow(m){
  return { id: m.id, session_id: m.session_id, role: m.role, content: m.content, think: m.think || '', refs: JSON.parse(m.refs || '[]'), created_at: m.created_at };
}

export function visibleKbIds(user){
  const myOrgs = db.prepare('SELECT org_id FROM org_members WHERE user_id = ?').all(user.id).map(r => r.org_id);
  const all = db.prepare('SELECT * FROM knowledge_bases').all();
  return all.filter(kb => kb.owner_id === user.id || (kb.org_id && myOrgs.includes(kb.org_id))).map(kb => kb.id);
}

router.get('/sessions', (req, res) => {
  const rows = db.prepare('SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100').all(req.user.id);
  res.json({ sessions: rows.map(sessionRow) });
});

router.post('/sessions', (req, res) => {
  const { title = '新对话', kb_ids = [], agent_id = null, mode = 'reasoning', model = '' } = req.body || {};
  // G2：会话只能绑定当前用户自己的智能体。
  if (agent_id){
    const owned = db.prepare('SELECT id FROM agents WHERE id = ? AND owner_id = ?').get(agent_id, req.user.id);
    if (!owned) return err(res, 403, '无权使用该智能体');
  }
  const id = $uuid();
  db.prepare('INSERT INTO chat_sessions(id, user_id, title, agent_id, kb_ids, model, mode, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, String(title).slice(0, 60), agent_id, JSON.stringify(kb_ids || []), String(model || ''), mode === 'qa' ? 'qa' : 'reasoning', now(), now());
  const s = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
  res.json({ session: sessionRow(s) });
});

router.get('/sessions/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!s) return err(res, 404, '会话不存在');
  const msgs = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at').all(s.id);
  res.json({ session: sessionRow(s), messages: msgs.map(messageRow) });
});

router.put('/sessions/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!s) return err(res, 404, '会话不存在');
  const { title, kb_ids, mode } = req.body || {};
  if (title != null) db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(String(title).slice(0, 60) || s.title, s.id);
  if (kb_ids != null) db.prepare('UPDATE chat_sessions SET kb_ids = ? WHERE id = ?').run(JSON.stringify(kb_ids || []), s.id);
  if (mode != null) db.prepare('UPDATE chat_sessions SET mode = ? WHERE id = ?').run(mode === 'qa' ? 'qa' : 'reasoning', s.id);
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now(), s.id);
  const fresh = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(s.id);
  res.json({ session: sessionRow(fresh) });
});

router.delete('/sessions/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!s) return err(res, 404, '会话不存在');
  const docs = db.prepare("SELECT id, path FROM documents WHERE session_id = ?").all(s.id);
  for (const d of docs){
    db.prepare('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(d.id);
    if (d.path){ try { fs.rmSync(path.dirname(d.path), { recursive: true, force: true }); } catch {} }
  }
  db.prepare('DELETE FROM documents WHERE session_id = ?').run(s.id);
  db.prepare('DELETE FROM chunks WHERE session_id = ?').run(s.id);
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(s.id);
  db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(s.id);
  db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

router.delete('/sessions/:id/messages', (req, res) => {
  const s = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!s) return err(res, 404, '会话不存在');
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(s.id);
  res.json({ ok: true });
});

// —— 会话附件 ——
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { const dir = path.join(UPLOAD_DIR, $uuid()); fs.mkdirSync(dir, { recursive: true }); cb(null, dir); },
    filename: (req, file, cb) => cb(null, fixFileName(file.originalname)),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

router.post('/sessions/:id/attachments', upload.array('files', 10), (req, res) => {
  const s = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!s) return err(res, 404, '会话不存在');
  const created = [];
  for (const f of (req.files || [])){
    const ext = path.extname(f.originalname).replace('.', '').toLowerCase();
    const id = $uuid();
    const finalPath = path.join(path.dirname(f.path), 'source.' + (ext || 'bin'));
    fs.renameSync(f.path, finalPath);
    db.prepare(`INSERT INTO documents(id, session_id, owner_id, kind, name, mime, ext, size, path, status, created_at, updated_at)
                VALUES(?, ?, ?, 'file', ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, s.id, req.user.id, fixFileName(f.originalname).slice(0, 200), f.mimetype || '', ext, f.size, finalPath, now(), now());
    enqueue(id);
    created.push(id);
  }
  res.json({ ids: created });
});

router.get('/sessions/:id/attachments', (req, res) => {
  const s = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!s) return err(res, 404, '会话不存在');
  const docs = db.prepare('SELECT * FROM documents WHERE session_id = ? ORDER BY created_at DESC').all(s.id);
  res.json({ docs: docs.map(docRow) });
});

// —— 网络搜索工具 ——
async function webSearch(query){
  const tool = db.prepare('SELECT * FROM tools WHERE key = ?').get('web-search');
  if (!tool || !tool.enabled) return null;
  const config = JSON.parse(tool.config || '{}');
  const key = config.api_key || process.env.TAVILY_API_KEY || '';
  if (!key) return null;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: 5, search_depth: 'basic' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return (json.results || []).map(r => ({ title: r.title, url: r.url, content: r.content }));
  } catch { return null; }
}

// —— RAG 对话（SSE） ——
router.post('/sessions/:id/chat', async (req, res) => {
  const s = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!s) return err(res, 404, '会话不存在');
  const { message = '' } = req.body || {};
  const text = String(message).trim();
  if (!text) return err(res, 400, '消息不能为空');

  // G2：会话里的 agent_id 必须属于当前用户；已删除的智能体按旧行为回退到会话配置。
  let agent = null;
  if (s.agent_id){
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(s.agent_id);
    if (row && row.owner_id !== req.user.id) return err(res, 403, '无权使用该智能体');
    agent = row || null;
  }
  let kbIds = agent ? JSON.parse(agent.kb_ids || '[]') : JSON.parse(s.kb_ids || '[]');
  if (!agent && !kbIds.length) kbIds = visibleKbIds(req.user); // 未选择知识库时检索全部可见知识库
  const mode = s.mode === 'qa' ? 'qa' : 'reasoning';

  const chatModel = agent?.model
    ? (db.prepare('SELECT * FROM models WHERE id = ?').get(agent.model) || getModel('chat'))
    : (s.model ? db.prepare('SELECT * FROM models WHERE id = ?').get(s.model) : null) || getModel('chat');

  // 保存用户消息
  const uid = $uuid();
  db.prepare('INSERT INTO messages(id, session_id, role, content, created_at) VALUES(?,?,?,?,?)').run(uid, s.id, 'user', text, now());
  const isFirst = db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id = ? AND role = 'user'").get(s.id).c === 1;
  if (isFirst && (s.title === '新对话' || !s.title)){
    db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(trimTitle(text), s.id);
  }

  sseInit(res);
  let aborted = false;
  const abortStream = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded){ aborted = true; abortStream.abort(); }
  });
  const emit = o => { if (!aborted) sseSend(res, o); };

  try {
    // 1. 检索
    let refs = [];
    let webResults = null;
    const hasKbScope = kbIds.length > 0 || db.prepare("SELECT COUNT(*) c FROM documents WHERE session_id = ? AND status IN ('ready','processing','pending')").get(s.id).c > 0;
    if (hasKbScope){
      refs = await retrieve({ kbIds, sessionId: s.id, query: text, topK: 6 });
    }
    emit({ type: 'retrieved', count: refs.length });

    const agentTools = agent ? JSON.parse(agent.tools || '[]') : [];
    if (agentTools.includes('web-search')){
      webResults = await webSearch(text);
      emit({ type: 'web', count: webResults ? webResults.length : 0 });
    }

    // 工具箱上传的自定义工具：以 function calling 形式提供给模型
    const customTools = agent ? resolveAgentCustomTools(agentTools) : [];
    const openaiTools = customTools.map(t => {
      let params;
      try { params = JSON.parse(t.parameters || '{}'); } catch { params = { type: 'object', properties: {} }; }
      return { type: 'function', function: { name: toolFnName(t), description: `【${t.name}】${t.description}`, parameters: params } };
    });
    const toolByFnName = new Map(customTools.map((t, i) => [openaiTools[i].function.name, t]));

    // 2. 引用与思考摘要
    const refsOut = refs.map((r, i) => ({
      idx: i + 1, chunk_id: r.chunk_id, document_id: r.document_id,
      doc_name: r.doc_name, kb_name: r.kb_name, idx_in_doc: r.idx,
      score: Math.round(r.score * 1000) / 1000, snippet: r.content.slice(0, 160),
    }));

    const kbNames = [...new Set(refs.map(r => r.kb_name).filter(Boolean))];
    let think = refs.length || webResults
      ? `已检索 ${kbIds.length ? kbNames.length + ' 个知识库' : '会话附件'}${refs.length ? '，命中 ' + refs.length + ' 个片段' : ''}${webResults ? '，网络搜索到 ' + webResults.length + ' 条结果' : ''}。` +
        (refs.length ? `相似度最高的片段来自《${refs[0].doc_name}》。` : '')
      : '未从知识库检索到相关内容，将直接回答。';

    // 3. 组装 prompt（ContextBuilder 保持旧聊天提示词逐字兼容）
    const memories = db.prepare('SELECT content FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(req.user.id);
    const system = buildChatSystemPrompt({
      agentPrompt: agent?.system_prompt || '',
      mode,
      refs,
      webResults: webResults || [],
      memories,
    });

    const history = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 11').all(s.id).reverse();
    const llmMessages = [
      { role: 'system', content: system },
      ...history.filter(m => m.content).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    ];

    // 4. 生成回答
    let answer = '';
    if (!chatModel){
      if (refs.length){
        answer = '尚未配置对话模型，以下是从知识库中检索到的最相关片段：\n\n' +
          refs.slice(0, 3).map((r, i) => `**${i + 1}. 《${r.doc_name}》**\n> ${r.content.slice(0, 200).replace(/\n/g, '\n> ')}…`).join('\n\n') +
          '\n\n请在「系统设置 → 模型管理」中添加 OpenAI 兼容的对话模型，即可获得完整回答。';
      } else {
        answer = '尚未配置对话模型，且知识库中没有检索到相关内容。\n\n请先在「系统设置 → 模型管理」中添加模型，或向知识库上传文档后再提问。';
      }
      emit({ type: 'meta', think, refs: refsOut });
      emit({ type: 'delta', text: answer });
    } else {
      emit({ type: 'meta', think, refs: refsOut });
      try {
        // 模型—工具循环抽到 AgentRunner；旧聊天路径保持相同事件与轮次上限。
        await runAgentLoop({
          model: chatModel,
          messages: llmMessages,
          tools: openaiTools,
          temperature: mode === 'reasoning' ? 0.6 : 0.3,
          maxIterations: 6,
          signal: abortStream.signal,
          onDelta: part => { answer += part; emit({ type: 'delta', text: part }); },
          executeTool: async call => {
            const row = toolByFnName.get(call.name);
            if (!row) return null;
            emit({ type: 'tool', name: row.name, args: call.arguments });
            const result = await runCustomTool(row, call.arguments);
            emit({ type: 'tool_result', name: row.name, result: result.slice(0, 600) });
            think += `已调用工具「${row.name}」并获取结果。`;
            return result;
          },
        });
      } catch (e){
        if (!aborted){
          const msg = e.name === 'AbortError' ? null : '模型调用失败：' + e.message;
          if (msg){ emit({ type: 'error', message: msg }); }
        }
      }
    }

    // 5. 落库
    if (answer){
      const mid = $uuid();
      db.prepare('INSERT INTO messages(id, session_id, role, content, think, refs, created_at) VALUES(?,?,?,?,?,?,?)')
        .run(mid, s.id, 'assistant', answer, think, JSON.stringify(refsOut), now());
      db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now(), s.id);
      const saved = db.prepare('SELECT * FROM messages WHERE id = ?').get(mid);
      emit({ type: 'done', message: messageRow(saved) });
    } else {
      emit({ type: 'done', message: null });
    }
  } catch (e){
    emit({ type: 'error', message: e.message || '服务异常' });
  } finally {
    try { res.end(); } catch {}
  }
});

// —— 推荐问题 ——
const QUESTION_CACHE = { at: 0, items: [] };
router.get('/questions', async (req, res) => {
  if (Date.now() - QUESTION_CACHE.at < 10 * 60 * 1000 && QUESTION_CACHE.items.length){
    return res.json({ questions: QUESTION_CACHE.items });
  }
  const FALLBACK = [
    '知识库支持哪些文件格式？',
    '如何创建一个 FAQ 型知识库？',
    '如何为文档打标签并按类型筛选？',
    'RAG 检索是怎么工作的？',
    '如何把知识库共享给其他部门？',
    '智能体和普通问答模式有什么区别？',
  ];
  const chatModel = getModel('chat');
  if (!chatModel) return res.json({ questions: FALLBACK });
  try {
    const ids = visibleKbIds(req.user);
    const samples = ids.length
      ? db.prepare(`SELECT content FROM chunks WHERE kb_id IN (${ids.map(() => '?').join(',')}) ORDER BY RANDOM() LIMIT 8`).all(...ids)
      : [];
    if (!samples.length) return res.json({ questions: FALLBACK });
    const out = await chatOnce(chatModel, [
      { role: 'system', content: '根据知识库内容片段，生成 6 个用户可能想问的简短中文问题。每行一个，不要编号，不要解释。' },
      { role: 'user', content: samples.map(s => '- ' + s.content.slice(0, 120)).join('\n') },
    ], { temperature: 0.8 });
    const items = out.split('\n').map(l => l.replace(/^[\d.、\-\s]+/, '').trim()).filter(l => l && l.length <= 50).slice(0, 6);
    QUESTION_CACHE.at = Date.now();
    QUESTION_CACHE.items = items.length ? items : FALLBACK;
    res.json({ questions: QUESTION_CACHE.items });
  } catch { res.json({ questions: FALLBACK }); }
});

export default router;
