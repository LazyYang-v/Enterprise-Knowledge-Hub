// 演示数据初始化开关：生产环境一律跳过（P0-0 G7）。
import { config } from './config.js';
import { seed } from './db.js';
import { seedDemo } from './seed-demo.js';

export function seedIfEnabled(){
  if (!config.demoSeedEnabled){
    if (config.isProduction) console.warn('[seed] 生产模式已跳过演示数据初始化（G7）');
    return false;
  }
  seed();
  seedDemo();
  return true;
}
