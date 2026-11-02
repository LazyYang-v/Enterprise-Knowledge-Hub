// 审计日志：只追加，不写全文/密钥；调用方负责 best-effort 兜底。
import { getPool } from './pg.js';

export async function writeAudit({
  tenantId = null, actorType = 'system', actorId = null, action, resourceType = '',
  resourceId = '', decision = '', ip = null, userAgent = null, detail = {},
} = {}){
  if (!action) throw new Error('audit action 不能为空');
  await getPool().query(
    `INSERT INTO audit_log
       (tenant_id, actor_type, actor_id, action, resource_type, resource_id, decision, ip, user_agent, detail_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [tenantId, String(actorType), actorId ? String(actorId) : null, String(action),
      String(resourceType || ''), String(resourceId || ''), String(decision || ''),
      ip, userAgent, JSON.stringify(detail || {})],
  );
}

/** 审计失败不影响主流程；detail 由调用方限制为 ID/哈希/决策，禁止写入全文与密钥。 */
export async function auditSafe(args){
  try {
    await writeAudit(args);
  } catch (e){
    console.error('[audit]', e?.message || e);
  }
}
