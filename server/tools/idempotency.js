// provider 幂等键：跨 Worker 恢复稳定，不含明文参数。
// 键刻意不含 step_id：Worker 崩溃后 Reaper 会关闭旧 step，新领取从新 step 重试，
// 只有 (tenant, task, tool, args) 才能保证同一外部写复用同一去重键。
import crypto from 'node:crypto';

export function providerIdempotencyKey({ tenantId, taskId, toolName, argsHash }){
  for (const [name, value] of Object.entries({ tenantId, taskId, toolName, argsHash })){
    if (value == null || String(value) === '') throw new TypeError(`providerIdempotencyKey 缺少 ${name}`);
  }
  return crypto.createHash('sha256')
    .update(`p0:provider:${tenantId}:${taskId}:${toolName}:${argsHash}`)
    .digest('hex');
}
