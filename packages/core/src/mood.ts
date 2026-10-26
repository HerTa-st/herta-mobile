/**
 * 八种心情。
 *
 * 素材里每种心情都带着一份 `preThink` / `preSpeak` 基线——同一句话，被烦版和倾听版
 * 说出来的密度完全不同。这是她"每天不一样"最便宜也最有效的一层。
 *
 * 判定本身是一次很便宜的调用（十几个 token）：把所有心情名列给它，让它挑一个。
 * 不要求它解释，解释只会让它犹豫。
 */

import type { MoodPack } from "./assets.ts";

export const DEFAULT_MOOD = "默认";

export interface MoodPrompt {
  system: string;
  user: string;
}

/** 组装判定用的提示词。`conversation` 是最近几轮的文本记录。 */
export function buildMoodPrompt(pack: MoodPack, conversation: string): MoodPrompt {
  return {
    system: pack.system,
    user: "下面是最近的对话（开拓者 + 黑塔 说话部分）：\n\n" + conversation + "\n\n" + pack.userInstruction,
  };
}

/**
 * 从模型的回答里认心情。
 * 认不出来就按默认走——心情判定失败不该让整轮对话失败。
 */
export function parseMood(raw: string | null | undefined, moods: readonly string[]): string {
  const text = String(raw ?? "");
  if (!text) return DEFAULT_MOOD;
  for (const mood of moods) {
    if (mood && text.includes(mood)) return mood;
  }
  return DEFAULT_MOOD;
}
