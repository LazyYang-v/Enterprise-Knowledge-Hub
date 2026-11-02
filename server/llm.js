// OpenAI 兼容协议客户端：对话补全（流式）与向量嵌入
import { defaultModel } from './db.js';

function headers(m){
  const h = { 'Content-Type': 'application/json' };
  if (m.api_key) h['Authorization'] = `Bearer ${m.api_key}`;
  return h;
}

// 规整接口地址：容错用户直接粘贴完整端点（…/chat/completions、…/embeddings 等）
export function normalizeBaseUrl(url){
  return String(url).trim().replace(/\/+$/, '').replace(/\/(chat\/completions|embeddings|embedding|rerank)$/, '');
}

export async function* streamChat(model, messages, { temperature = 0.7, signal, tools } = {}){
  const base = normalizeBaseUrl(model.base_url);
  const body = { model: model.model_name, messages, temperature, stream: true };
  if (tools && tools.length) body.tools = tools;
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: headers(model),
    signal,
    body: JSON.stringify(body),
  });
  if (!res.ok){
    const text = await res.text().catch(() => '');
    throw new Error(`模型请求失败 (${res.status})：${text.slice(0, 300) || res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pendingCalls = new Map();
  let hasCalls = false;
  outer: while (true){
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines){
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') break outer;
      try {
        const json = JSON.parse(payload);
        const d = json.choices?.[0]?.delta || {};
        const reasoning = d.reasoning_content;
        if (reasoning) yield { reasoning };
        if (d.content) yield { text: d.content };
        if (Array.isArray(d.tool_calls)){
          hasCalls = true;
          for (const c of d.tool_calls){
            const idx = c.index ?? 0;
            const cur = pendingCalls.get(idx) || { id: '', name: '', arguments: '' };
            if (c.id) cur.id = c.id;
            if (c.function?.name && !cur.name) cur.name = c.function.name;
            if (c.function?.arguments) cur.arguments += c.function.arguments;
            pendingCalls.set(idx, cur);
          }
        }
      } catch {}
    }
  }
  if (hasCalls){
    yield { toolCalls: [...pendingCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).filter(c => c.name) };
  }
}

export async function chatOnce(model, messages, { temperature = 0.3, signal } = {}){
  const base = normalizeBaseUrl(model.base_url);
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: headers(model),
    signal,
    body: JSON.stringify({ model: model.model_name, messages, temperature }),
  });
  if (!res.ok) throw new Error(`模型请求失败 (${res.status})`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

export async function embed(model, texts){
  const base = normalizeBaseUrl(model.base_url);
  const out = [];
  const BATCH = 16;
  for (let i = 0; i < texts.length; i += BATCH){
    const slice = texts.slice(i, i + BATCH);
    const res = await fetch(base + '/embeddings', {
      method: 'POST',
      headers: headers(model),
      body: JSON.stringify({ model: model.model_name, input: slice }),
    });
    if (!res.ok) throw new Error(`Embedding 请求失败 (${res.status})`);
    const json = await res.json();
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    for (const d of sorted) out.push(d.embedding);
  }
  return out;
}

// 取指定类型的默认模型；没有配置时返回 null
export function getModel(kind){ return defaultModel(kind); }

export function cosine(a, b){
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++){ dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
