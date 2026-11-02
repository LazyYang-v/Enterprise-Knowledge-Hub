import '../helpers/sqlite-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

// 必须在任何导入 server/config.js 的模块之前设置特性开关。
process.env.AGENT_PLATFORM_ENABLED = '1';
process.env.PLATFORM_ADMIN_EMAILS = 'skills-admin@example.com';

const { ensureSchema, canUseTestDatabase, closeTestDb } = await import('../helpers/pg.js');
const { startApp } = await import('../helpers/app.js');

const skip = !canUseTestDatabase();

test('Skills API：列表、详情与 reload 权限', { skip }, async t => {
  await ensureSchema();
  const app = await startApp();
  t.after(async () => { await app.close(); await closeTestDb(); });

  const admin = await app.register('skills-admin@example.com', 'Admin');
  const user = await app.register('skills-user@example.com', 'User');

  const denied = await app.request('POST', '/api/skills/reload', { token: user.token });
  assert.equal(denied.status, 403);

  const reload = await app.request('POST', '/api/skills/reload', { token: admin.token });
  assert.equal(reload.status, 200);
  assert.equal(reload.data.loaded, 2);
  assert.equal(reload.data.errors.length, 0);

  const list = await app.request('GET', '/api/skills', { token: user.token });
  assert.equal(list.status, 200);
  assert.equal(list.data.skills.length, 2);
  const kr = list.data.skills.find(s => s.name === 'knowledge-research');
  assert.equal(kr.selectable, true);
  assert.equal(kr.instructions, undefined, '列表不得返回 instructions');
  const sa = list.data.skills.find(s => s.name === 'spreadsheet-audit');
  assert.equal(sa.selectable, true, 'P0-5 文件工具就绪后 spreadsheet-audit 应可选');
  assert.equal(sa.version, '1.1.0');
  assert.deepEqual(sa.required_tools, ['document.read', 'spreadsheet.read']);

  const detail = await app.request('GET', `/api/skills/${kr.id}`, { token: user.token });
  assert.equal(detail.status, 200);
  assert.match(detail.data.skill.instructions, /Knowledge Research/);

  const missing = await app.request('GET', '/api/skills/00000000-0000-4000-8000-000000000000', { token: user.token });
  assert.equal(missing.status, 404);
});
