#!/usr/bin/env node
// 成果 blob GC：
//   node scripts/artifacts-gc.js            按配置宽限期清理无引用 blob
//   node scripts/artifacts-gc.js --dry-run  只统计，不删除
//   node scripts/artifacts-gc.js --grace-ms=0
import { config } from '../server/config.js';
import { closePool } from '../server/control/pg.js';
import { getArtifactService } from '../server/artifacts/service.js';

function argValue(args, name){
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main(){
  if (!config.databaseUrl){
    console.error('DATABASE_URL 未配置');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const rawGrace = argValue(args, 'grace-ms');
  const graceMs = rawGrace == null ? undefined : Number(rawGrace);
  if (graceMs != null && (!Number.isFinite(graceMs) || graceMs < 0)){
    console.error('--grace-ms 必须是非负数字');
    process.exit(1);
  }
  const stats = await getArtifactService().gc({
    ...(graceMs != null ? { graceMs } : {}),
    dryRun: args.includes('--dry-run'),
  });
  console.log(JSON.stringify(stats));
  await closePool();
}

main().catch(e => {
  console.error('[artifacts-gc] 失败', e);
  process.exit(1);
});
