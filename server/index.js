// 进程入口：初始化演示数据（受环境限制）并监听端口。
import { createApp } from './app.js';
import { config } from './config.js';
import { seedIfEnabled } from './bootstrap.js';

const seeded = seedIfEnabled();
const app = createApp();

const server = app.listen(config.port, () => {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : config.port;
  console.log(`\n  企业知识库已启动：http://localhost:${port}\n`);
  if (seeded){
    console.log('  演示账号：lzy@example.com / password\n');
  } else if (config.isProduction){
    console.log('  生产模式：未创建演示账号\n');
  }
});

// Agent 平台：启动时异步加载平台级 Skill，失败不阻塞 Web 服务。
if (config.agentPlatformEnabled && config.databaseUrl){
  import('./skills/index.js')
    .then(m => m.bootstrapSkills())
    .then(result => {
      if (result.errors.length){
        console.error('[skills] 加载完成但有错误：', JSON.stringify(result.errors));
      } else {
        console.log(`[skills] 已加载 ${result.loaded} 个 Skill`);
      }
    })
    .catch(e => console.error('[skills] 初始化失败：', e.message));
}
