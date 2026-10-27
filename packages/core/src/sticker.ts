/**
 * 表情：谁发的、算不算"这一轮是谁开的口"。
 *
 * 放在 core 里是因为三个地方都要按同一套规则读历史：拼转录（tags.ts）、
 * 切上下文（session.ts）、起标题（session.ts）。分散着写一次，就会有一处漏掉，
 * 表现是"她回了一张表情之后，你的下一句话被当成同一轮的开头"。
 *
 * 一条纪律：**表情没有台词**。它不挂在某句话的附件上，所以凡是在找"用户说的那句话"
 * 的地方，都要单独认它一次。
 */

import type { Block } from "../../protocol/src/index.ts";

/** 这一块是不是用户开的口：打字算，发一张表情也算。 */
export function isUserTurn(block: Block): boolean {
  return block.kind === "user" || (block.kind === "sticker" && block.from === "user");
}

/**
 * 用户这一轮的摘要，用来起会话标题。
 * 表情没有字，只能给一个占位——总比让标题退回「新的对话」好。
 */
export function userTurnSummary(block: Block): string {
  if (block.kind === "user") {
    return block.text.replace(/\s+/g, " ").trim() || (block.attachments?.length ? "（一张图）" : "");
  }
  if (block.kind === "sticker" && block.from === "user") return "（一张表情）";
  return "";
}
