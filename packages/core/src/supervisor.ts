/**
 * 复核：她说出口之前，先让她自己审一遍。
 *
 * 这是桌面版最像"她"的一环——不是安全过滤，是她自己看不上自己那句话。
 * 提示词与四步评分标准是桌面版原文（素材），从 `prompts-code.zh.mjs` 注入；
 * 这里只负责"怎么调用它、怎么切消息、打回几次"。
 *
 * 打回的话术（supervisor_veto / rethink / respeak）也来自素材的 hints。
 */

import type { Block, ChatMessage } from "../../protocol/src/index.ts";
import type { Verdict } from "./tags.ts";

export type { ChatMessage };

/** 素材包提供的桌面版原文函数。core 不直接 import 那 824KB，由调用方注入。 */
export interface PromptCode {
  buildSupervisorPrompt(input: unknown): { prompt: string };
  USER_MESSAGE_SEPARATOR: string;
}

export interface ReviewInput {
  /** 这一轮的废案样本（与"想""说"两趟共用同一批）。 */
  feianFewShots: readonly string[];
  lang: string;
  /** 这一轮判定的心情（八种之一）。 */
  currentState: string;
  recentRecord: readonly Block[];
  /** 刚才"想"出来的那段；没想就直接说时用占位句。 */
  currentTurnThought: string;
  candidateSpeech: string;
}

/**
 * 桌面版把 system 与 user 塞在同一个字符串里、用分隔符隔开。
 * 拆成两条消息是为了让模型分清"规则"与"这一次的材料"——桌面版靠分隔符，
 * 这边靠 role，等价但更不容易被长上下文淹没。
 */
export function buildReviewMessages(input: ReviewInput, code: PromptCode): ChatMessage[] {
  const { prompt } = code.buildSupervisorPrompt({
    feianFewShots: [...input.feianFewShots],
    lang: input.lang,
    currentState: input.currentState,
    recentRecord: [...input.recentRecord],
    currentTurnThought: input.currentTurnThought || "（这一回没想过，直接想说）",
    candidateSpeech: input.candidateSpeech,
    sessionReceipts: [],
  });

  const sep = code.USER_MESSAGE_SEPARATOR;
  const at = typeof sep === "string" && sep.length > 0 ? prompt.indexOf(sep) : -1;
  if (at <= 0) return [{ role: "user", content: prompt }];
  return [
    { role: "system", content: prompt.slice(0, at) },
    { role: "user", content: prompt.slice(at + sep.length) },
  ];
}

export const REVIEW_POLICY = {
  /** 打回后最多"重想重说"几轮。桌面版是 2；再多她会开始自我怀疑，语气就散了。 */
  maxRetries: 2,
} as const;

export type ReviewAction = "pass" | "redo";

/** 复核之后该干什么。占位与空回复一律按"重说"处理，不算过。 */
export function decideReview(verdict: Verdict, attempt: number, speech: string): ReviewAction {
  if (verdict.ok && speech.trim().length > 0) return "pass";
  if (attempt >= REVIEW_POLICY.maxRetries) return "pass";
  return "redo";
}

/**
 * 被打回时给她的话术。素材里的占位符是 `{{reason}}`，外面那对〔〕要去掉——
 * 她在正文里说话时不需要那层壳。
 */
export function vetoHints(hints: Record<string, string>, reason: string | null): {
  rethink: string;
  respeak: string;
  veto: string;
} {
  const fill = (t: string | undefined): string =>
    String(t ?? "")
      .replace(/\{\{\s*reason\s*\}\}/g, reason ?? "")
      .replace(/^〔|〕$/g, "");
  return {
    rethink: fill(hints.supervisor_rethink),
    respeak: fill(hints.supervisor_respeak || hints.supervisor_veto),
    veto: fill(hints.supervisor_veto),
  };
}
