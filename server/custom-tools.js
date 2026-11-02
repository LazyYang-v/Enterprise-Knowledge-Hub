// 自定义工具兼容层：旧聊天路径继续使用 runCustomTool 字符串语义，
// 但定义与执行都改由独立子进程沙箱完成，不再向 vm 注入宿主 fetch/process。
import { runSandbox } from './tools/sandbox.js';
import { assertSchemaDefinition } from './tools/schema.js';
import {
  resolveAgentCustomTools as resolveAgentCustomToolsFromRepo,
} from './tools/custom-tools-repo.js';
import { config } from './config.js';

const MAX_RESULT = 8000;

/** 上传校验：在子进程中解析代码，只返回元信息。 */
export async function parseToolCode(code){
  const src = String(code ?? '');
  if (!src.trim()) throw new Error('工具文件为空');
  const out = await runSandbox({ mode: 'define', code: src, timeoutMs: 3000 });
  const meta = out.meta || {};
  assertSchemaDefinition(meta.parameters || { type: 'object', properties: {} });
  return {
    name: String(meta.name || '').slice(0, 60),
    description: String(meta.description || '').slice(0, 500),
    parameters: meta.parameters || { type: 'object', properties: {} },
  };
}

/** 旧聊天路径：返回 parameters 为 JSON 字符串的行，保持原有协议。 */
export function resolveAgentCustomTools(keys, { ownerId = null } = {}){
  return resolveAgentCustomToolsFromRepo(keys, { ownerId }).map(t => ({
    ...t,
    parameters: JSON.stringify(t.parameters || {}),
  }));
}

// OpenAI function calling 的函数名只允许字母数字下划线连字符，用 id 生成稳定标识
export function toolFnName(row){
  return 'tool_' + String(row.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
}

/** 执行自定义工具，始终返回字符串（错误也作为结果回传给模型）。 */
export async function runCustomTool(row, argsRaw){
  let args;
  try {
    args = argsRaw ? JSON.parse(argsRaw) : {};
  } catch { args = {}; }
  try {
    const out = await runSandbox({
      mode: 'execute', code: row.code, args,
      timeoutMs: config.tools.timeoutMs,
    });
    const text = String(out.result ?? 'null');
    return text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + '\n…(结果已截断)' : text;
  } catch (e){
    return '工具执行失败：' + (e?.message || String(e));
  }
}
