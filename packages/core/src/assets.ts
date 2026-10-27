/**
 * 素材接缝。
 *
 * 桌面版把人格、复核、dream 全部泡在提示词里；这些东西是**素材**，不是算法。
 * 所以核心只声明"我需要什么素材"，由调用方（Node 测试 / 浏览器 / Capacitor）提供。
 * 好处：core 里没有一行 fs、没有一行 fetch，Node 里能直接测。
 */

import type { Lang } from "../../protocol/src/index.ts";

export interface PromptAssets {
  /** 她的自传（hertaBio），约 9.5k 字。人格的本体。 */
  hertaBio: string;
  /**
   * 办公室设定（envSet）已不再打包：她不再永远坐在同一个房间里。
   * 现在的"她在哪"由 presence.ts 按钟点算出来。
   */
  /**
   * 语气指南是桌面版的固定文本。**这个版本不再打包它**——
   * 她的语气改由自己攒的笔记决定（见 voice.ts），会随长期聊天变化。
   */
  /** 21 条输出话术：phase2_thought、supervisor_veto 等，按 key 取。 */
  hints: Record<string, string>;
  /** 八种心情各自的 preThink / preSpeak 基线。 */
  metaThink?: { preThink?: Record<string, string>; preSpeak?: Record<string, string> };
  /** 打包自带的废案种子（无记忆库时的兜底）。 */
  feianSeeds?: Record<string, string>;
  /** 36 篇开局独白：文件名 → 正文（正文里含「想」与「说」两轨）。 */
  openings?: Record<string, string>;
  /** 退役/被取代的种子，导入时要按 sha1 排除。 */
  retiredFeian?: string[];
  supersededFeianSha1?: string[];
}

export interface MoodPack {
  version: number;
  system: string;
  userInstruction: string;
  /** 八种心情的名字，判定时列给模型挑。 */
  moods: string[];
  /**
   * 带情绪的档位（被烦 / 被戳穿 / 被顶嘴 / 倾听）。
   *
   * 心情惯性只拦这一类：从平静档进到它们，必须真的踩到雷区或好感区；
   * 平静档之间（默认 ↔ 教学 ↔ 任务部署 ↔ 板砖代答）随语境微调是允许的。
   */
  volatile?: string[];
  sampleAnswer?: string;
}

export interface VoiceManifestEntry {
  path: string;
  [k: string]: unknown;
}

export interface VoicePack {
  /** 开局独白 id → opus 相对路径。 */
  openings: Record<string, string>;
  veto: string[];
  easterEgg?: string[];
}

export interface AssetSource {
  readonly lang: Lang;
  promptAssets(): Promise<PromptAssets>;
  mood(): Promise<MoodPack | null>;
  /** 记忆库里现存的废案文件名（排序稳定）。 */
  seedFiles(): Promise<string[]>;
  readSeed(file: string): Promise<string | null>;
  voice(): Promise<VoicePack>;
}
