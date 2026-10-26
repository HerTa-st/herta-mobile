/**
 * 开局独白。36 篇，每篇带一条 .opus 原声——她自己的声音。
 *
 * 桌面版每次新会话换一个开场；这里沿用。素材里的正文是一整段（含「想」与「说」两轨），
 * 音频是整篇一次录完的，所以播放与正文必须成套，不能拆开随机配。
 */

import type { VoicePack } from "./assets.ts";
import { parseNarrative } from "./narrative.ts";

export interface Opening {
  /** 素材文件名去掉 .txt，也是音频映射的键。 */
  key: string;
  thought: string;
  speech: string;
  /** 相对站点根的可播放路径；没有对应录音时为 null。 */
  audio: string | null;
}

/** manifest 里的路径是 `assets/voice/...`，而 assets/ 已经被摊到站点根，所以要去前缀。 */
function normalizeAudio(path: string | undefined): string | null {
  if (!path) return null;
  return path.replace(/^assets\//, "");
}

export function listOpenings(openings: Record<string, string>, voice: VoicePack): Opening[] {
  const out: Opening[] = [];
  for (const [file, raw] of Object.entries(openings)) {
    const key = file.replace(/\.txt$/, "");
    const n = parseNarrative(raw);
    out.push({
      key,
      thought: n.thought,
      speech: n.speech,
      audio: normalizeAudio(voice.openings[key]),
    });
  }
  // 素材是按编号命名的，排序稳定——不然每次启动顺序都可能变，没法复现。
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

export function pickOpening(openings: readonly Opening[], rng: () => number = Math.random): Opening | null {
  if (openings.length === 0) return null;
  return openings[Math.floor(rng() * openings.length)] ?? openings[0];
}
