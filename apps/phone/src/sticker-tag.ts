/**
 * 给表情打标签。
 *
 * 不打标的库，她挑表情只能随机——那和"互发表情"是两回事。标签只有在配了视觉模型
 * 时才打得出来；没配就退回文件名（文件名本来也参与匹配），不报错、不挡加图。
 */

import type { ChatPart } from "@herta/protocol";
import { collect } from "./stream.ts";
import type { ChatTransport } from "./transport.ts";

const TAG_PROMPT =
  "这是一张聊天用的表情包。用 2~4 个中文词写出它表达的情绪或梗，只给词，顿号分隔。" +
  "不要句子，不要解释，不要引号。";

/**
 * 看一眼这张表情，给它几个词。
 * 失败就返回空数组——打标是锦上添花，不该让「加一张表情」这件事失败。
 */
export async function tagSticker(
  transport: ChatTransport,
  cfg: { apiKey: string; baseUrl: string; model: string },
  dataUrl: string
): Promise<string[]> {
  if (!cfg.model) return [];
  const parts: ChatPart[] = [
    { type: "text", text: TAG_PROMPT },
    { type: "image_url", image_url: { url: dataUrl } },
  ];
  try {
    const raw = await collect(
      transport.stream({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        messages: [{ role: "user", content: parts }],
        maxTokens: 40,
      })
    );
    return raw
      .replace(/[。.！!？?"'“”「」]/g, "")
      .split(/[、,，\s/]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= 8)
      .slice(0, 4);
  } catch {
    return [];
  }
}
