// per-tenant 固定窗口限流：PostgreSQL 原子计数，多实例一致。
// 默认 fail-closed：数据库不可用时拒绝请求；EKH_RATE_LIMIT_FAIL_OPEN=1 可显式降级。
import { config } from '../config.js';
import { getPool } from './pg.js';
import { auditSafe } from './audit-repo.js';

export const RATE_BUCKETS = Object.freeze(['task_create', 'model_call', 'tool_call']);

const DEFAULTS = Object.freeze({
  task_create: () => config.rateLimits.taskCreate,
  model_call: () => config.rateLimits.modelCall,
  tool_call: () => config.rateLimits.toolCall,
});

export class RateLimitExceededError extends Error {
  constructor({ bucket, limit, retryAfterSeconds }){
    super(`请求过于频繁（${bucket}），请稍后重试`);
    this.name = 'RateLimitExceededError';
    this.code = 'rate_limited';
    this.status = 429;
    this.retryable = true;
    this.bucket = bucket;
    this.limit = limit;
    this.retry_after_seconds = Math.max(1, Math.ceil(retryAfterSeconds || 1));
  }
}

export class RateLimitUnavailableError extends Error {
  constructor(message = '限流服务不可用'){
    super(message);
    this.name = 'RateLimitUnavailableError';
    this.code = 'rate_limit_unavailable';
    this.status = 503;
    this.retryable = true;
  }
}

function bucketDefaults(bucket){
  const fn = DEFAULTS[bucket];
  if (!fn) throw new TypeError(`未知限流桶：${bucket}`);
  return fn();
}

async function bucketSettings(tenantId, bucket){
  const fallback = bucketDefaults(bucket);
  try {
    const r = await getPool().query(
      'SELECT max_requests, window_ms FROM tenant_rate_limits WHERE tenant_id = $1 AND bucket = $2',
      [tenantId, bucket],
    );
    const row = r.rows[0];
    return {
      limit: Number(row?.max_requests) > 0 ? Number(row.max_requests) : fallback.limit,
      windowMs: Number(row?.window_ms) >= 1000 ? Number(row.window_ms) : fallback.windowMs,
    };
  } catch {
    // 覆盖表读取失败沿用默认值；真正的可用性由计数查询决定。
    return fallback;
  }
}

/**
 * 原子消费一次配额。
 * @returns {{allowed:boolean,limit:number,remaining:number,retry_after_seconds:number,count:number,window_start:string}}
 */
export async function consumeTenantRate({ tenantId, bucket }){
  if (!RATE_BUCKETS.includes(bucket)) throw new TypeError(`未知限流桶：${bucket}`);
  const { limit, windowMs } = await bucketSettings(tenantId, bucket);
  const r = await getPool().query(
    `INSERT INTO rate_limit_counters (tenant_id, bucket, window_start, count)
     VALUES (
       $1, $2,
       to_timestamp(floor(extract(epoch from clock_timestamp()) * 1000 / $3::numeric) * $3::numeric / 1000),
       1
     )
     ON CONFLICT (tenant_id, bucket, window_start)
     DO UPDATE SET count = rate_limit_counters.count + 1
     RETURNING count, window_start`,
    [tenantId, bucket, windowMs],
  );
  const count = Number(r.rows[0].count);
  const windowStartMs = new Date(r.rows[0].window_start).getTime();
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStartMs + windowMs - Date.now()) / 1000));
  return {
    allowed: count <= limit,
    limit,
    count,
    remaining: Math.max(0, limit - count),
    retry_after_seconds: count <= limit ? 0 : retryAfterSeconds,
    window_start: new Date(windowStartMs).toISOString(),
  };
}

/**
 * 消费配额；超限抛 RateLimitExceededError，数据库故障默认抛 RateLimitUnavailableError。
 * 审计只记录桶/限额/重试时间，不记录请求正文。
 */
export async function enforceTenantRate({ tenantId, bucket, actorId = null, actorType = 'user', audit = true }){
  if (!config.rateLimits.enabled) return { allowed: true, disabled: true, remaining: null };
  let result;
  try {
    result = await consumeTenantRate({ tenantId, bucket });
  } catch (e){
    if (config.rateLimits.failOpen){
      if (audit){
        await auditSafe({
          tenantId, actorType, actorId, action: 'rate_limit.unavailable',
          resourceType: 'tenant', resourceId: tenantId, decision: 'degraded',
          detail: { bucket, fail_open: true },
        }).catch(() => {});
      }
      return { allowed: true, degraded: true, remaining: null };
    }
    throw new RateLimitUnavailableError(`限流服务不可用：${String(e?.code || e?.message || e).slice(0, 120)}`);
  }
  if (!result.allowed){
    if (audit){
      await auditSafe({
        tenantId, actorType, actorId, action: 'rate_limit.exceeded',
        resourceType: 'tenant', resourceId: tenantId, decision: 'denied',
        detail: {
          bucket, limit: result.limit, count: result.count,
          retry_after_seconds: result.retry_after_seconds,
        },
      }).catch(() => {});
    }
    throw new RateLimitExceededError({
      bucket, limit: result.limit, retryAfterSeconds: result.retry_after_seconds,
    });
  }
  return result;
}

/** Express 中间件：要求前置中间件已把租户解析到 req.tenantId。 */
export function tenantRateLimit(bucket){
  return async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      if (!tenantId) throw new RateLimitUnavailableError('缺少租户上下文');
      const result = await enforceTenantRate({
        tenantId, bucket, actorId: req.user?.id || null,
      });
      if (result.retry_after_seconds){
        res.set('Retry-After', String(result.retry_after_seconds));
      }
      res.set('X-RateLimit-Limit', String(result.limit ?? ''));
      res.set('X-RateLimit-Remaining', String(result.remaining ?? ''));
      next();
    } catch (e){
      if (e?.status === 429 && e.retry_after_seconds){
        res.set('Retry-After', String(e.retry_after_seconds));
      }
      next(e);
    }
  };
}

export async function cleanupRateLimitCounters({ retentionMs = config.rateLimits.retentionMs } = {}){
  const r = await getPool().query(
    `DELETE FROM rate_limit_counters
      WHERE window_start < now() - ($1::bigint * interval '1 millisecond')`,
    [Math.max(60000, Number(retentionMs) || 600000)],
  );
  return r.rowCount || 0;
}
