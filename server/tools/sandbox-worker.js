// 沙箱子进程入口：stdin 接收 JSON，stdout 只输出一行 JSON。
// 关键约束：
//   * vm context 不注入任何宿主函数；require/process/fetch 等显式 stub 抛 sandbox_violation。
//   * 代码错误只回传截断后的 message，不返回堆栈、路径或宿主对象。
//   * 同步死循环由父进程超时 SIGKILL；这里只负责求值与执行。
import vm from 'node:vm';

const MAX_INPUT = 512 * 1024;
const DEFINE_TIMEOUT = 2000;
const MAX_RESULT = 256 * 1024;

function violation(name){
  const e = new Error(`沙箱禁止访问 ${name}`);
  e.code = 'sandbox_violation';
  return e;
}

function forbidden(name){
  const handler = {
    get(){ throw violation(name); },
    set(){ throw violation(name); },
    apply(){ throw violation(name); },
    construct(){ throw violation(name); },
  };
  return new Proxy(function(){ throw violation(name); }, handler);
}

function makeContext(){
  const names = ['require', 'process', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Deno', 'Bun',
    'module', 'exports', 'fs', 'child_process', 'net', 'http', 'https', 'os', 'path', 'worker_threads'];
  const sandbox = Object.create(null);
  for (const name of names) sandbox[name] = forbidden(name);
  sandbox.console = Object.freeze({ log(){}, info(){}, warn(){}, error(){}, debug(){} });
  return vm.createContext(sandbox, {
    name: 'custom-tool',
    codeGeneration: { strings: false, wasm: false },
  });
}

function evalTool(code){
  const src = String(code ?? '');
  if (!src.trim()) throw new Error('工具文件为空');
  if (src.length > 256 * 1024) throw new Error('工具文件过大（上限 256KB）');
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
    spec = vm.runInContext(wrapped, makeContext(), { timeout: DEFINE_TIMEOUT, displayErrors: false });
  } catch (e){
    const err = new Error('工具代码解析失败：' + cleanMessage(e));
    err.code = e?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'sandbox_timeout' : 'tool_parse_failed';
    throw err;
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
    spec,
    meta: {
      name: String(spec.name).slice(0, 60),
      description: String(spec.description).slice(0, 500),
      parameters,
    },
  };
}

function cleanMessage(e){
  return String(e?.message || e || '未知错误').replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function jsonSafe(value){
  if (typeof value === 'string') return value;
  const out = JSON.stringify(value, (key, v) => {
    if (typeof v === 'bigint') return String(v);
    return v;
  });
  return out == null ? 'null' : out;
}

async function handle(payload){
  if (!payload || typeof payload !== 'object') throw new Error('沙箱请求不合法');
  if (payload.mode === 'define'){
    const { meta } = evalTool(payload.code);
    return { meta };
  }
  if (payload.mode === 'execute'){
    const { spec } = evalTool(payload.code);
    let result;
    try {
      result = spec.execute(payload.args && typeof payload.args === 'object' ? payload.args : {});
      if (result && typeof result.then === 'function') result = await result;
    } catch (e){
      const err = new Error('工具执行失败：' + cleanMessage(e));
      err.code = e?.code === 'sandbox_violation' ? 'sandbox_violation' : 'tool_execution_failed';
      throw err;
    }
    const text = jsonSafe(result);
    if (Buffer.byteLength(text, 'utf8') > MAX_RESULT){
      return { result: text.slice(0, MAX_RESULT), truncated: true };
    }
    return { result: text };
  }
  throw new Error('未知沙箱模式');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > MAX_INPUT){
    process.stdout.write(JSON.stringify({ ok: false, error: { code: 'tool_too_large', message: '沙箱输入过大' } }));
    process.exit(2);
  }
});
process.stdin.on('end', async () => {
  let payload;
  try { payload = JSON.parse(buffer || '{}'); }
  catch {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: 'tool_parse_failed', message: '沙箱请求不是合法 JSON' } }));
    process.exit(2);
  }
  try {
    const out = await handle(payload);
    process.stdout.write(JSON.stringify({ ok: true, ...out }));
    process.exit(0);
  } catch (e){
    process.stdout.write(JSON.stringify({
      ok: false,
      error: {
        code: e?.code || 'tool_execution_failed',
        message: cleanMessage(e),
      },
    }));
    process.exit(0);
  }
});
process.on('uncaughtException', e => {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'tool_execution_failed', message: cleanMessage(e) } }));
  process.exit(0);
});
process.on('unhandledRejection', e => {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'tool_execution_failed', message: cleanMessage(e) } }));
  process.exit(0);
});
