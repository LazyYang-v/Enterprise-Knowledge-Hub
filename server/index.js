import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from './db.js';
import { seed } from './db.js';
import { seedDemo } from './seed-demo.js';
import authRoutes, { authRequired } from './auth.js';
import kbRoutes from './routes/kbs.js';
import chatRoutes from './routes/chat.js';
import agentRoutes from './routes/agents.js';
import orgRoutes from './routes/orgs.js';
import miscRoutes from './routes/misc.js';

seed();
seedDemo();

const app = express();
app.use(express.json({ limit: '20mb' }));

app.get('/health', (req, res) => res.json({ ok: true, name: 'Enterprise Knowledge Hub', time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api', kbRoutes);
app.use('/api', chatRoutes);
app.use('/api', agentRoutes);
app.use('/api', orgRoutes);
app.use('/api', miscRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// 静态前端
const PUBLIC_DIR = path.join(ROOT, 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api\/).*/, (req, res) => {
  const index = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send('前端资源缺失：public/index.html');
});

// 全局错误兜底
app.use((e, req, res, next) => {
  console.error('[server]', e);
  if (res.headersSent) return;
  res.status(500).json({ error: e.message || '服务器内部错误' });
});

const PORT = Number(process.env.PORT || 3210);
app.listen(PORT, () => {
  console.log(`\n  企业知识库已启动：http://localhost:${PORT}\n  演示账号：lzy@example.com / password\n`);
});
