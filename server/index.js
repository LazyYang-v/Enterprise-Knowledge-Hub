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
