// 模型 profile API（PlatformAdmin）。凭证只写不读，响应仅返回是否已配置。
import { Router } from 'express';
import { authRequired } from '../auth.js';
import { config } from '../config.js';
import { err } from '../util.js';
import { isPlatformAdmin } from '../auth/admin.js';
import { resolveTenantId } from '../control/tenants.js';
import { auditSafe } from '../control/audit-repo.js';
import {
  listModelProfiles, getModelProfile, createModelProfile, updateModelProfile,
  deleteModelProfile, ModelProfileError, toSafeModelProfile,
} from '../control/model-profile-repo.js';
import { resolveCredentialRef } from '../control/credentials.js';
import { chatOnce } from '../llm.js';

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

function fail(res, e){
  if (e instanceof ModelProfileError) return err(res, e.status, e.message);
  console.error('[model-profiles]', e);
  return err(res, 500, '模型配置操作失败');
}

router.get('/', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    res.json({ profiles: await listModelProfiles(tenantId) });
  } catch (e){ fail(res, e); }
});

router.post('/', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const b = req.body || {};
    const profile = await createModelProfile({
      tenantId, name: b.name, provider: b.provider, baseUrl: b.base_url,
      modelName: b.model_name, credentialRef: b.credential_ref,
      capabilities: b.capabilities, contextWindow: b.context_window, enabled: b.enabled !== false,
    });
    await auditSafe({
      tenantId, actorType: 'user', actorId: req.user.id, action: 'model_profile.created',
      resourceType: 'model_profile', resourceId: profile.id, decision: 'allowed',
      detail: { name: profile.name, model_name: profile.model_name, credential_configured: profile.credential_configured },
    });
    res.status(201).json({ profile });
  } catch (e){ fail(res, e); }
});

router.get('/:id', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const row = await getModelProfile({ tenantId, id: req.params.id });
    if (!row) return err(res, 404, '模型配置不存在');
    res.json({ profile: toSafeModelProfile(row) });
  } catch (e){ fail(res, e); }
});

router.patch('/:id', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const b = req.body || {};
    const profile = await updateModelProfile({
      tenantId, id: req.params.id,
      patch: {
        ...(b.name != null ? { name: b.name } : {}),
        ...(b.provider != null ? { provider: b.provider } : {}),
        ...(b.base_url != null ? { base_url: b.base_url } : {}),
        ...(b.model_name != null ? { model_name: b.model_name } : {}),
        ...(b.credential_ref != null ? { credential_ref: b.credential_ref } : {}),
        ...(b.capabilities != null ? { capabilities: b.capabilities } : {}),
        ...(b.context_window !== undefined ? { context_window: b.context_window } : {}),
        ...(b.enabled != null ? { enabled: !!b.enabled } : {}),
      },
    });
    if (!profile) return err(res, 404, '模型配置不存在');
    await auditSafe({
      tenantId, actorType: 'user', actorId: req.user.id, action: 'model_profile.updated',
      resourceType: 'model_profile', resourceId: profile.id, decision: 'allowed',
      detail: { name: profile.name, enabled: profile.enabled },
    });
    res.json({ profile });
  } catch (e){ fail(res, e); }
});

router.delete('/:id', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const ok = await deleteModelProfile({ tenantId, id: req.params.id });
    if (!ok) return err(res, 404, '模型配置不存在');
    await auditSafe({
      tenantId, actorType: 'user', actorId: req.user.id, action: 'model_profile.deleted',
      resourceType: 'model_profile', resourceId: req.params.id, decision: 'allowed',
    });
    res.json({ ok: true });
  } catch (e){ fail(res, e); }
});

router.post('/:id/test', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const row = await getModelProfile({ tenantId, id: req.params.id });
    if (!row) return err(res, 404, '模型配置不存在');
    let apiKey = '';
    try { apiKey = resolveCredentialRef(row.credential_ref); }
    catch (e){ return res.json({ ok: false, message: e.message }); }
    const reply = await chatOnce({
      base_url: row.base_url, model_name: row.model_name, api_key: apiKey,
    }, [{ role: 'user', content: '你好' }], {
      temperature: 0, signal: AbortSignal.timeout(15000),
    });
    res.json({ ok: true, message: String(reply || '').slice(0, 200) });
  } catch (e){
    res.json({ ok: false, message: String(e?.message || '连接失败').slice(0, 300) });
  }
});

export default router;
