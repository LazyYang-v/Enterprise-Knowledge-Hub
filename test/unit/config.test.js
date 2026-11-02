import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBool, parseConfig } from '../../server/config.js';

test('parseBool 支持常见布尔写法并保留默认值', () => {
  assert.equal(parseBool('1', false), true);
  assert.equal(parseBool('true', false), true);
  assert.equal(parseBool('YES', false), true);
  assert.equal(parseBool('on', false), true);
  assert.equal(parseBool('0', true), false);
  assert.equal(parseBool('false', true), false);
  assert.equal(parseBool('', true), true);
  assert.equal(parseBool(undefined, true), true);
  assert.equal(parseBool('maybe', true), true);
});

test('默认配置保持历史行为', () => {
  const c = parseConfig({});
  assert.equal(c.port, 3210);
  assert.equal(c.nodeEnv, 'development');
  assert.equal(c.isProduction, false);
  assert.equal(c.agentPlatformEnabled, false);
  assert.equal(c.demoSeedEnabled, true);
  assert.equal(c.databaseUrl, '');
  assert.deepEqual(c.platformAdminEmails, []);
});

test('特性开关与数据目录来自环境变量', () => {
  const c = parseConfig({
    PORT: '4321',
    AGENT_PLATFORM_ENABLED: 'true',
    EKH_DATA_DIR: '/tmp/ekh-data',
    DATABASE_URL: 'postgres://localhost/ekh',
    PLATFORM_ADMIN_EMAILS: ' Admin@Example.com, ops@example.com ',
  });
  assert.equal(c.port, 4321);
  assert.equal(c.agentPlatformEnabled, true);
  assert.equal(c.dataDir, '/tmp/ekh-data');
  assert.equal(c.databaseUrl, 'postgres://localhost/ekh');
  assert.deepEqual(c.platformAdminEmails, ['admin@example.com', 'ops@example.com']);
});

test('生产环境始终禁用演示数据，即使显式开启', () => {
  const c = parseConfig({ NODE_ENV: 'production', EKH_ENABLE_DEMO_SEED: '1' });
  assert.equal(c.isProduction, true);
  assert.equal(c.demoSeedEnabled, false);
});

test('开发环境可用 EKH_ENABLE_DEMO_SEED=0 关闭演示数据', () => {
  assert.equal(parseConfig({ NODE_ENV: 'development', EKH_ENABLE_DEMO_SEED: '0' }).demoSeedEnabled, false);
});

test('非法端口回退到 3210', () => {
  assert.equal(parseConfig({ PORT: 'abc' }).port, 3210);
  assert.equal(parseConfig({ PORT: '-1' }).port, 3210);
  assert.equal(parseConfig({ PORT: '70000' }).port, 3210);
});

test('P0-6：沙箱、MCP 出网、限流与故障注入默认值', () => {
  const c = parseConfig({});
  assert.equal(c.tools.sandboxMode, 'process');
  assert.equal(c.tools.sandboxImage, 'ekh-sandbox:1');
  assert.equal(c.tools.sandboxPidsLimit, 64);
  assert.equal(c.tools.sandboxCpuLimit, 0.5);
  assert.equal(c.mcp.allowPrivateHosts, false);
  assert.equal(c.mcp.allowMetadataHosts, false);
  assert.deepEqual(c.mcp.egressAllowlist, []);
  assert.equal(c.rateLimits.enabled, true);
  assert.equal(c.rateLimits.failOpen, false);
  assert.equal(c.rateLimits.taskCreate.limit, 30);
  assert.equal(c.rateLimits.modelCall.limit, 120);
  assert.equal(c.rateLimits.toolCall.limit, 120);
  assert.equal(c.testing.faultInjection, false);
  assert.equal(c.testing.faultSeed, 1);
});

test('P0-6：container 模式与限流开关可配置', () => {
  const c = parseConfig({
    EKH_TOOL_SANDBOX_MODE: 'container',
    EKH_MCP_ALLOW_PRIVATE_HOSTS: '1',
    EKH_MCP_EGRESS_ALLOWLIST: 'mcp.example.com, api.example.com',
    EKH_RATE_LIMIT_ENABLED: '0',
    EKH_RATE_LIMIT_FAIL_OPEN: '1',
    EKH_FAULT_INJECTION: '1',
    EKH_FAULT_CONFIG: '[{"point":"model.before_call","action":"delay"}]',
    EKH_FAULT_SEED: '7',
  });
  assert.equal(c.tools.sandboxMode, 'container');
  assert.equal(c.mcp.allowPrivateHosts, true);
  assert.deepEqual(c.mcp.egressAllowlist, ['mcp.example.com', 'api.example.com']);
  assert.equal(c.rateLimits.enabled, false);
  assert.equal(c.rateLimits.failOpen, true);
  assert.equal(c.testing.faultInjectionRequested, true);
  assert.equal(c.testing.faultInjection, true);
  assert.equal(c.testing.faultSeed, 7);
});

test('P0-6：生产环境强制关闭故障注入', () => {
  const c = parseConfig({ NODE_ENV: 'production', EKH_FAULT_INJECTION: '1' });
  assert.equal(c.testing.faultInjectionRequested, true);
  assert.equal(c.testing.faultInjection, false);
  assert.equal(c.isProduction, true);
});

test('P0-6：非法沙箱模式与限流窗口回退默认值', () => {
  const c = parseConfig({ EKH_TOOL_SANDBOX_MODE: 'nope', EKH_RATE_LIMIT_RETENTION_MS: '1' });
  assert.equal(c.tools.sandboxMode, 'process');
  assert.ok(c.rateLimits.retentionMs >= 10 * 60 * 1000);
});
