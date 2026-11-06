/**
 * 点开一条读原文：抓网页 → 洗成正文 → 让她压成「要点 + 阅读稿」。
 *
 * 抓取走 transport.getText：原生通道绕 CORS，APK 里能读大多数站点；
 * 浏览器里多半被跨域挡住，会返回一句人话错误，页面照常能看摘要。
 */

import {
  htmlToArticleText,
  parseArticleDigest,
  type BroadcastDigest,
  type BroadcastItem,
} from "@herta/core";
import { collectDetailed } from "../stream.ts";
import { recordUsageFrom } from "../usage-ledger.ts";
import { pickTransport, type ChatTransport } from "../transport.ts";
import type { Settings } from "../settings.ts";

const TIMEOUT_MS = 90_000;
/**
 * 4096 —— 跟桌面信息流的 side model 同一个上限（flowSideModel）。
 * 之前给 1800：detail 2400 字的稿子会在 JSON 中间被截断，解析必挂。
 */
const MAX_TOKENS = 4096;
/** 稿子不是 JSON 就重说一次；两次都不成形才认失败。 */
const ATTEMPTS = 2;

function systemPrompt(): string {
  return [
    "把下面这篇网页写成一篇便于阅读的短文。只回复 JSON：{\"detail\":\"…\",\"points\":[\"…\"]}。",
    "detail 用 Markdown，不超过 2400 字符：先写两三句导语；再分两到四个小节，每节以「### 小标题」开头，正文一两段短段落或列表；网页里有可以并列比较的数字或规格时，加一个不超过 6 行、4 列的 Markdown 表格。不用链接、图片、代码块或 HTML，可用 **加粗** 标出关键数字。",
    "points 最多 5 条要点，每条不超过 80 个字。",
    "只用网页里写了的内容，不添加别处的事实，也不加评价；无论原文什么语言，都用简体中文写。",
    "整条回复必须能被 JSON.parse 直接解析：detail 里的换行写成转义的 \\n，不要在 JSON 外面写解释，也不要用代码围栏。",
  ].join("\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** 读一条：抓不到/读不出都抛人话，交给页面显示重试。 */
export async function readArticle(
  item: BroadcastItem,
  settings: Settings,
  transport: ChatTransport = pickTransport()
): Promise<BroadcastDigest> {
  if (!settings.apiKey) throw new Error("先在设置里填 API Key。");
  if (!item.url) throw new Error("这条没有原文链接。");

  let html: string;
  try {
    html = await transport.getText(item.url);
  } catch (error) {
    throw new Error("原文没抓到：" + messageOf(error));
  }
  const text = htmlToArticleText(html);
  if (text.length < 200) {
    throw new Error("这段正文没抓下来（可能要登录，或者正文都在脚本里）。");
  }

  const userText = "标题：" + item.title + "\n来源：" + item.source + "\n正文：\n" + text;
  let raw = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const seen = await collectDetailed(
        transport.stream({
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.model,
          maxTokens: MAX_TOKENS,
          signal: ac.signal,
          messages: [
            { role: "system", content: systemPrompt() },
            { role: "user", content: userText },
            ...(attempt === 0
              ? []
              : [
                  {
                    role: "user" as const,
                    content:
                      "上一次的回复不是合法的 JSON（可能被截断，或者 JSON 外面有别的字）。只回复那一个 JSON 对象，不要解释，不要围栏。",
                  },
                ]),
          ],
        })
      );
      // B14：读原文（把网页正文讲成一段话）单独一条链路
      recordUsageFrom("reader", seen.usage);
      raw = seen.text;
    } finally {
      clearTimeout(timer);
    }
    const digest = parseArticleDigest(raw);
    if (digest) return digest;
  }
  throw new Error("读完了，但稿子没成形，再来一次。");
}
