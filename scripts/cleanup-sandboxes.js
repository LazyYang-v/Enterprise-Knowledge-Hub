#!/usr/bin/env node
// 清理残留的自定义工具沙箱容器：只处理 label ekh.sandbox=1 的容器。
// 默认只列出；--force 才删除。--older-than-min=N 控制最小存活时长。
import { spawnSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const olderArg = [...args].find(a => a.startsWith('--older-than-min='));
const olderThanMin = Math.max(0, Number(olderArg?.split('=')[1] || 60));

const bin = process.env.EKH_SANDBOX_DOCKER_BIN || 'docker';
const ps = spawnSync(bin, [
  'ps', '-a', '--filter', 'label=ekh.sandbox=1',
  '--format', '{{.ID}}\t{{.Names}}\t{{.RunningFor}}\t{{.Status}}',
], { encoding: 'utf8', timeout: 10000 });

if (ps.error){
  console.error(`[sandbox-cleanup] docker 不可用：${ps.error.message}`);
  process.exit(1);
}
if (ps.status !== 0){
  console.error(ps.stderr || `docker ps 退出码 ${ps.status}`);
  process.exit(1);
}
const lines = ps.stdout.split('\n').map(l => l.trim()).filter(Boolean);
if (!lines.length){
  console.log('[sandbox-cleanup] 没有发现 ekh.sandbox=1 容器');
  process.exit(0);
}

// docker ps 的 RunningFor 是自然语言，这里以容器创建时间做粗略过滤。
const nowSeconds = Math.floor(Date.now() / 1000);
const inspect = spawnSync(bin, [
  'inspect', '--format', '{{.Id}}\t{{.Created}}', ...lines.map(l => l.split('\t')[0]),
], { encoding: 'utf8', timeout: 10000 });
const created = new Map();
if (inspect.status === 0){
  for (const line of inspect.stdout.split('\n')){
    const [id, iso] = line.trim().split('\t');
    if (id && iso) created.set(id.slice(0, 12), Date.parse(iso) / 1000);
  }
}

let removed = 0;
for (const line of lines){
  const [id, name, runningFor, status] = line.split('\t');
  const createdSec = created.get(String(id).slice(0, 12));
  const ageMin = createdSec ? (nowSeconds - createdSec) / 60 : Number.NaN;
  if (Number.isFinite(ageMin) && ageMin < olderThanMin){
    console.log(`[keep] ${name || id} age=${ageMin.toFixed(0)}m status=${status}`);
    continue;
  }
  if (!force){
    console.log(`[dry-run] ${name || id} running=${runningFor} status=${status}`);
    continue;
  }
  const rm = spawnSync(bin, ['rm', '-f', id], { encoding: 'utf8', timeout: 15000 });
  if (rm.status === 0) removed += 1;
  else console.error(`[fail] ${name || id}: ${rm.stderr || rm.status}`);
}
if (!force) console.log('[sandbox-cleanup] 未删除任何容器（使用 --force 执行）');
else console.log(`[sandbox-cleanup] 已删除 ${removed} 个容器`);
