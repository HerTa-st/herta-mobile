/**
 * 工具循环。
 *
 * 桌面版的她会调工具，手机版原先只会说话。这里的区别不是"多了几个功能"，
 * 而是**她第一次能决定自己去看一眼**：查现在几点、读你贴的文件、搜一下再回答。
 *
 * 循环本身很短：发请求 → 模型要么说话、要么要调工具 → 调完把结果塞回去 → 再问一遍。
 * 全是工具的轮次里她一句话都没说，所以最后要保证有话说（见 `forceAnswer`）。
 *
 * 安全边界写在 `maxRounds`：她最多连着调这么多次。不设上限的话，
 * 一个想不清楚的模型能在这循环里烧掉你一整天的额度。
 */

import type { ChatDelta, ChatMessage, ToolCall, ToolSpec } from "../../protocol/src/index.ts";

export interface ToolResult {
  id: string;
  name: string;
  ok: boolean;
  content: string;
}

export interface ToolImpl {
  spec: ToolSpec;
  /** 执行。抛异常等于失败，由循环兜住。 */
  run(args: Record<string, unknown>): Promise<string>;
}

export interface ToolLoopDeps {
  stream(req: { messages: ChatMessage[]; tools: ToolSpec[]; maxTokens: number }): AsyncGenerator<ChatDelta>;
  tools: readonly ToolImpl[];
  maxRounds?: number;
  /** 每次调用前通知 UI（她要去做什么）。 */
  onToolCall?(call: ToolCall): void;
  onToolResult?(result: ToolResult): void;
  /** 每段正文的增量，UI 用来流式显示。 */
  onText?(text: string): void;
}

export interface ToolLoopResult {
  messages: ChatMessage[];
  /** 她最后说出口的话（所有正文轮次拼起来）。 */
  text: string;
  results: ToolResult[];
  rounds: number;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 跑一次带工具的对话。
 * 返回的 `messages` 是完整的一串（含 assistant 的 tool_calls 与 tool 结果），
 * 调用方可以把它存下来当下一轮的上下文。
 */
export async function runToolLoop(
  deps: ToolLoopDeps,
  seed: readonly ChatMessage[]
): Promise<ToolLoopResult> {
  const maxRounds = deps.maxRounds ?? 4;
  const byName = new Map(deps.tools.map((t) => [t.spec.name, t]));
  const messages: ChatMessage[] = [...seed];
  const results: ToolResult[] = [];
  let text = "";
  let rounds = 0;

  while (rounds < maxRounds) {
    rounds += 1;
    const callAcc = new Map<number, ToolCall>();
    let roundText = "";
    let finish: string | null = null;

    for await (const delta of deps.stream({
      messages,
      tools: deps.tools.map((t) => t.spec),
      maxTokens: 2048,
    })) {
      if (delta.type === "text") {
        roundText += delta.text;
        text += delta.text;
        deps.onText?.(delta.text);
      } else if (delta.type === "tool_call") {
        const cur = callAcc.get(delta.index) ?? { id: "", name: "", arguments: "" };
        if (delta.id) cur.id = delta.id;
        if (delta.name) cur.name = delta.name;
        if (delta.arguments) cur.arguments += delta.arguments;
        callAcc.set(delta.index, cur);
      } else {
        finish = delta.finishReason;
      }
    }

    const calls = [...callAcc.values()].filter((c) => c.name);

    if (calls.length === 0) {
      messages.push({ role: "assistant", content: roundText });
      break;
    }

    messages.push({ role: "assistant", content: roundText, tool_calls: calls });

    for (const call of calls) {
      deps.onToolCall?.(call);
      const impl = byName.get(call.name);
      let content: string;
      let ok = true;
      if (!impl) {
        ok = false;
        content = "没有这个工具：" + call.name;
      } else {
        try {
          content = await impl.run(parseArgs(call.arguments));
        } catch (e) {
          ok = false;
          content = "失败了：" + (e instanceof Error ? e.message : String(e));
        }
      }
      const result: ToolResult = { id: call.id, name: call.name, ok, content };
      results.push(result);
      deps.onToolResult?.(result);
      messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content });
    }

    if (finish === null) continue;
  }

  return { messages, text, results, rounds };
}
