// 确定性故障注入：默认关闭，生产环境禁止；只用于测试/演练。
// 配置为 JSON 数组：{point, action, after?, times?, probability?, delay_ms?, status?, code?, message?, match?}
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';
import { withTransaction } from '../control/pg.js';
import { appendEvent } from '../control/task-repo.js';

export const FAULT_POINTS = Object.freeze([
  'worker.before_task',
  'model.before_call',
  'model.after_call',
  'tool.before_execute',
  'tool.after_execute',
  'sandbox.before_spawn',
  'mcp.before_send',
  'mcp.after_send_before_read',
  'budget.before_check',
]);

export const FAULT_ACTIONS = Object.freeze([
  'delay', 'hang', 'throw', 'kill_self', 'empty', 'malformed', 'http_status', 'drop_response',
]);

export class FaultInjectedError extends Error {
  constructor(code = 'fault_injected', message = '已注入故障'){
    super(message);
    this.name = 'FaultInjectedError';
    this.code = code;
    this.retryable = true;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function hashInt(text){
  return parseInt(crypto.createHash('sha256').update(text).digest('hex').slice(0, 8), 16);
}

function parseFaults({ json = '', file = '' } = {}){
  let raw = String(json || '').trim();
  if (!raw && file){
    raw = fs.readFileSync(file, 'utf8');
  }
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('EKH_FAULT_CONFIG 不是合法 JSON'); }
  if (!Array.isArray(parsed)) throw new Error('EKH_FAULT_CONFIG 必须是数组');
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`故障配置第 ${index} 项不是对象`);
    if (!FAULT_POINTS.includes(item.point)) throw new Error(`未知故障点：${item.point}`);
    if (!FAULT_ACTIONS.includes(item.action)) throw new Error(`未知故障动作：${item.action}`);
    const times = item.times == null ? 1 : Number(item.times);
    const after = item.after == null ? 0 : Number(item.after);
    const probability = item.probability == null ? 1 : Number(item.probability);
    if (!Number.isInteger(times) || times < 0) throw new Error('故障 times 必须是非负整数');
    if (!Number.isInteger(after) || after < 0) throw new Error('故障 after 必须是非负整数');
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('故障 probability 必须在 0..1');
    return {
      point: item.point, action: item.action, after, times,
      probability, delay_ms: Number(item.delay_ms) || 0, status: Number(item.status) || 503,
      code: item.code ? String(item.code) : null, message: item.message ? String(item.message) : null,
      match: item.match && typeof item.match === 'object' ? item.match : {},
      used: 0,
    };
  });
}

let state = {
  enabled: false,
  seed: config.testing.faultSeed,
  faults: [],
  occurrences: new Map(),
};

function productionGuard(){
  if (config.isProduction && config.testing.faultInjectionRequested && !config.testing.faultAllowProduction){
    throw new Error('生产环境禁止启用故障注入（如确需演练，显式设置 EKH_FAULT_ALLOW_PRODUCTION=1）');
  }
}

export function configureFaults({
  enabled = config.testing.faultInjection,
  configJson = config.testing.faultConfig,
  configFile = config.testing.faultConfigFile,
  seed = config.testing.faultSeed,
} = {}){
  productionGuard();
  state = {
    enabled: !!enabled,
    seed: Number(seed) || 1,
    faults: enabled ? parseFaults({ json: configJson, file: configFile }) : [],
    occurrences: new Map(),
  };
  return state;
}

export function resetFaultStateForTest(){
  state = { enabled: false, seed: 1, faults: [], occurrences: new Map() };
}

export function faultInjectionEnabled(){
  return state.enabled;
}

function matches(fault, ctx){
  for (const [key, expected] of Object.entries(fault.match || {})){
    const actual = ctx?.[key];
    if (expected == null) continue;
    if (Array.isArray(expected) ? !expected.includes(actual) : String(actual) !== String(expected)) return false;
  }
  return true;
}

export function selectFault(point, ctx = {}){
  if (!state.enabled) return null;
  const occurrence = (state.occurrences.get(point) || 0) + 1;
  state.occurrences.set(point, occurrence);
  for (const fault of state.faults){
    if (fault.point !== point || !matches(fault, ctx)) continue;
    if (occurrence <= fault.after) continue;
    if (fault.used >= fault.times) continue;
    if (fault.probability < 1){
      const roll = (hashInt(`${state.seed}:${point}:${occurrence}:${ctx.task_id || ''}:${ctx.tool_name || ''}`) % 1000) / 1000;
      if (roll >= fault.probability) continue;
    }
    fault.used += 1;
    return { ...fault, occurrence };
  }
  return null;
}

export async function recordFaultEvent({ task, fault, actorId = 'fault-injection' } = {}){
  if (!task?.tenant_id || !task?.id || !fault) return;
  try {
    await withTransaction(client => appendEvent(client, {
      tenantId: task.tenant_id, taskId: task.id, type: 'fault.injected',
      actorType: 'system', actorId,
      payload: {
        point: fault.point, action: fault.action, seed: state.seed,
        occurrence: fault.occurrence, fault_code: fault.code || null,
      },
    }));
  } catch (e){
    console.error('[fault] event failed:', e?.message || e);
  }
}

/**
 * 选择并执行故障。返回 {fault, result}；无故障返回 null。
 * empty/malformed/http_status 由调用方依据 result 改变返回值；其余动作在此完成。
 */
export async function injectFault(point, ctx = {}){
  const fault = selectFault(point, ctx);
  if (!fault) return null;
  if (ctx.task) await recordFaultEvent({ task: ctx.task, fault });
  switch (fault.action){
    case 'delay':
      await sleep(fault.delay_ms || 1000);
      return { fault, result: { kind: 'delay' } };
    case 'hang':
    case 'drop_response': {
      const signal = ctx.signal;
      if (!signal) await sleep(60 * 60 * 1000);
      else if (signal.aborted) throw new FaultInjectedError('fault_aborted', '故障注入等待被取消');
      else await new Promise((resolve, reject) => {
        const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(new FaultInjectedError('fault_aborted', '故障注入等待被取消')); };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return { fault, result: { kind: fault.action } };
    }
    case 'throw':
      throw new FaultInjectedError(fault.code || 'fault_injected', fault.message || '已注入故障');
    case 'kill_self':
      process.kill(process.pid, 'SIGKILL');
      await sleep(1000);
      return { fault, result: { kind: 'kill_self' } };
    case 'empty':
      return { fault, result: { kind: 'empty', content: '' } };
    case 'malformed':
      return { fault, result: { kind: 'malformed', content: '{"type":' } };
    case 'http_status':
      return { fault, result: { kind: 'http_status', status: fault.status } };
    default:
      return { fault, result: { kind: fault.action } };
  }
}
