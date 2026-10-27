import type { ChatDelta, TokenUsage } from "@herta/protocol";
import { addUsage } from "@herta/core";

export interface Collected {
  text: string;
  /** 这条流末尾的用量回执；接口没给就是 null。 */
  usage: TokenUsage | null;
}

/**
 * 拼正文，顺手把用量接住。
 *
 * 一圈对话里 mood / 复核 / 重说 都是独立的短请求，各自有一份 usage；
 * 只拼正文不看回执，徽章上的数就只剩主对话那一次。
 */
export async function collectDetailed(gen: AsyncGenerator<ChatDelta>): Promise<Collected> {
  let text = "";
  let usage: TokenUsage | null = null;
  let calls = 0;
  for await (const d of gen) {
    if (d.type === "text") text += d.text;
    else if (d.type === "usage") {
      calls += 1;
      usage = addUsage(usage ?? { prompt: 0, completion: 0, cached: 0 }, d.usage);
    }
  }
  return { text, usage: usage ? { ...usage, calls } : null };
}

/** 只要正文的地方（视觉描述、导入之类）还用这个。 */
export async function collect(gen: AsyncGenerator<ChatDelta>): Promise<string> {
  return (await collectDetailed(gen)).text;
}
