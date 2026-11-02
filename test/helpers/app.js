// 测试接缝：为每个测试文件创建独立的临时数据目录，动态导入 app 工厂并监听随机端口。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function startApp(env = {}){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-test-'));
  process.env.EKH_DATA_DIR = dir;
  process.env.EKH_ENABLE_DEMO_SEED = '0';
  for (const [key, value] of Object.entries(env)) process.env[key] = String(value);
  // 固定服务令牌，避免测试在临时目录生成/读取 data/service-token。
  if (!process.env.EKH_SERVICE_TOKEN) process.env.EKH_SERVICE_TOKEN = 'a'.repeat(64);

  const { createApp } = await import('../../server/app.js');
  const app = createApp();
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, url, { token, body, headers = {} } = {}){
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined){
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text, headers: res.headers };
  }

  async function register(email, name = '测试用户', password = 'password123'){
    const r = await request('POST', '/api/auth/register', { body: { email, name, password } });
    if (r.status !== 200) throw new Error(`注册失败 ${r.status}: ${r.text}`);
    return { token: r.data.token, user: r.data.user, email };
  }

  async function postSse(url, { token, body } = {}){
    const res = await fetch(base + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    const events = [];
    for (const block of text.split('\n\n')){
      for (const line of block.split('\n')){
        if (!line.startsWith('data:')) continue;
        try { events.push(JSON.parse(line.slice(5).trim())); } catch {}
      }
    }
    return { status: res.status, text, events };
  }

  async function waitFor(fn, { timeout = 5000, interval = 50 } = {}){
    const start = Date.now();
    while (Date.now() - start < timeout){
      const v = await fn();
      if (v) return v;
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error('waitFor 超时');
  }

  async function close(){
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { base, dir, request, register, postSse, waitFor, close };
}
