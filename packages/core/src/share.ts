/**
 * 从 DeepSeek 的**分享链接**里取对话。
 *
 * 这是目前最干净的一条导入通道：分享页的数据接口是公开的
 * `GET https://chat.deepseek.com/api/v0/share/content?share_id=…`，
 * 不需要任何登录态，返回的就是完整 JSON（不是 DOM，不是滚出来的）。
 *
 * 数据形状（2026-10 实测）：
 *   data.biz_data.messages[] = { message_id, parent_id, role: USER|ASSISTANT, inserted_at, fragments[] }
 *   fragment.type ∈ REQUEST | THINK | RESPONSE | TOOL_SEARCH | TOOL_OPEN | TIP | FILE
 *
 * 三条规矩：
 *   1. 只认 REQUEST / RESPONSE。THINK 是别人的思维链，不进她的话。
 *   2. 按 parent_id 走主链——分享数据可能带着被编辑/重生的分支，顺次读会重复。
 *   3. 连续同角色合并。一回合有时被拆成多条 message。
 */

import type { ImportedMessage, ImportedSession } from "../../protocol/src/index.ts";

export const SHARE_API = "https://chat.deepseek.com/api/v0/share/content?share_id=";

/** 从一堆可能的粘贴形式里认出 share id：整条链接、带参数的链接、或者裸 id。 */
export function shareIdFromInput(input: string): string | null {
  const text = String(input ?? "").trim();
  if (!text) return null;
  const m = text.match(/\/share\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{8,}$/.test(text)) return text;
  return null;
}

interface Fragment {
  type?: string;
  content?: string;
}

interface ShareMessage {
  message_id?: number;
  parent_id?: number | null;
  role?: string;
  inserted_at?: number;
  fragments?: Fragment[];
}

function textOf(message: ShareMessage, role: "user" | "assistant"): string {
  const want = role === "user" ? "REQUEST" : "RESPONSE";
  return (message.fragments ?? [])
    .filter((f) => f.type === want && typeof f.content === "string" && f.content.trim())
    .map((f) => String(f.content))
    .join("\n\n")
    .trim();
}

export type ShareParseResult =
  | { ok: true; session: ImportedSession }
  | { ok: false; error: string };

/**
 * 把分享接口返回的 JSON 文本转成一个导入会话。
 * `titleHint` 用来兜底标题——分享接口返回的 title 常常是 "Shared Conversation"。
 */
export function parseSharedConversation(rawJson: string, titleHint = "从 DeepSeek 分享导入"): ShareParseResult {
  let root: unknown;
  try {
    root = JSON.parse(rawJson);
  } catch (e) {
    return { ok: false, error: "不是合法 JSON：" + (e instanceof Error ? e.message : String(e)) };
  }

  const biz = (root as { data?: { biz_data?: { messages?: ShareMessage[] } } })?.data?.biz_data;
  const messages = biz?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: "这个链接里没有对话（接口没返回 messages，可能链接失效或未公开）" };
  }

  // 走主链：从最后一条往上爬 parent_id
  const byId = new Map<number, ShareMessage>();
  for (const m of messages) if (typeof m.message_id === "number") byId.set(m.message_id, m);

  const chain: ShareMessage[] = [];
  const seen = new Set<number>();
  let cur: ShareMessage | undefined = messages[messages.length - 1];
  while (cur) {
    const id = cur.message_id;
    if (typeof id === "number") {
      if (seen.has(id)) break;
      seen.add(id);
    }
    chain.push(cur);
    const parent: number | null | undefined = cur.parent_id;
    cur = typeof parent === "number" ? byId.get(parent) : undefined;
  }
  chain.reverse();

  const merged: ImportedMessage[] = [];
  for (const m of chain) {
    const role = m.role === "USER" ? "user" : "assistant";
    const text = textOf(m, role);
    if (!text) continue;
    const at = typeof m.inserted_at === "number" ? new Date(m.inserted_at * 1000).toISOString() : undefined;
    const last = merged[merged.length - 1];
    if (last && last.role === role) last.text = last.text + "\n\n" + text;
    else merged.push({ role, text, ...(at ? { at } : {}) });
  }

  if (merged.length === 0) return { ok: false, error: "解析后一句正文都没有" };

  const first = merged[0];
  return {
    ok: true,
    session: {
      id: "share-" + (chain[0]?.message_id ?? 0) + "-" + merged.length,
      title: titleHint,
      startedAt: first.at ?? "",
      messages: merged,
    },
  };
}
