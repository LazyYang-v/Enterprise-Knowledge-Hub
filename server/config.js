// 运行配置：集中读取环境变量，保持历史默认值不变。
// 设计参考：Agent P0 设计文档 §15.2（P0-0 特性开关）。

export function parseBool(value, fallback = false){
  if (value == null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parsePort(value, fallback = 3210){
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

function parseAdmins(value){
  return String(value || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

export function parseConfig(env = process.env){
  const nodeEnv = String(env.NODE_ENV || 'development');
  const isProduction = nodeEnv === 'production';
  const demoFlag = env.EKH_ENABLE_DEMO_SEED ?? env.EK_H_ENABLE_DEMO_SEED;
  return Object.freeze({
    port: parsePort(env.PORT),
    nodeEnv,
    isProduction,
    dataDir: env.EKH_DATA_DIR ? String(env.EKH_DATA_DIR) : '',
    databaseUrl: String(env.DATABASE_URL || ''),
    agentPlatformEnabled: parseBool(env.AGENT_PLATFORM_ENABLED, false),
    // 生产环境始终禁用演示数据；开发环境默认开启，可用 EKH_ENABLE_DEMO_SEED=0 关闭。
    demoSeedEnabled: !isProduction && parseBool(demoFlag, true),
    platformAdminEmails: parseAdmins(env.PLATFORM_ADMIN_EMAILS),
  });
}

export const config = parseConfig();
