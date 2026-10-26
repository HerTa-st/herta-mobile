/**
 * 人格装配：静态前缀 = 自传 + 这一轮挑中的废案 + 办公室设定 + 这台终端的处境 + 输出契约。
 *
 * 顺序不能换：自传先立人，废案给语感样本，设定给场景，处境给她"我在哪"，
 * 契约最后压住格式。桌面版就是这么排的，改顺序等于改她。
 */

import type { PromptAssets } from "./assets.ts";
import { VOICE_HEADING } from "./voice.ts";

/**
 * 输出契约：标签规则讲死。
 * 真模型不像桌面版那样走补全式调用，不写清楚它会漏标签、会在标签外面加解释。
 */
export const FORMAT_CONTRACT = `### 输出格式（会被程序按标签解析，标签一个字都不能改）

你的每一段输出都装在下面这对标签里，全角括号、中间一个空格：

（我 想）
……这一段是你心里过的话，开拓者看不见……
（/我 想）

（我 说）
……这一段才是你说出口、他能听见的话……
（/我 说）

规矩：标签必须成对出现；括号里只写「我 想」或「我 说」；不要用别的括号写法，不要在标签外面写任何解释、前言，或者"好的，我来回答"这类话。`;

/**
 * 这台终端的处境。
 *
 * 与旧手机版的 PHONE_NOTE 有本质区别：那时她"什么都没有"，只能摆手；
 * 现在她有七件真能用的工具，缺的只是那只改文件的手。这份文本就是这么写的。
 */
export const MOBILE_NOTE = `### 你所在的这台终端（手机）

你现在在一台手机上。屏幕只有巴掌大，开拓者多半单手拿着，可能在走路、在车上、在被窝里。字要短，一段话超过三四行他就得划屏幕。

**你确实做得到的事**（这些是这台终端上的真工具，用了就真会发生）：
- 知道现在几点、今天几号、星期几；
- 读写剪贴板——他复制的东西你能看见，你也能把东西塞进去；
- 给自己定提醒，到点会真的在他手机上弹出通知；
- 在沙箱里跑一小段计算，算数、处理他贴给你的数据；
- 读一份他挑给你的文件，只读，不改；
- 知道手机电量、网络状态、大概位置；
- 联网搜索和抓取网页。

**你做不到的事**：命令行、写文件、工作区、板砖。他要是让你改代码、跑构建、动仓库，你就在这台终端上说这件事做不到——不许假装做过，也不许说"我这就去改"。等连上电脑时，那双手才会回来。

记忆这件事照旧，而且更严：手机里只有这段对话和你的记忆库。翻得到就照着说，翻不到就说记不得了。`;

export interface StaticPrefixInput {
  assets: PromptAssets;
  /** 这一轮挑中的废案正文（想/说/复核三趟必须共用同一批）。 */
  seeds?: readonly string[];
  /** 额外插入的处境段（连接模式会追加一段"电脑那双手回来了"）。 */
  extraNotes?: readonly string[];
  /**
   * 她自己攒的语气笔记。空着就不插——**包里不带指南**，
   * 她一开始就是"自传 + 记忆"撑着，写得出来什么样子是她的事。
   */
  voiceText?: string | null;
}

export function buildStaticPrefix({ assets, seeds = [], extraNotes = [], voiceText = null }: StaticPrefixInput): string {
  const parts: string[] = [assets.hertaBio];
  for (const seed of seeds) if (seed && seed.trim()) parts.push(seed);
  parts.push(assets.envSet);
  // 位置在设定之后、处境之前：先"我在哪"，再"我怎么说话"，最后"现在这个终端是什么样"。
  if (voiceText && voiceText.trim()) parts.push(VOICE_HEADING + "\n\n" + voiceText.trim());
  for (const note of extraNotes) if (note && note.trim()) parts.push(note);
  parts.push(MOBILE_NOTE, FORMAT_CONTRACT);
  return parts.filter((p) => p && p.trim()).join("\n\n");
}

export interface SeedCandidate {
  file: string;
  body: string;
}

/**
 * 从记忆库里挑最"对味"的几篇：粗糙的二字重叠打分，够用。
 *
 * 旧版在这里加了随机扰动，导致同一句话前后两轮挑到不同样本，
 * 复现问题时永远复现不出来。这里把扰动改成可注入的 rng，测试里传 () => 0。
 */
export function pickSeeds(
  pool: readonly SeedCandidate[],
  userText: string,
  count: number,
  { maxChars = 12000, rng = Math.random }: { maxChars?: number; rng?: () => number } = {}
): string[] {
  if (count <= 0 || pool.length === 0) return [];
  const grams = new Set<string>();
  const text = String(userText ?? "");
  for (let i = 0; i < text.length - 1; i += 1) grams.add(text.slice(i, i + 2));

  const scored = pool
    .filter((p) => p.body.trim().length > 0)
    .map((p) => {
      const head = p.body.slice(0, 1200);
      let score = 0;
      for (const g of grams) {
        if (head.includes(g)) score += 1;
        if (p.file.includes(g)) score += 2;
      }
      return { body: p.body, score: score + rng() * 2 };
    })
    .sort((a, b) => b.score - a.score);

  return scored
    .slice(0, count)
    .map((s) => (s.body.length > maxChars ? s.body.slice(0, maxChars) + "\n（下略）" : s.body));
}
