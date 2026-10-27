/**
 * 会话的形状与演化。这里只放纯函数——落库在 apps/phone 的 storage.ts。
 *
 * 一条规矩：**会话是她的上下文，不是聊天记录**。标题、时间、块顺序都会影响
 * 下一轮喂给她什么；所以「改标题」「追加块」这类动作都要有唯一的入口，
 * 不能让 UI 各处自己拼。
 */

import type { Block, Session } from "../../protocol/src/index.ts";
import { isUserTurn, userTurnSummary } from "./sticker.ts";

export const EMPTY_TITLE = "新的对话";

/** 从第一条用户消息里取标题：她不负责起名，模型起名留到 M2 的 dream 之后。 */
export function deriveTitle(blocks: readonly Block[], max = 16): string {
  const first = blocks.find(isUserTurn);
  if (!first) return EMPTY_TITLE;

  // 只发图或只发了一张表情时，一个字的正文都没有：标题不能因此退回「新的对话」。
  const flat = userTurnSummary(first);
  if (!flat) return EMPTY_TITLE;

  // 优先在句末标点处断，断不出来再按字数硬截——手机上的标题就一行。
  const head = flat.split(/(?<=[。！？!?…])/)[0] ?? flat;
  const picked = head.length > max ? head.slice(0, max) + "…" : head;
  return picked.trim() || EMPTY_TITLE;
}

export function createSession(now: Date = new Date()): Session {
  const iso = now.toISOString();
  return {
    id: crypto.randomUUID(),
    title: EMPTY_TITLE,
    origin: "phone",
    createdAt: iso,
    updatedAt: iso,
    blocks: [],
  };
}

/** 追加块并推进时间；标题还空着就顺手补上。 */
export function appendBlocks(session: Session, blocks: readonly Block[], now: Date = new Date()): Session {
  const merged = [...session.blocks, ...blocks];
  return {
    ...session,
    blocks: merged,
    title: session.title === EMPTY_TITLE ? deriveTitle(merged) : session.title,
    updatedAt: now.toISOString(),
  };
}

/** 撤回最后一轮（用户说错话时用）：从最后一条用户消息开始往后全丢。 */
export function retractLastTurn(session: Session): Session {
  let cut = -1;
  for (let i = session.blocks.length - 1; i >= 0; i -= 1) {
    // 你发一张表情也是一轮的开头：撤回到那张表情，而不是把上一轮的台词也一起吞掉
    if (isUserTurn(session.blocks[i])) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return session;
  return { ...session, blocks: session.blocks.slice(0, cut) };
}

/**
 * 喂给模型的那一段记录。
 *
 * 截断必须发生在**整轮**边界上：只切一半会把「他说了一句、她没回」这种残局喂进去。
 * 代价是结果可能比 maxBlocks 多几条——宁可多喂一轮，也不从一个说不通的地方开始。
 * 所以 maxBlocks 是下限而不是上限。
 */
export function trimForContext(blocks: readonly Block[], maxBlocks: number): Block[] {
  if (maxBlocks <= 0 || blocks.length <= maxBlocks) return [...blocks];

  let start = blocks.length - maxBlocks;
  while (start > 0 && !isUserTurn(blocks[start])) start -= 1;
  return blocks.slice(start);
}
