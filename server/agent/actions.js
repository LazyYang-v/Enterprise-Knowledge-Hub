// AgentAction：模型唯一可以输出的结构化动作（设计文档 §5.4）。
// P0-1 只做严格解析与结构校验；工具 schema 的完整校验由 P0-4 ToolRegistry 负责。

export const AGENT_ACTION_TYPES = Object.freeze(['plan', 'call_tool', 'ask_user', 'finish', 'fail']);
export const MAX_PLAN_ITEMS = 12;
export const MAX_ACTION_BYTES = 256 * 1024;
const MAX_DEPTH = 8;

export class ActionValidationError extends Error {
  constructor(message, code = 'action_invalid'){
    super(message);
    this.name = 'ActionValidationError';
    this.code = code;
  }
}

const ITEM_STATUSES = new Set(['pending', 'in_progress', 'done', 'blocked', 'cancelled']);
const FIELD_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'string[]']);

function isPlainObject(v){
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function fail(message, code){
  throw new ActionValidationError(message, code);
}

function depthOf(value, depth = 0){
  if (value == null || typeof value !== 'object') return depth;
  let max = depth;
  const values = Array.isArray(value) ? value : Object.values(value);
  for (const v of values) max = Math.max(max, depthOf(v, depth + 1));
  return max;
}

function assertDepth(value, where){
  if (depthOf(value) > MAX_DEPTH) fail(`${where} 嵌套层级超过 ${MAX_DEPTH}`, 'action_too_deep');
}

function assertNoExtraKeys(obj, allowed, where){
  for (const key of Object.keys(obj)){
    if (!allowed.includes(key)) fail(`${where} 包含未知字段：${key}`, 'action_unknown_field');
  }
}

function assertString(value, field, { min = 0, max = 10000 } = {}){
  if (typeof value !== 'string') fail(`${field} 必须是字符串`, 'action_invalid_field');
  if (value.length < min) fail(`${field} 不能为空`, 'action_invalid_field');
  if (value.length > max) fail(`${field} 超过长度上限 ${max}`, 'action_invalid_field');
  return value;
}

function assertStringArray(value, field, maxItems){
  if (!Array.isArray(value)) fail(`${field} 必须是字符串数组`, 'action_invalid_field');
  if (value.length > maxItems) fail(`${field} 最多 ${maxItems} 项`, 'action_invalid_field');
  for (const item of value){
    if (typeof item !== 'string') fail(`${field} 只能包含字符串`, 'action_invalid_field');
    if (item.length > 512) fail(`${field} 单项超过 512 字符`, 'action_invalid_field');
  }
  return [...value];
}

function parseJsonText(raw){
  let text = String(raw ?? '').trim();
  if (!text) fail('action 为空', 'action_empty');
  if (Buffer.byteLength(text, 'utf8') > MAX_ACTION_BYTES){
    fail(`action 超过 ${MAX_ACTION_BYTES} 字节`, 'action_too_large');
  }
  // 允许模型把 JSON 包在单个 ```json 代码块中；其余文本一律拒绝。
  if (text.startsWith('```')){
    const match = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
    if (!match) fail('action 代码块格式不合法', 'action_invalid_json');
    text = match[1].trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    fail('action 不是合法 JSON', 'action_invalid_json');
  }
}

function validatePlan(payload){
  const allowed = ['type', 'plan_items'];
  assertNoExtraKeys(payload, allowed, 'plan');
  const items = payload.plan_items;
  if (!Array.isArray(items) || items.length < 1) fail('plan_items 至少需要 1 项', 'action_invalid_plan');
  if (items.length > MAX_PLAN_ITEMS) fail(`plan_items 最多 ${MAX_PLAN_ITEMS} 项`, 'action_invalid_plan');

  const keys = new Set();
  const normalized = items.map((item, i) => {
    if (!isPlainObject(item)) fail(`plan_items[${i}] 必须是对象`, 'action_invalid_plan');
    assertNoExtraKeys(item, ['item_key', 'title', 'description', 'completion_criteria', 'status', 'depends_on'], `plan_items[${i}]`);
    const itemKey = assertString(item.item_key, `plan_items[${i}].item_key`, { min: 1, max: 64 });
    if (!/^[a-zA-Z0-9_.-]+$/.test(itemKey)) fail(`plan_items[${i}].item_key 含非法字符`, 'action_invalid_plan');
    if (keys.has(itemKey)) fail(`plan_items 存在重复 item_key：${itemKey}`, 'action_invalid_plan');
    keys.add(itemKey);
    const title = assertString(item.title, `plan_items[${i}].title`, { min: 1, max: 200 });
    const description = item.description == null ? '' : assertString(item.description, `plan_items[${i}].description`, { max: 2000 });
    const completion = assertString(item.completion_criteria, `plan_items[${i}].completion_criteria`, { min: 1, max: 2000 });
    const status = item.status == null ? 'pending' : item.status;
    if (!ITEM_STATUSES.has(status)) fail(`plan_items[${i}].status 不合法`, 'action_invalid_plan');
    const dependsOn = item.depends_on == null ? [] : item.depends_on;
    if (!Array.isArray(dependsOn) || dependsOn.some(d => typeof d !== 'string')){
      fail(`plan_items[${i}].depends_on 必须是字符串数组`, 'action_invalid_plan');
    }
    return { item_key: itemKey, title, description, completion_criteria: completion, status, depends_on: [...dependsOn] };
  });

  for (const item of normalized){
    for (const dep of item.depends_on){
      if (dep === item.item_key) fail(`plan item ${item.item_key} 不能依赖自身`, 'action_invalid_plan');
      if (!keys.has(dep)) fail(`plan item ${item.item_key} 依赖了不存在的 ${dep}`, 'action_invalid_plan');
    }
  }

  // 环检测（DFS）。
  const byKey = new Map(normalized.map(i => [i.item_key, i]));
  const state = new Map();
  const visit = key => {
    if (state.get(key) === 1) return true;
    if (state.get(key) === 2) return false;
    state.set(key, 1);
    for (const dep of byKey.get(key).depends_on){
      if (visit(dep)) return true;
    }
    state.set(key, 2);
    return false;
  };
  if (normalized.some(i => visit(i.item_key))) fail('plan_items 存在循环依赖', 'action_invalid_plan');

  return { type: 'plan', plan_items: normalized };
}

function validateCallTool(payload, allowedTools){
  assertNoExtraKeys(payload, ['type', 'tool_name', 'arguments'], 'call_tool');
  const toolName = assertString(payload.tool_name, 'tool_name', { min: 1, max: 128 });
  if (!/^[a-z][a-z0-9_.-]*$/.test(toolName)) fail('tool_name 含非法字符', 'action_invalid_field');
  if (allowedTools != null){
    const set = allowedTools instanceof Set ? allowedTools : new Set(allowedTools);
    if (!set.has(toolName)) fail(`工具不在当前任务允许集合内：${toolName}`, 'action_tool_not_allowed');
  }
  if (!isPlainObject(payload.arguments)) fail('arguments 必须是 JSON 对象', 'action_invalid_field');
  assertDepth(payload.arguments, 'arguments');
  if (Buffer.byteLength(JSON.stringify(payload.arguments), 'utf8') > 32 * 1024){
    fail('arguments 超过 32KB', 'action_too_large');
  }
  return { type: 'call_tool', tool_name: toolName, arguments: structuredClone(payload.arguments) };
}

function validateAskUser(payload){
  assertNoExtraKeys(payload, ['type', 'question', 'input_schema'], 'ask_user');
  const question = assertString(payload.question, 'question', { min: 1, max: 2000 });
  const schema = payload.input_schema;
  if (!isPlainObject(schema)) fail('input_schema 必须是对象', 'action_invalid_field');
  assertNoExtraKeys(schema, ['type', 'properties'], 'input_schema');
  if (schema.type !== 'object') fail('input_schema.type 必须是 object', 'action_invalid_field');
  if (!isPlainObject(schema.properties)) fail('input_schema.properties 必须是对象', 'action_invalid_field');
  const keys = Object.keys(schema.properties);
  if (keys.length < 1) fail('input_schema 至少需要 1 个字段', 'action_invalid_field');
  if (keys.length > 5) fail('ask_user 最多 5 个字段', 'action_invalid_field');
  const properties = {};
  for (const key of keys){
    const field = schema.properties[key];
    if (!isPlainObject(field)) fail(`input_schema.properties.${key} 必须是对象`, 'action_invalid_field');
    assertNoExtraKeys(field, ['type', 'description', 'required', 'example'], `input_schema.properties.${key}`);
    if (!FIELD_TYPES.has(field.type)) fail(`input_schema.properties.${key}.type 不合法`, 'action_invalid_field');
    if (field.description != null) assertString(field.description, `input_schema.properties.${key}.description`, { max: 500 });
    if (field.required != null && typeof field.required !== 'boolean') fail('required 必须是布尔值', 'action_invalid_field');
    properties[key] = { ...field };
  }
  assertDepth(properties, 'input_schema');
  return { type: 'ask_user', question, input_schema: { type: 'object', properties } };
}

function validateFinish(payload){
  assertNoExtraKeys(payload, ['type', 'summary', 'artifact_refs', 'citations'], 'finish');
  const summary = assertString(payload.summary, 'summary', { min: 1, max: 8000 });
  const artifactRefs = payload.artifact_refs == null ? [] : assertStringArray(payload.artifact_refs, 'artifact_refs', 50);
  const citations = payload.citations == null ? [] : assertStringArray(payload.citations, 'citations', 200);
  return { type: 'finish', summary, artifact_refs: artifactRefs, citations };
}

function validateFail(payload){
  assertNoExtraKeys(payload, ['type', 'error_code', 'message'], 'fail');
  const code = assertString(payload.error_code, 'error_code', { min: 1, max: 64 });
  if (!/^[a-z][a-z0-9_]*$/.test(code)) fail('error_code 只能包含小写字母、数字和下划线', 'action_invalid_field');
  const message = assertString(payload.message, 'message', { min: 1, max: 2000 });
  return { type: 'fail', error_code: code, message };
}

/**
 * 严格解析模型输出为一个 AgentAction。
 * @param {string|object} raw 模型文本或已解析对象
 * @param {{allowedTools?: string[]|Set<string>}} [options]
 */
export function parseAgentAction(raw, { allowedTools = null } = {}){
  const payload = typeof raw === 'string' ? parseJsonText(raw) : raw;
  if (!isPlainObject(payload)) fail('action 必须是 JSON 对象', 'action_invalid');
  assertDepth(payload, 'action');
  if (typeof payload.type !== 'string') fail('action.type 必须是字符串', 'action_invalid');
  switch (payload.type){
    case 'plan': return validatePlan(payload);
    case 'call_tool': return validateCallTool(payload, allowedTools);
    case 'ask_user': return validateAskUser(payload);
    case 'finish': return validateFinish(payload);
    case 'fail': return validateFail(payload);
    default: fail(`未知 action.type：${payload.type}`, 'action_unknown_type');
  }
}
