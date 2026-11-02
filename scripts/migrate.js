#!/usr/bin/env node
// 迁移 CLI：npm run db:migrate / db:migrate:dry / db:status
import { config } from '../server/config.js';
import { migrate, status } from '../server/control/migrate.js';

const args = process.argv.slice(2);
const command = args.find(a => !a.startsWith('-')) || 'up';
const dryRun = args.includes('--dry-run');
const connectionString = process.env.DATABASE_URL || config.databaseUrl;

if (!connectionString){
  console.error('缺少 DATABASE_URL。示例：');
  console.error('  docker compose up -d postgres');
  console.error('  DATABASE_URL=postgres://ekh:ekh_dev_password@127.0.0.1:55432/ekh npm run db:migrate');
  process.exit(1);
}

try {
  if (command === 'status'){
    const s = await status({ connectionString });
    console.log('已执行：', s.applied.length ? s.applied.join(', ') : '(无)');
    console.log('待执行：', s.pending.length ? s.pending.join(', ') : '(无)');
    if (s.unknown.length) console.log('记录中存在但文件已删除：', s.unknown.join(', '));
  } else if (command === 'up'){
    const r = await migrate({ connectionString, dryRun });
    console.log(`完成：执行 ${r.applied.length} 个，跳过 ${r.skipped.length} 个，待执行 ${r.pending.length} 个。`);
  } else {
    console.error(`未知命令：${command}（可用：up、status）`);
    process.exit(2);
  }
} catch (e){
  console.error('迁移失败：' + (e.message || e));
  process.exit(1);
}
