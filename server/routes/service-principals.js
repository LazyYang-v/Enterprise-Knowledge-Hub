// 服务主体管理（PlatformAdmin）。明文 token 仅在创建/轮换响应中出现一次。
import { Router } from 'express';
import { authRequired } from '../auth.js';
import { config } from '../config.js';
import { err } from '../util.js';
import { isPlatformAdmin } from '../auth/admin.js';
import { resolveTenantId } from '../control/tenants.js';
import { auditSafe } from '../control/audit-repo.js';
import {
  createServicePrincipal, listServicePrincipals, getServicePrincipal,
  revokeServicePrincipal, rotateServicePrincipal,
} from '../control/service-principal-repo.js';

const router = Router();

router.use((req, res, next) => {
  if (!config.agentPlatformEnabled) return err(res, 404, '接口不存在');
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return err(res, 401, '需要 Bearer 令牌');
  next();
});
router.use(authRequired);
router.use((req, res, next) => {
  if (!isPlatformAdmin(req.user)) return err(res, 403, '需要平台管理员权限');
  next();
});

function normalizeScopes(raw){
  if (raw == null) return { all_kbs: false, kb_ids: [], tools: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('scopes 必须是对象');
  return {
    all_kbs: !!raw.all_kbs,
    kb_ids: Array.isArray(raw.kb_ids) ? [...new Set(raw.kb_ids.map(String).filter(Boolean))] : [],
    tools: Array.isArray(raw.tools) ? [...new Set(raw.tools.map(String).filter(Boolean))] : [],
  };
}

function parseExpiry(value){
  if (value == null || value === '') return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= Date.now()) throw new Error('expires_at 必须是未来时间');
  return d;
}

router.get('/', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    res.json({ principals: await listServicePrincipals(tenantId) });
  } catch (e){
    console.error('[service-principals]', e);
    err(res, 500, '服务主体读取失败');
  }
});

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return err(res, 400, 'name 不能为空');
    const scopes = normalizeScopes(b.scopes);
    const expiresAt = parseExpiry(b.expires_at);
    const tenantId = await resolveTenantId(req.user.id);
    const { principal, token } = await createServicePrincipal({
      tenantId, name: String(b.name).trim().slice(0, 120),
      scopes, expiresAt, createdBy: req.user.id,
    });
    await auditSafe({
      tenantId, actorType: 'user', actorId: req.user.id, action: 'service_principal.created',
      resourceType: 'service_principal', resourceId: principal.id, decision: 'allowed',
      detail: { name: principal.name, all_kbs: scopes.all_kbs, kb_count: scopes.kb_ids.length, tools: scopes.tools },
    });
    res.status(201).json({ principal, token });
  } catch (e){
    if (/scopes|expires_at/.test(e.message)) return err(res, 400, e.message);
    console.error('[service-principals]', e);
    err(res, 500, '服务主体创建失败');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const principal = await getServicePrincipal({ tenantId, id: req.params.id });
    if (!principal) return err(res, 404, '服务主体不存在');
    res.json({ principal });
  } catch (e){
    console.error('[service-principals]', e);
    err(res, 500, '服务主体读取失败');
  }
});

router.post('/:id/rotate', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const rotated = await rotateServicePrincipal({ tenantId, id: req.params.id });
    if (!rotated) return err(res, 404, '服务主体不存在');
    await auditSafe({
      tenantId, actorType: 'user', actorId: req.user.id, action: 'service_principal.rotated',
      resourceType: 'service_principal', resourceId: req.params.id, decision: 'allowed',
    });
    res.json(rotated);
  } catch (e){
    console.error('[service-principals]', e);
    err(res, 500, '服务主体轮换失败');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const revoked = await revokeServicePrincipal({ tenantId, id: req.params.id });
    if (!revoked) return err(res, 404, '服务主体不存在');
    await auditSafe({
      tenantId, actorType: 'user', actorId: req.user.id, action: 'service_principal.revoked',
      resourceType: 'service_principal', resourceId: req.params.id, decision: 'allowed',
    });
    res.json({ principal: revoked });
  } catch (e){
    console.error('[service-principals]', e);
    err(res, 500, '服务主体吊销失败');
  }
});

export default router;
