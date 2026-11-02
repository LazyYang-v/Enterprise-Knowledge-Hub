#!/usr/bin/env node
// 任务 Worker CLI：
//   node scripts/worker.js            持续领取任务
//   node scripts/worker.js --once     领取并执行一个任务后退出
//   node scripts/worker.js --reap-only 只执行一次回收（过期租约/退避/超时）
import os from 'node:os';
import { config } from '../server/config.js';
import { closePool } from '../server/control/pg.js';
import { TaskWorker } from '../server/control/worker.js';
import { TaskService } from '../server/control/task-service.js';
import { modelFromEnv, resolveTaskModel } from '../server/control/model-resolver.js';

export { modelFromEnv };

export function optionsFromEnv(env = process.env){
  const num = (key, fallback) => {
    const v = Number(env[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    leaseTtlMs: num('EKH_WORKER_LEASE_TTL_MS', 60000),
    heartbeatIntervalMs: num('EKH_WORKER_HEARTBEAT_MS', 20000),
    reaperIntervalMs: num('EKH_WORKER_REAPER_MS', 15000),
    pollIntervalMs: num('EKH_WORKER_POLL_MS', 1000),
    retryBaseMs: num('EKH_TASK_RETRY_BASE_MS', 5000),
    maxRetryDelayMs: num('EKH_TASK_RETRY_MAX_MS', 45000),
    shutdownGraceMs: num('EKH_WORKER_SHUTDOWN_GRACE_MS', 10000),
  };
}

async function main(){
  if (!config.databaseUrl){
    console.error('DATABASE_URL 未配置');
    process.exit(1);
  }
  const args = new Set(process.argv.slice(2));
  const workerId = process.env.EKH_WORKER_ID || `worker-${os.hostname()}-${process.pid}`;
  const log = msg => console.log(`[worker ${workerId}] ${msg}`);

  if (args.has('--reap-only')){
    const service = new TaskService();
    const stats = await service.reapExpired({ workerId });
    console.log(JSON.stringify(stats));
    await closePool();
    return;
  }

  const worker = new TaskWorker({
    workerId,
    modelResolver: task => resolveTaskModel(task),
    log,
    // 惰性加载：只有带知识范围/Skill 的任务才会触碰 SQLite 与 Skill 仓储。
    knowledgeFactory: async () => (await import('../server/knowledge/index.js')).getKnowledgeService(),
    skillLoader: async ref => (await import('../server/skills/index.js')).loadSkillInstructions(ref),
    toolFactory: async ({ task, knowledge, signal }) => {
      const { createToolExecutor } = await import('../server/tools/executor.js');
      return createToolExecutor({ task, knowledge, signal });
    },
    ...optionsFromEnv(),
  });
  if (!modelFromEnv()) log('未配置 EKH_AGENT_MODEL_* 或 preset model_profile，领取到任务后会以 model_unavailable 失败');

  if (args.has('--once')){
    await worker.runOnce();
    await closePool();
    return;
  }

  await worker.start();
  const shutdown = async signal => {
    log(`收到 ${signal}，开始优雅停机`);
    await worker.stop();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(e => {
  console.error('[worker] 启动失败', e);
  process.exit(1);
});
