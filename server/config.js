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

function parsePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER){
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function parseList(value){
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function parseEnum(value, allowed, fallback){
  const v = String(value || '').trim();
  return allowed.includes(v) ? v : fallback;
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
    knowledge: Object.freeze({
      candidateLimit: parsePositiveInt(env.EKH_KNOWLEDGE_CANDIDATE_LIMIT ?? env.EKH_KNOWLEDGE_CANDIDATE_CAP, 5000, 100000),
      topKMax: parsePositiveInt(env.EKH_KNOWLEDGE_TOP_K_MAX, 20, 100),
      ftsLimit: parsePositiveInt(env.EKH_KNOWLEDGE_FTS_LIMIT, 80, 1000),
      excerptChars: parsePositiveInt(env.EKH_KNOWLEDGE_EXCERPT_CHARS, 2000, 20000),
      evidenceMax: parsePositiveInt(env.EKH_KNOWLEDGE_EVIDENCE_MAX, 8, 50),
      // 服务令牌的 KB 范围；空数组表示不额外收窄（保持旧行为）。
      serviceKbScope: Object.freeze(parseList(env.EKH_SERVICE_KB_SCOPE)),
    }),
    skills: Object.freeze({
      dir: String(env.EKH_SKILLS_DIR || ''),
      instructionMaxChars: parsePositiveInt(env.EKH_SKILL_INSTRUCTION_MAX_CHARS, 8000, 100000),
    }),
    tools: Object.freeze({
      sandboxMode: parseEnum(env.EKH_TOOL_SANDBOX_MODE, ['process', 'required', 'container', 'off'], 'process'),
      timeoutMs: parsePositiveInt(env.EKH_TOOL_TIMEOUT_MS, 15000, 120000),
      maxOutputChars: parsePositiveInt(env.EKH_TOOL_MAX_OUTPUT_CHARS, 8000, 64000),
      sandboxMemoryMb: parsePositiveInt(env.EKH_TOOL_SANDBOX_MEMORY_MB, 256, 2048),
      approvalTtlMs: parsePositiveInt(env.EKH_TOOL_APPROVAL_TTL_MS, 24 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000),
      highRiskApprovalTtlMs: parsePositiveInt(env.EKH_TOOL_HIGH_RISK_APPROVAL_TTL_MS, 60 * 60 * 1000, 24 * 60 * 60 * 1000),
      catalogMaxChars: parsePositiveInt(env.EKH_TOOL_CATALOG_MAX_CHARS, 12000, 64000),
      maxToolsPerTask: parsePositiveInt(env.EKH_TOOL_MAX_PER_TASK, 20, 50),
      sandboxImage: String(env.EKH_SANDBOX_IMAGE || 'ekh-sandbox:1'),
      sandboxDockerBin: String(env.EKH_SANDBOX_DOCKER_BIN || 'docker'),
      sandboxDockerProbeMs: parsePositiveInt(env.EKH_SANDBOX_DOCKER_PROBE_MS, 2500, 10000),
      sandboxPidsLimit: parsePositiveInt(env.EKH_SANDBOX_PIDS_LIMIT, 64, 512),
      sandboxCpuLimit: (() => {
        const n = Number(env.EKH_SANDBOX_CPU_LIMIT ?? '0.5');
        return Number.isFinite(n) && n > 0 ? n : 0.5;
      })(),
      sandboxTmpfsMb: parsePositiveInt(env.EKH_SANDBOX_TMPFS_MB, 64, 512),
      sandboxWorkspaceMb: parsePositiveInt(env.EKH_SANDBOX_WORKSPACE_MB, 16, 256),
      sandboxHardTimeoutGraceMs: parsePositiveInt(env.EKH_SANDBOX_HARD_TIMEOUT_GRACE_MS, 2000, 30000),
    }),
    mcp: Object.freeze({
      clientTimeoutMs: parsePositiveInt(env.EKH_MCP_CLIENT_TIMEOUT_MS, 15000, 120000),
      stdioEnabled: parseBool(env.EKH_MCP_STDIO_ENABLED, false),
      allowPrivateHosts: parseBool(env.EKH_MCP_ALLOW_PRIVATE_HOSTS, false),
      allowMetadataHosts: parseBool(env.EKH_MCP_ALLOW_METADATA_HOSTS, false),
      egressAllowlist: Object.freeze(parseList(env.EKH_MCP_EGRESS_ALLOWLIST)),
    }),
    rateLimits: Object.freeze({
      enabled: parseBool(env.EKH_RATE_LIMIT_ENABLED, true),
      failOpen: parseBool(env.EKH_RATE_LIMIT_FAIL_OPEN, false),
      retentionMs: Math.max(10 * 60 * 1000, parsePositiveInt(env.EKH_RATE_LIMIT_RETENTION_MS, 10 * 60 * 1000, 24 * 60 * 60 * 1000)),
      taskCreate: Object.freeze({
        limit: parsePositiveInt(env.EKH_RATE_TASK_CREATE_LIMIT, 30, 100000),
        windowMs: parsePositiveInt(env.EKH_RATE_TASK_CREATE_WINDOW_MS, 60000, 3600000),
      }),
      modelCall: Object.freeze({
        limit: parsePositiveInt(env.EKH_RATE_MODEL_CALL_LIMIT, 120, 1000000),
        windowMs: parsePositiveInt(env.EKH_RATE_MODEL_CALL_WINDOW_MS, 60000, 3600000),
      }),
      toolCall: Object.freeze({
        limit: parsePositiveInt(env.EKH_RATE_TOOL_CALL_LIMIT, 120, 1000000),
        windowMs: parsePositiveInt(env.EKH_RATE_TOOL_CALL_WINDOW_MS, 60000, 3600000),
      }),
    }),
    testing: Object.freeze({
      faultInjectionRequested: parseBool(env.EKH_FAULT_INJECTION, false),
      faultInjection: !isProduction && parseBool(env.EKH_FAULT_INJECTION, false),
      faultAllowProduction: parseBool(env.EKH_FAULT_ALLOW_PRODUCTION, false),
      faultConfig: String(env.EKH_FAULT_CONFIG || ''),
      faultConfigFile: String(env.EKH_FAULT_CONFIG_FILE || ''),
      faultSeed: parsePositiveInt(env.EKH_FAULT_SEED, 1, 2 ** 31 - 1),
    }),
    models: Object.freeze({
      secretDir: String(env.EKH_MODEL_SECRET_DIR || ''),
    }),
    service: Object.freeze({
      legacyTokenEnabled: parseBool(env.EKH_SERVICE_LEGACY_TOKEN_ENABLED, true),
    }),
    artifacts: Object.freeze({
      maxBytes: parsePositiveInt(env.EKH_ARTIFACT_MAX_BYTES, 25 * 1024 * 1024, 200 * 1024 * 1024),
      taskMaxBytes: parsePositiveInt(env.EKH_ARTIFACT_MAX_TASK_BYTES, 100 * 1024 * 1024, 1024 * 1024 * 1024),
      maxPerTask: parsePositiveInt(env.EKH_ARTIFACT_MAX_PER_TASK, 100, 1000),
      uploadMaxBytes: parsePositiveInt(env.EKH_ARTIFACT_UPLOAD_MAX_BYTES, 25 * 1024 * 1024, 200 * 1024 * 1024),
      gcGraceMs: parsePositiveInt(env.EKH_ARTIFACT_GC_GRACE_MS, 24 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000),
    }),
    files: Object.freeze({
      maxReadChars: parsePositiveInt(env.EKH_FILE_MAX_READ_CHARS, 6000, 100000),
      extractMaxChars: parsePositiveInt(env.EKH_FILE_EXTRACT_MAX_CHARS, 200000, 2000000),
      zipMaxEntries: parsePositiveInt(env.EKH_ZIP_MAX_ENTRIES, 200, 5000),
      zipMaxEntryBytes: parsePositiveInt(env.EKH_ZIP_MAX_ENTRY_BYTES, 10 * 1024 * 1024, 200 * 1024 * 1024),
      zipMaxTotalBytes: parsePositiveInt(env.EKH_ZIP_MAX_TOTAL_BYTES, 40 * 1024 * 1024, 1024 * 1024 * 1024),
      zipMaxRatio: parsePositiveInt(env.EKH_ZIP_MAX_RATIO, 100, 10000),
      sheetMaxRows: parsePositiveInt(env.EKH_SHEET_MAX_ROWS, 5000, 100000),
      sheetMaxCols: parsePositiveInt(env.EKH_SHEET_MAX_COLS, 100, 1000),
    }),
  });
}

export const config = parseConfig();
