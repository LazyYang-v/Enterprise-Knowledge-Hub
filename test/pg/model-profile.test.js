import '../helpers/sqlite-env.js';

process.env.AGENT_PLATFORM_ENABLED = '1';
process.env.PLATFORM_ADMIN_EMAILS = 'model-admin@example.com';
process.env.EKH_TEST_PROFILE_KEY = 'sk-model-secret';

import test from 'node:test';
import assert from 'node:assert/strict';

const { ensureSchema, canUseTestDatabase, closeTestDb } = await import('../helpers/pg.js');
const { startApp } = await import('../helpers/app.js');
const { getPool } = await import('../../server/control/pg.js');
const { resolveTaskModel } = await import('../../server/control/model-resolver.js');

const skip = !canUseTestDatabase();

test('S-04：模型 profile 管理、凭证不回显与 Worker 解析', { skip }, async t => {
  await ensureSchema();
  const app = await startApp({ AGENT_PLATFORM_ENABLED: '1', PLATFORM_ADMIN_EMAILS: 'model-admin@example.com' });
  t.after(async () => { await app.close(); await closeTestDb(); });

  const admin = await app.register('model-admin@example.com', '管理员');
  const user = await app.register('model-user@example.com', '普通用户');

  assert.equal((await app.request('GET', '/api/model-profiles', { token: user.token })).status, 403);
  assert.equal((await app.request('POST', '/api/model-profiles', {
    token: user.token, body: { name: 'x', base_url: 'https://api.example.com', model_name: 'm' },
  })).status, 403);

  // SSRF 基础防护：本机/私网/元数据地址拒绝。
  for (const base_url of [
    'http://127.0.0.1:8080/v1', 'http://10.0.0.1/v1', 'http://192.168.1.1/v1',
    'http://169.254.169.254/latest', 'http://localhost/v1', 'file:///etc/passwd',
  ]) {
    const r = await app.request('POST', '/api/model-profiles', {
      token: admin.token, body: { name: `bad-${base_url}`, base_url, model_name: 'm' },
    });
    assert.equal(r.status, 400, base_url);
  }

  const created = await app.request('POST', '/api/model-profiles', {
    token: admin.token,
    body: {
      name: '主模型', provider: 'openai', base_url: 'https://api.example.com/v1/',
      model_name: 'gpt-test', credential_ref: 'env:EKH_TEST_PROFILE_KEY',
      context_window: 128000, capabilities: { tools: true },
    },
  });
  assert.equal(created.status, 201);
  const profile = created.data.profile;
  assert.equal(profile.credential_ref, 'configured');
  assert.equal(profile.credential_configured, true);
  assert.equal(JSON.stringify(created.data).includes('sk-model-secret'), false);
  assert.equal(profile.base_url, 'https://api.example.com/v1');

  const listed = await app.request('GET', '/api/model-profiles', { token: admin.token });
  assert.equal(listed.status, 200);
  assert.equal(JSON.stringify(listed.data).includes('sk-model-secret'), false);
  assert.equal(listed.data.profiles[0].credential_ref, 'configured');

  // 缺失凭证只标记未配置，不回显引用名之外的内容。
  const missing = await app.request('POST', '/api/model-profiles', {
    token: admin.token,
    body: { name: '缺凭证', base_url: 'https://api.example.com/v1', model_name: 'm2', credential_ref: 'env:EKH_NOT_SET' },
  });
  assert.equal(missing.status, 201);
  assert.equal(missing.data.profile.credential_configured, false);

  // Worker 解析：preset.model_profile_id 优先，凭证在内存中解析。
  const tenantId = profile.tenant_id;
  const preset = await getPool().query(
    `INSERT INTO agent_presets (tenant_id, owner_id, name, default_kb_ids, status, model_profile_id)
     VALUES ($1, 'model-user', '模型预设', '[]'::jsonb, 'active', $2) RETURNING *`,
    [tenantId, profile.id],
  );
  const model = await resolveTaskModel({
    tenant_id: tenantId, preset_id: preset.rows[0].id,
  });
  assert.equal(model.base_url, 'https://api.example.com/v1');
  assert.equal(model.model_name, 'gpt-test');
  assert.equal(model.api_key, 'sk-model-secret');

  // PATCH 不改凭证时保持已配置。
  const patched = await app.request('PATCH', `/api/model-profiles/${profile.id}`, {
    token: admin.token, body: { name: '主模型改名' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.profile.credential_configured, true);
  assert.equal(patched.data.profile.name, '主模型改名');

  await getPool().query('DELETE FROM agent_presets WHERE id = $1', [preset.rows[0].id]);
  assert.equal((await app.request('DELETE', `/api/model-profiles/${profile.id}`, { token: admin.token })).status, 200);
  assert.equal((await app.request('GET', `/api/model-profiles/${profile.id}`, { token: admin.token })).status, 404);
});
