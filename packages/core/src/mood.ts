/**
 * 八种心情。
 *
 * 素材里每种心情都带着一份 `preThink` / `preSpeak` 基线——同一句话，被烦版和倾听版
 * 说出来的密度完全不同。这是她"每天不一样"最便宜也最有效的一层。
 *
 * 判定本身是一次很便宜的调用：把所有心情名列给它，让它挑一个。
 *
 * 但"挑一个"不等于"每轮重抽"。人的情绪在短时间内是平稳波动的：
 *
 *   - **微调**：默认 / 教学版 / 任务部署版 / 板砖代答版 之间随语境挪一挪，是正常的——
 *     问原理就偏教学、派活就偏任务，这不叫心情变了。
 *   - **换档**：带情绪的档位（被烦版 / 被戳穿版 / 被顶嘴版 / 倾听版）只有在对话真的
 *     踩到雷区（被冒犯、被轻视、被当成程序、被命令、被冷落）或好感区（被认真对待、
 *     被需要、开拓者露出真实的痛处）时才进得去。从这些档位回落到平静档不需要触发——
 *     气是会消的。
 *
 * 分类器要在答案后面标一个触发位（`状态名|0或1`）。代码按这个位把关：没标触发位的，
 * 同一个带情绪的新状态连着提两次才认——一次是波动，两次才是变了。判不出状态就保持原样，
 * 心情判定失败不该把她重置成默认。
 *
 * 状态存在本地（storage 的 moodState），三小时没说话就不再算"现在的"。
 */

import type { MoodPack } from "./assets.ts";

export const DEFAULT_MOOD = "默认";

/** 三小时没说话，上一轮的心情就不再算"现在的"——情绪会自己落回去。 */
export const MOOD_TTL_MS = 3 * 60 * 60 * 1000;

/** 没标触发位时，同一个带情绪的新状态连着提两次才认。 */
export const MOOD_SWITCH_STREAK = 2;

export interface MoodState {
  mood: string;
  /** 上次判定的时间（毫秒）。 */
  at: number;
  /** 还没被认下来的新状态，与它连续被提出的次数。 */
  pending?: string;
  pendingCount?: number;
}

export interface MoodVerdict {
  /** 模型点名的状态；一个都认不出来是 null。 */
  mood: string | null;
  /** 模型说这一轮真的踩到雷区/好感区；没按格式回答（没有触发位）是 null。 */
  triggered: boolean | null;
}

export interface MoodDecision {
  mood: string;
  /** 要落盘的新状态。 */
  state: MoodState;
}

export interface MoodOptions {
  /**
   * 带情绪的档位。不给就当成"所有状态都要触发"——最保守的那种，
   * 宁可让她稳，也别让她一轮一个样。
   */
  volatile?: readonly string[];
}

export interface MoodPrompt {
  system: string;
  user: string;
}

/**
 * 组装判定用的提示词。`conversation` 是最近几轮的文本记录，
 * `previousMood` 是她现在的状态（没有就传 null）。
 */
export function buildMoodPrompt(
  pack: MoodPack,
  conversation: string,
  previousMood?: string | null
): MoodPrompt {
  const hot = pack.volatile && pack.volatile.length > 0 ? pack.volatile.join("、") : "带情绪的档位";
  const inertia = [
    "",
    "【情绪惯性】",
    previousMood ? "她现在的状态是「" + previousMood + "」。" : "她还没有状态。",
    "人的情绪在短时间内是平稳波动的：换话题、问新问题、安排任务、普通闲聊，都不等于心情变了。",
    "平静的档位之间可以随语境微调，不需要触发。",
    "只有这段对话真的踩到下面两种之一，才允许进到" + hot + "：",
    "- 雷区：被冒犯、被轻视、被当成程序或工具、被命令、被冷落、被否定；",
    "- 好感区：被认真对待、被理解、被需要、被依赖，或者开拓者露出真实的痛处。",
    "输出格式：状态名|触发，触发写 0 或 1（真的踩到雷区或好感区才写 1）。",
    "没踩到时，别把状态换成" + hot + "。",
  ].join("\n");
  return {
    system: pack.system,
    user: "下面是最近的对话（开拓者 + 黑塔 说话部分）：\n\n" + conversation + "\n\n" + pack.userInstruction + "\n" + inertia,
  };
}

/**
 * 从模型的回答里拆出「状态」与「触发位」。
 *
 * 容错：`倾听版|1`、`倾听版 | 1`、`我觉得是倾听版吧` 都认；触发位缺了就标 null，
 * 让 decideMood 走"连着两次"那条兜底。
 */
export function parseMoodVerdict(raw: string | null | undefined, moods: readonly string[]): MoodVerdict {
  const text = String(raw ?? "").trim();
  if (!text) return { mood: null, triggered: null };

  const cut = text.indexOf("|");
  const head = cut >= 0 ? text.slice(0, cut) : text;
  const mark = cut >= 0 ? text.slice(cut + 1) : "";
  const named = moods.filter((m) => m);
  const mood =
    named.find((m) => head.includes(m)) ??
    named.find((m) => text.includes(m)) ??
    null;

  let triggered: boolean | null = null;
  if (cut >= 0) {
    if (/1/.test(mark)) triggered = true;
    else if (/0/.test(mark)) triggered = false;
    else if (/触|是|true|yes/i.test(mark)) triggered = true;
    else if (/不|否|false|no/i.test(mark)) triggered = false;
  }
  return { mood, triggered };
}

/**
 * 用上一轮的状态把关这一轮的判定。
 *
 * 没有上一轮（或隔得太久）就以这一轮为起点。否则：
 *   认不出来 → 保持；一样 → 保持；进了平静档 → 允许（含气消了回落）；
 *   要进带情绪的档位 → 标了触发就换，明说没触发就按住，没标触发位则连着两次才认。
 */
export function decideMood(
  previous: MoodState | null,
  verdict: MoodVerdict,
  now: number,
  options: MoodOptions = {}
): MoodDecision {
  const proposed = verdict.mood;
  const volatile = options.volatile;
  const isHot = (m: string) => !volatile || volatile.includes(m);

  const expired = !previous || !Number.isFinite(previous.at) || now - previous.at > MOOD_TTL_MS;
  if (expired) {
    // 新的起点也一样：带情绪的档位没有触发就进不去，从平静档开始
    const mood = proposed && (!isHot(proposed) || verdict.triggered === true) ? proposed : DEFAULT_MOOD;
    return { mood, state: { mood, at: now } };
  }

  const keep: MoodDecision = { mood: previous.mood, state: { mood: previous.mood, at: now } };
  if (!proposed) return keep;
  if (proposed === previous.mood) return keep;

  const switchTo: MoodDecision = { mood: proposed, state: { mood: proposed, at: now } };

  // 平静档之间的微调、以及从带情绪档回落，都不需要触发
  if (!isHot(proposed)) return switchTo;

  if (verdict.triggered === true) return switchTo;
  if (verdict.triggered === false) return keep;

  // 没标触发位：同一份新状态连着出现两次才认
  const count = previous.pending === proposed ? (previous.pendingCount ?? 0) + 1 : 1;
  if (count >= MOOD_SWITCH_STREAK) return switchTo;
  return { mood: previous.mood, state: { mood: previous.mood, at: now, pending: proposed, pendingCount: count } };
}
