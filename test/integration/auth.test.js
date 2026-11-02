import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers/app.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.close(); });

test('注册、登录与 /me 的既有行为不回归', async () => {
  const reg = await app.request('POST', '/api/auth/register', {
    body: { email: 'alice@example.com', name: 'Alice', password: 'password123' },
  });
  assert.equal(reg.status, 200);
  assert.ok(reg.data.token);
  assert.equal(reg.data.user.email, 'alice@example.com');

  const dup = await app.request('POST', '/api/auth/register', {
    body: { email: 'alice@example.com', password: 'password123' },
  });
  assert.equal(dup.status, 400);

  const wrong = await app.request('POST', '/api/auth/login', {
    body: { email: 'alice@example.com', password: 'wrong-pass' },
  });
  assert.equal(wrong.status, 401);

  const login = await app.request('POST', '/api/auth/login', {
    body: { email: 'alice@example.com', password: 'password123' },
  });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);

  const me = await app.request('GET', '/api/auth/me', { token: login.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'alice@example.com');

  const bad = await app.request('GET', '/api/auth/me', { token: 'invalid-token' });
  assert.equal(bad.status, 401);
});

test('退出登录后令牌失效', async () => {
  const { token } = await app.register('bob@example.com', 'Bob');
  const out = await app.request('POST', '/api/auth/logout', { token });
  assert.equal(out.status, 200);
  const me = await app.request('GET', '/api/auth/me', { token });
  assert.equal(me.status, 401);
});

test('兼容 query token（现有行为，P0-1 前不改语义）', async () => {
  const { token } = await app.register('carol@example.com', 'Carol');
  const me = await app.request('GET', `/api/auth/me?token=${token}`);
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'carol@example.com');
});
