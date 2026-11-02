// 自定义工具：用户上传的 JS 文件，export default { name, description, parameters, execute }
// 定义阶段在 vm 沙箱中同步求值做校验；execute 调用时加超时与结果截断。
import vm from 'node:vm';
import { db } from './db.js';

const DEFINE_TIMEOUT = 2000;
const EXEC_TIMEOUT = 15000;
const MAX_RESULT = 8000;
const MAX_CODE = 256 * 1024;

function sandbox(){
  const fetchWithTimeout = (url, opts = {}) => fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(EXEC_TIMEOUT) });
  return vm.createContext({
    fetch: fetchWithTimeout,
    console: { log(){}, info(){}, warn(){}, error(){} },
    AbortSignal,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    atob,
    btoa,
  });
}

// 求值工具文件，返回完整 spec（含 execute 函数）
function evalToolCode(code){
  const src = String(code || '');
  if (!src.trim()) throw new Error('工具文件为空');
  if (src.length > MAX_CODE) throw new Error('工具文件过大（上限 256KB）');
  const body = src.replace(/\bexport\s+default\b/, 'module.exports =');
  const wrapped =
    '"use strict";\n' +
    'const module = { exports: {} };\n' +
    'const exports = module.exports;\n' +
    body + '\n' +
    ';const __t = (module.exports && Object.keys(module.exports).length) ? module.exports : (typeof tool !== "undefined" ? tool : null);\n' +
    'if (!__t) throw new Error("未找到工具定义，请使用 export default { ... } 导出");\n' +
    '__t;';
  let spec;
  try {
    spec = vm.runInNewContext(wrapped, sandbox(), { timeout: DEFINE_TIMEOUT });
  } catch (e){
    throw new Error('工具代码解析失败：' + (e && e.message || e));
  }
  if (!spec || typeof spec !== 'object' || typeof spec.execute !== 'function'){
    throw new Error('工具格式不正确：需 export default 一个包含 name、description、execute(args) 的对象');
  }
  if (!spec.name || typeof spec.name !== 'string') throw new Error('工具缺少 name 字段');
  if (!spec.description || typeof spec.description !== 'string') throw new Error('工具缺少 description 字段');
  let parameters = spec.parameters;
  if (parameters == null || typeof parameters !== 'object' || Array.isArray(parameters)){
    parameters = { type: 'object', properties: {} };
  }
  if (!parameters.type) parameters = { type: 'object', properties: {}, ...parameters };
  return {
    name: String(spec.name).slice(0, 60),
    description: String(spec.description).slice(0, 500),
    parameters,
    execute: spec.execute,
  };
}

// 上传校验：只返回元信息
export function parseToolCode(code){
  const { name, description, parameters } = evalToolCode(code);
  return { name, description, parameters };
}

// 智能体勾选的自定义工具（key 形如 custom:<id>），仅返回已启用的
export function resolveAgentCustomTools(keys){
  const ids = (keys || []).filter(k => typeof k === 'string' && k.startsWith('custom:')).map(k => k.slice(7));
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM custom_tools WHERE enabled = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
}

// OpenAI function calling 的函数名只允许字母数字下划线连字符，用 id 生成稳定标识
export function toolFnName(row){
  return 'tool_' + String(row.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
}

const specCache = new Map();

// 执行一个自定义工具，始终返回字符串（错误也作为结果回传给模型）
export async function runCustomTool(row, argsRaw){
  const cacheKey = row.id + ':' + (row.updated_at || '');
  let spec = specCache.get(cacheKey);
  if (!spec){
    try {
      spec = evalToolCode(row.code);
    } catch (e){
      return '工具加载失败：' + e.message;
    }
    if (specCache.size > 50) specCache.clear();
    specCache.set(cacheKey, spec);
  }
  let args;
  try {
    args = argsRaw ? JSON.parse(argsRaw) : {};
  } catch { args = {}; }
  try {
    const result = await Promise.race([
      Promise.resolve(spec.execute(args)),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`执行超时（${EXEC_TIMEOUT / 1000}s）`)), EXEC_TIMEOUT)),
    ]);
    const out = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (out == null) return 'null';
    return out.length > MAX_RESULT ? out.slice(0, MAX_RESULT) + '\n…(结果已截断)' : out;
  } catch (e){
    return '工具执行失败：' + (e && e.message || String(e));
  }
}
