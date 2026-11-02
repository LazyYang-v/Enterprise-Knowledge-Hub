import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const publicDir = path.join(root, 'public');

function walk(dir){
  const out = [];
  for (const name of readdirSync(dir)){
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const modules = walk(path.join(publicDir, 'js')).concat([path.join(publicDir, 'app.js')]);

test('所有前端模块通过 node --check', () => {
  assert.ok(modules.length >= 10, '应存在前端模块');
  for (const file of modules){
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${path.relative(root, file)}: ${result.stderr}`);
  }
});

test('index.html 使用模块入口且不含内联事件处理器', () => {
  const html = readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.match(html, /id="view-approvals"/);
  assert.match(html, /id="view-admin"/);
  assert.match(html, /id="drawer-overlay"/);
  assert.match(html, /id="live-region"/);
});

test('新增样式与模块文件存在', () => {
  for (const rel of [
    'css/tokens.css', 'css/ui.css', 'css/tasks.css', 'css/artifacts.css', 'css/admin.css',
    'js/core/api.js', 'js/core/router.js', 'js/core/sse.js', 'js/routes.js',
    'js/views/tasks/list.js', 'js/views/tasks/detail.js',
    'js/views/approvals.js', 'js/views/artifacts.js', 'js/views/admin/index.js',
  ]){
    assert.ok(statSync(path.join(publicDir, rel)).isFile(), `缺少 ${rel}`);
  }
  const html = readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  for (const css of ['tokens', 'ui', 'tasks', 'artifacts', 'admin']){
    assert.match(html, new RegExp(`/css/${css}\\.css`));
  }
});

test('前端模块图可解析（命名导出一致）', async () => {
  const routesUrl = new URL('../../public/js/routes.js', import.meta.url).href;
  const mod = await import(routesUrl);
  assert.equal(typeof mod.buildRoutes, 'function');
  const routes = mod.buildRoutes({ activate(){}, deactivate(){} });
  assert.ok(routes.some(route => route.path === '/tasks'));
  assert.ok(routes.some(route => route.path === '/tasks/:id/:tab?'));
  assert.ok(routes.some(route => route.path === '/admin/tools'));
});

test('app.js 不再直接使用 document.write 或内联 eval', () => {
  const source = readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.doesNotMatch(source, /document\.write\(/);
  assert.doesNotMatch(source, /\beval\s*\(/);
});
