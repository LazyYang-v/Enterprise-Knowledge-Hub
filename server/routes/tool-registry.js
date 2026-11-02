// 工具注册表 API（P0-4）。旧 /api/tools 工具箱保持不变；注册表走 /api/tools/registry。
import { Router } from 'express';
import { authRequired } from '../auth.js';
import { config } from '../config.js';
import { err } from '../util.js';
import { isAdminUser } from '../auth/admin.js';
import { resolveTenantId } from '../control/tenants.js';
import { auditSafe } from '../control/audit-repo.js';
import { listForUser, descriptorForCustom } from '../tools/registry.js';
import {
  listToolPolicies, upsertToolPolicy, deleteToolPolicy, setToolRegistryEnabled, upsertToolRegistry,
} from '../control/tool-registry-repo.js';
import { getCustomTool, setCustomToolEnabled } from '../tools/custom-tools-repo.js';

const router = Router();

router.use((req, res, next) => {
  if (!config.agentPlatformEnabled) return err(res, 404, '接口不存在');
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return err(res, 401, '需要 Bearer 令牌');
  next();
});
router.use(authRequired);

router.get('/', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const admin = isAdminUser(req.user);
    const includeDisabled = admin && ['1', 'true', 'yes'].includes(String(req.query.include_disabled || '').toLowerCase());
    const tools = await listForUser({
      tenantId, userId: req.user.id, isAdmin: admin, includeDisabled,
    });
    res.json({ tools });
  } catch (e){
    console.error('[tool-registry]', e);
    err(res, 500, '工具注册表读取失败');
  }
});

router.get('/:name', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const tools = await listForUser({
      tenantId, userId: req.user.id, isAdmin: isAdminUser(req.user),
    });
    const tool = tools.find(t => t.name === req.params.name);
    if (!tool) return err(res, 404, '工具不存在');
    res.json({ tool });
  } catch (e){
    console.error('[tool-registry]', e);
    err(res, 500, '工具注册表读取失败');
  }
});

router.patch('/:name/policy', async (req, res) => {
  if (!isAdminUser(req.user)) return err(res, 403, '需要管理员权限');
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const b = req.body || {};
    const principalType = String(b.principal_type || 'user');
    if (!['user', 'role', 'preset', 'tenant'].includes(principalType)){
      return err(res, 400, 'principal_type 不合法');
    }
    const principalId = b.principal_id != null
      ? String(b.principal_id)
      : (principalType === 'tenant' ? tenantId : principalType === 'user' ? req.user.id : '');
    if (!principalId) return err(res, 400, 'principal_id 不能为空');
    if (b.approval_mode != null && !['never', 'risk_based', 'always'].includes(b.approval_mode)){
      return err(res, 400, 'approval_mode 不合法');
    }
    if (b.max_calls_per_task != null && (!Number.isInteger(b.max_calls_per_task) || b.max_calls_per_task < 0)){
      return err(res, 400, 'max_calls_per_task 必须是非负整数');
    }
    if (b.allowed_scopes != null && !Array.isArray(b.allowed_scopes)){
      return err(res, 400, 'allowed_scopes 必须是数组');
    }
    const policy = await upsertToolPolicy({
      tenantId, toolName: req.params.name, principalType, principalId,
      approvalMode: b.approval_mode || 'risk_based',
      maxCallsPerTask: b.max_calls_per_task ?? null,
      allowedScopes: b.allowed_scopes || [],
      enabled: b.enabled !== false,
    });
    await auditSafe({
      tenantId, actorType: 'user', actorId: req.user.id, action: 'tool.policy.updated',
      resourceType: 'tool_policy', resourceId: String(policy.id), decision: 'allowed',
      detail: {
        tool_name: req.params.name, principal_type: principalType, principal_id: principalId,
        approval_mode: policy.approval_mode, enabled: policy.enabled,
        max_calls_per_task: policy.max_calls_per_task,
      },
    });
    res.json({ policy });
  } catch (e){
    console.error('[tool-registry]', e);
    err(res, 500, '工具策略写入失败');
  }
});

