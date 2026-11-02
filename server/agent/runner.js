// AgentRunner：受控的模型—工具循环（设计文档 §5.1、§5.3）。
// P0-1 只提供进程内单 Agent 循环，不依赖任务表；P0-2 在其外层增加租约、检查点与事件。
import crypto from 'node:crypto';
import { streamModel as defaultStreamModel } from './model-adapter.js';

function newToolCallId(){
  return 'call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/**
 * 执行一轮有限的“模型 → 工具 → 模型”循环。
 *
 * @param {object} opts
 * @param {object} opts.model 已解析的模型行（base_url/model_name/api_key）
 * @param {Array} opts.messages 初始消息（不含本轮追加）
 * @param {Array} [opts.tools] OpenAI tools 数组
 * @param {number} [opts.maxIterations=6] 最大工具轮次
 * @param {AbortSignal} [opts.signal]
 * @param {(call:{id:string,name:string,arguments:string}) => Promise<string|null>|string|null} [opts.executeTool]
 *        返回字符串作为工具结果；返回 null 表示跳过该调用（保持旧行为）。
 * @param {Function} [opts.onDelta] 文本增量
 * @param {Function} [opts.onToolCall] 工具调用开始
 * @param {Function} [opts.onToolResult] 工具结果
 * @param {Function} [opts.onIteration] 每轮工具调用后
 * @param {Function} [opts.streamModel] 可注入的流式模型函数（测试用）
 */
export async function runAgentLoop({
  model,
  messages,
  tools = [],
  temperature = 0.6,
  maxIterations = 6,
  signal,
  executeTool = null,
  onDelta,
  onToolCall,
  onToolResult,
  onIteration,
  streamModel = defaultStreamModel,
} = {}){
  if (!model) throw new Error('runAgentLoop 需要已解析的模型');
  const msgs = [...messages];
  let text = '';
  let iterations = 0;
  const toolCalls = [];

  while (true){
    const pending = [];
    let iterText = '';

    for await (const part of streamModel(model, msgs, {
      temperature,
      signal,
      tools: tools.length ? tools : undefined,
    })){
      if (signal?.aborted) break;
      if (part.toolCalls){ pending.push(...part.toolCalls); continue; }
      if (part.text){
        iterText += part.text;
        text += part.text;
        onDelta?.(part.text);
      }
    }

    if (!pending.length || signal?.aborted || ++iterations >= maxIterations) break;

    const calls = pending.map(c => ({
      id: c.id || newToolCallId(),
      name: c.name,
      arguments: c.arguments || '{}',
    }));

    msgs.push({
      role: 'assistant',
      content: iterText || null,
      tool_calls: calls.map(c => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    });

    for (const call of calls){
      toolCalls.push(call);
      onToolCall?.(call);
      const result = executeTool ? await executeTool(call) : null;
      // 保持旧聊天路径行为：未知工具不产生 tool 消息。
      if (result == null) continue;
      onToolResult?.(call, result);
      msgs.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }

    onIteration?.(iterations);
  }

  return { text, messages: msgs, iterations, toolCalls };
}
