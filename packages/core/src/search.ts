/**
 * 全文检索：在她的会话和记忆里找东西。
 *
 * 为什么不做倒排索引：手机上通常只有几十个会话、几十条记忆，一条 600 多消息的
 * 导入对话也就几十万字。**线性扫一遍是毫秒级的**，而维护一份索引要处理增量、删除、
 * 重命名——那才是真正的复杂度来源。等真的卡了再说。
 *
 * 匹配规则故意简单：忽略大小写与多余空白，中文按子串、英文按词。不做分词，
 * 因为"模拟宇宙"这种词分开搜反而更难用。
 */

import type { Session } from "../../protocol/src/index.ts";
import { READABLE_FILE_EVENT_NOTE } from "./files.ts";
import { memoryTitle, type MemoryRecord } from "./memory.ts";

export interface BlockHit {
  /** 会话里第几块，用来跳转。 */
  index: number;
  /** 命中处前后一小段，给列表显示。 */
  snippet: string;
}

export interface SessionHit {
  sessionId: string;
  title: string;
  hits: BlockHit[];
  score: number;
}

export interface MemoryHit {
  name: string;
  title: string;
  snippet: string;
  score: number;
}

const MAX_HITS_PER_SESSION = 3;

export function normalizeQuery(query: string): string {
  return String(query ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function blockText(block: { kind: string; text?: string; body?: string }): string {
  return String(block.text ?? block.body ?? "");
}

/** 命中处截一段，前后各留 radius 个字符；截断处加省略号。 */
export function snippetOf(text: string, query: string, radius = 28): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, radius * 2) + (flat.length > radius * 2 ? "…" : "");
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + query.length + radius);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

/** 在会话里搜。命中多的排前面；标题命中算加权。 */
export function searchSessions(sessions: readonly Session[], query: string, limit = 20): SessionHit[] {
  const q = normalizeQuery(query);
  if (!q) return [];

  const out: SessionHit[] = [];
  for (const session of sessions) {
    const hits: BlockHit[] = [];
    for (const [index, block] of session.blocks.entries()) {
      // 文件库事件（hidden 或老版本没标记的）聊天里不显示，搜到了也没法跳，别占命中
      if (block.kind === "system" && (block.hidden || READABLE_FILE_EVENT_NOTE.test(block.body))) continue;
      const text = blockText(block as { kind: string; text?: string; body?: string });
      if (!text) continue;
      if (text.toLowerCase().includes(q)) {
        hits.push({ index, snippet: snippetOf(text, q) });
        if (hits.length >= MAX_HITS_PER_SESSION) break;
      }
    }
    const titleMatch = session.title.toLowerCase().includes(q);
    if (hits.length === 0 && !titleMatch) continue;
    out.push({
      sessionId: session.id,
      title: session.title,
      hits,
      score: hits.length + (titleMatch ? 2 : 0),
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 在记忆里搜。正文和标题都算，命中的给一小段。 */
export function searchMemories(records: readonly MemoryRecord[], query: string, limit = 20): MemoryHit[] {
  const q = normalizeQuery(query);
  if (!q) return [];

  const out: MemoryHit[] = [];
  for (const record of records) {
    if (record.forgotten) continue;
    const title = memoryTitle(record);
    const inTitle = title.toLowerCase().includes(q);
    const body = String(record.body ?? "");
    const inBody = body.toLowerCase().includes(q);
    if (!inTitle && !inBody) continue;
    out.push({
      name: record.name,
      title,
      snippet: inBody ? snippetOf(body, q) : title,
      score: (inTitle ? 3 : 0) + (inBody ? 1 : 0),
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
