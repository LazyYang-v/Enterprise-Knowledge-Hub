import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApiError, describeApiError, ApiError } from '../../public/js/core/api-error.js';
import { matchPattern, matchRoute } from '../../public/js/core/route-match.js';
import { parseHash, buildPath } from '../../public/js/core/navigation.js';

test('parseApiError 解析结构化 envelope', () => {
  const error = parseApiError(429, {
    error: { code: 'rate_limited', message: '太快了', details: { retry_after_seconds: 7 }, retryable: true, request_id: 'req_1' },
  }, '7');
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 429);
  assert.equal(error.code, 'rate_limited');
  assert.equal(error.message, '太快了');
  assert.equal(error.details.retry_after_seconds, 7);
  assert.equal(error.retryable, true);
  assert.equal(error.requestId, 'req_1');
  assert.equal(error.retryAfter, 7);
  assert.equal(describeApiError(error), '请求过于频繁，请稍后再试');
});

test('parseApiError 兼容字符串 error 与空响应', () => {
  assert.equal(parseApiError(400, { error: '字段不合法' }).message, '字段不合法');
  const empty = parseApiError(500, null);
  assert.equal(empty.status, 500);
  assert.match(empty.message, /500/);
  assert.equal(describeApiError(new Error('boom')), 'boom');
});

test('matchPattern 支持参数与可选尾段', () => {
  assert.deepEqual(matchPattern('/tasks', '/tasks'), {});
  assert.equal(matchPattern('/tasks', '/tasks/abc'), null);
  assert.deepEqual(matchPattern('/tasks/:id', '/tasks/abc'), { id: 'abc' });
  assert.deepEqual(matchPattern('/tasks/:id/:tab?', '/tasks/abc'), { id: 'abc' });
  assert.deepEqual(matchPattern('/tasks/:id/:tab?', '/tasks/abc/events'), { id: 'abc', tab: 'events' });
  assert.equal(matchPattern('/tasks/:id', '/kbs/abc'), null);
});

test('matchRoute 按顺序返回首个匹配', () => {
  const routes = [
    { path: '/tasks', name: 'list' },
    { path: '/tasks/:id', name: 'detail' },
    { path: '/admin/:section', name: 'admin' },
  ];
  assert.equal(matchRoute(routes, '/tasks').route.name, 'list');
  assert.equal(matchRoute(routes, '/tasks/1').route.name, 'detail');
  assert.equal(matchRoute(routes, '/admin/tools').params.section, 'tools');
  assert.equal(matchRoute(routes, '/missing'), null);
});

test('parseHash/buildPath 规范化查询串', () => {
  assert.deepEqual(parseHash('#/tasks?filter=all&q=abc'), {
    path: '/tasks', query: { filter: 'all', q: 'abc' }, raw: '/tasks?filter=all&q=abc',
  });
  assert.equal(parseHash('').path, '/kbs');
  assert.equal(buildPath('/tasks', { filter: null, q: '' }), '/tasks');
  assert.equal(buildPath('/tasks', { filter: 'all', q: 'a b' }), '/tasks?filter=all&q=a+b');
});
