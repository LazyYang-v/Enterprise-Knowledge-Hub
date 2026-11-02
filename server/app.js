// Express 应用装配：只构建 app，不监听端口、不初始化演示数据。
// 便于测试导入（P0-0 测试接缝）。
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from './db.js';
import authRoutes from './auth.js';
import kbRoutes from './routes/kbs.js';
import chatRoutes from './routes/chat.js';
import agentRoutes from './routes/agents.js';
import orgRoutes from './routes/orgs.js';
import miscRoutes from './routes/misc.js';
import retrieveRoutes from './routes/retrieve.js';
import taskRoutes, { approvalsRouter } from './routes/tasks.js';
import taskArtifactRoutes from './routes/task-artifacts.js';
import knowledgeRoutes from './routes/knowledge.js';
import skillRoutes from './routes/skills.js';
import toolRegistryRoutes from './routes/tool-registry.js';
import mcpConnectionRoutes from './routes/mcp-connections.js';
import modelProfileRoutes from './routes/model-profiles.js';
import servicePrincipalRoutes from './routes/service-principals.js';
import { mcpHandler } from './mcp.js';

export function createApp(){
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  app.get('/health', (req, res) => res.json({ ok: true, name: 'Enterprise Knowledge Hub', time: new Date().toISOString() }));

  app.use('/api/auth', authRoutes);
  app.use('/api', retrieveRoutes);
  // retrieve 必须先挂载：其余路由的 router.use(authRequired) 会先拦截服务令牌请求。
  app.use('/api', kbRoutes);
  app.use('/api', chatRoutes);
  app.use('/api', agentRoutes);
  app.use('/api', orgRoutes);
  // P0-4 新 API 必须先于旧 /api/tools 工具箱挂载。
  app.use('/api/tools/registry', toolRegistryRoutes);
  app.use('/api/mcp/connections', mcpConnectionRoutes);
  app.use('/api/model-profiles', modelProfileRoutes);
  app.use('/api/service-principals', servicePrincipalRoutes);
  app.use('/api', miscRoutes);
  // Agent 平台任务 API：默认关闭，通过 AGENT_PLATFORM_ENABLED=1 启用。
  app.use('/api/tasks', taskRoutes);
  app.use('/api/approvals', approvalsRouter);
  app.use('/api/task-artifacts', taskArtifactRoutes);
  // 知识 API 同样受 AGENT_PLATFORM_ENABLED 控制（router 内部返回 404）。
  app.use('/api/knowledge', knowledgeRoutes);
  app.use('/api', skillRoutes);

  // MCP Streamable HTTP 端点（服务令牌鉴权），供 DeepSeek Harness mcp-client 接入。
  app.post('/mcp', mcpHandler);

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

  return app;
}