router.patch('/:name/enabled', async (req, res) => {
  if (!isAdminUser(req.user)) return err(res, 403, '需要管理员权限');
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return err(res, 400, 'enabled 必须是布尔值');
  const name = String(req.params.name);
  try {
    const tenantId = await resolveTenantId(req.user.id);
    if (name.startsWith('mcp.')){
      const rows = await setToolRegistryEnabled({ tenantId, name, enabled });
      if (!rows.length) return err(res, 404, '工具不存在');
    } else if (name.startsWith('custom.')){
      if (!isAdminUser(req.user)) return err(res, 403, '需要管理员权限');
      const id = name.slice('custom.'.length);
      const existing = getCustomTool(id, { includeDeleted: true });
      if (!existing || existing.deleted_at) return err(res, 404, '工具不存在');
      const tool = setCustomToolEnabled(id, enabled, {
        ownerId: req.user.id, isAdmin: isAdminUser(req.user),
      });
      if (!tool) return err(res, 404, '工具不存在');
      const d = descriptorForCustom(tool);
      await upsertToolRegistry({
        tenantId, name: d.name, version: d.version, source: 'custom',
        description: d.description, inputSchema: d.input_schema, sideEffect: d.side_effect,
        approvalPolicy: d.approval_policy, timeoutMs: d.timeout_ms, idempotency: d.idempotency,
        resourceScope: d.resource_scope, sandboxProfile: d.sandbox_profile,
        schemaHash: d.schema_hash, ownerId: tool.owner_id, enabled: !!tool.enabled,
      });
    } else {
      return err(res, 409, '内置工具不可启停，请使用租户工具策略控制');
    }
    await auditSafe({
      tenantId, actorType: 'user', actorId: req.user.id, action: 'tool.enabled.updated',
      resourceType: 'tool', resourceId: name, decision: 'allowed',
      detail: { tool_name: name, enabled },
    });
    res.json({ ok: true, name, enabled });
  } catch (e){
    console.error('[tool-registry]', e);
    err(res, 500, '工具状态更新失败');
  }
});

router.delete('/:name/policy', async (req, res) => {
  if (!isAdminUser(req.user)) return err(res, 403, '需要管理员权限');
  const principalType = String(req.query.principal_type || '');
  if (!['user', 'role', 'preset', 'tenant'].includes(principalType)){
    return err(res, 400, 'principal_type 不合法');
  }
  const principalId = req.query.principal_id != null ? String(req.query.principal_id) : '';
  if (!principalId) return err(res, 400, 'principal_id 不能为空');
  try {
    const tenantId = await resolveTenantId(req.user.id);
    const removed = await deleteToolPolicy({
      tenantId, toolName: String(req.params.name), principalType, principalId,
    });
    if (!removed) return err(res, 404, '工具策略不存在');
    await auditSafe({
      tenantId, actorType: 'user', actorId: req.user.id, action: 'tool.policy.deleted',
      resourceType: 'tool_policy', resourceId: `${req.params.name}:${principalType}:${principalId}`,
      decision: 'allowed',
      detail: { tool_name: req.params.name, principal_type: principalType, principal_id: principalId },
    });
    res.json({ ok: true });
  } catch (e){
    console.error('[tool-registry]', e);
    err(res, 500, '工具策略删除失败');
  }
});

router.get('/:name/policies', async (req, res) => {
  if (!isAdminUser(req.user)) return err(res, 403, '需要管理员权限');
  try {
    const tenantId = await resolveTenantId(req.user.id);
    res.json({ policies: await listToolPolicies({ tenantId, toolName: req.params.name }) });
  } catch (e){
    console.error('[tool-registry]', e);
    err(res, 500, '工具策略读取失败');
  }
});

export default router;
