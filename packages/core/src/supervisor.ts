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
  /**
   * 这一轮她真动手查到的回执（看了时间、搜到什么、算出什么……）。
   *
   * 复核以前只看得到"最近的对话"——那是回合**开始前**的历史，
   * 本轮工具回执到回合结束才写回去，所以她这轮查完时间再说错，复核抓不到。
   * 传这里就等于把"她手里实际拿着的东西"一起交给复核。
   *
   * 可选；不给、给空数组、给的全是空白时，提示词与没有这个字段之前逐字一致。
   * 长度上限由 clipToolReceipts 负责裁，别把提示词撑爆。
   */
  toolReceipts?: readonly string[];
}

/**
 * 工具回执进复核提示词前的上限。
 * 回执是工具原样返回的长文本（网页正文、文件内容），整段塞进去会把提示词撑爆；
 * 复核要核对的是时间、日期、数字、状态这类短事实，留这么多字已经够用。
 */
export const REVIEW_RECEIPT_LIMITS = {
  /** 单条最多留多少字（含截断标记）。 */
  perItem: 500,
  /** 全部回执合计最多留多少字（含每条的 "- " 占位）。 */
  total: 2000,
} as const;

/** 单条回执被截断时挂的尾巴——让复核知道"后面还有，只是没给你看"，别拿它当全文。 */
const RECEIPT_TRUNCATED_MARK = "…（已截断）";

/** 复核提示词里「我刚才内心想的」这一块的标题；回执段插在它前面。 */
const THOUGHT_ANCHOR = "### 我刚才内心想的";

const RECEIPT_SECTION_HEADING = "### 我这轮亲手查到的记录";

const RECEIPT_SECTION_INTRO =
  "（下面每一条都是我这一轮真动手查到的结果，按发生顺序，不是回忆、不是推测。我接下来要说出口的话如果跟其中任何一条对不上——时间、日期、数字、状态、有没有这回事——就是错的，判不过。）";

/**
 * 把回执裁进上限：单条 perItem 字、合计 total 字（含列表符号）。
 * 超出合计就整条不再收——半条回执比没有更坏，复核会拿半句话当事实。
 */
export function clipToolReceipts(receipts: readonly string[] | undefined): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const raw of receipts ?? []) {
    const text = String(raw ?? "").trim();
    if (text.length === 0) continue;
    const clipped =
      text.length > REVIEW_RECEIPT_LIMITS.perItem
        ? text.slice(0, REVIEW_RECEIPT_LIMITS.perItem - RECEIPT_TRUNCATED_MARK.length) + RECEIPT_TRUNCATED_MARK
        : text;
    const cost = clipped.length + 2; // "- " 也占位
    if (used + cost > REVIEW_RECEIPT_LIMITS.total) break;
    kept.push(clipped);
    used += cost;
  }
  return kept;
}

/** 回执段；没有可用回执时返回空串——调用方据此保持提示词原样。 */
function renderToolReceipts(input: ReviewInput): string {
  const items = clipToolReceipts(input.toolReceipts);
  if (items.length === 0) return "";
  return (
    RECEIPT_SECTION_HEADING +
    "\n" +
    RECEIPT_SECTION_INTRO +
    "\n" +
    items.map((text) => "- " + text).join("\n") +
    "\n\n"
  );
}

/** 把回执段插在「我刚才内心想的」之前：最近的对话之后、待审台词之前，正是桌面版放完成记录的位置。 */
function withToolReceipts(user: string, receipts: string): string {
  if (receipts.length === 0) return user;
  const at = user.lastIndexOf(THOUGHT_ANCHOR);
  // 认不出的提示词（换过素材包）：宁可放最前面，也不猜一个错位置把它塞进台词里。
  if (at < 0) return receipts + user;
  return user.slice(0, at) + receipts + user.slice(at);
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

  // 没有回执时 withToolReceipts 原样返回，两条消息与加这个功能之前逐字一致。
  const receipts = renderToolReceipts(input);
  const sep = code.USER_MESSAGE_SEPARATOR;
  const at = typeof sep === "string" && sep.length > 0 ? prompt.indexOf(sep) : -1;
  if (at <= 0) return [{ role: "user", content: withToolReceipts(prompt, receipts) }];
  return [
    { role: "system", content: prompt.slice(0, at) },
    { role: "user", content: withToolReceipts(prompt.slice(at + sep.length), receipts) },
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
