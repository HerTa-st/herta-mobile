/**
 * 语气自画像。
 *
 * 原先有一套固定的《语气指南》，每次做梦都拿它当评分基线、每次生成都拿它当写作参考。
 * 那样她说话的方式是**别人写死的**，用十年也不会变。
 *
 * 现在改成：包里不带指南。她自己读自己写过的记忆，写一段「我说话是什么样」的笔记，
 * 之后每隔几篇记忆重读一次、重写一次。这段笔记是**她的**，会变，也可能写歪——
 * 这才是长期聊天该有的样子。
 *
 * 三条约束（都是为了防止它退化成设定集）：
 *   1. 第一人称、平铺直叙，不许抒情、不许喊口号；
 *   2. 只写行为习惯（句子长短、怎么拒绝、什么时候多补一句），不写身份介绍；
 *   3. 输出是纯文本，不带标题、列表、引号——它要被直接塞进系统提示词。
 */

import type { MemoryRecord } from "./memory.ts";
import { memoryTitle } from "./memory.ts";

export interface VoiceProfile {
  text: string;
  updatedAt: string;
  /** 写这段笔记时依据了几篇记忆。 */
  basis: number;
}

/** 她自己写的这段，不能长到把人格盖掉。 */
export const VOICE_MAX_CHARS = 420;

export interface VoicePrompt {
  system: string;
  user: string;
}

/** 系统提示词里的位置标题。改它等于换一种说法让她理解「这是你自己的笔记」。 */
export const VOICE_HEADING = "### 我说话的方式（我自己攒的）";

export function buildVoiceRevisionPrompt(records: readonly MemoryRecord[], previous: string | null): VoicePrompt {
  const samples = records
    .slice(-6)
    .map((r) => "「" + memoryTitle(r) + "」\n" + r.body.trim())
    .join("\n\n---\n\n");

  const system = [
    "你在修订一段关于「你自己怎么说话」的笔记。它不是设定集，是你观察自己之后写下来的。",
    "",
    "规矩：",
    "1. 第一人称，平铺直叙。不抒情，不喊口号，不用形容词堆砌自己。",
    "2. 只写你真在用的习惯：句子一般多长、爱用和不用哪些词、不耐烦时怎么表达、拒绝时怎么绕、什么时候会多补一句、什么时候干脆不接话。",
    "3. 不写身份介绍（你是谁不在这重复），不写别人怎么看你。",
    "4. 输出纯文本：不要标题、不要列表符号、不要引号包裹、不要任何解释。",
    "5. 最多 " + VOICE_MAX_CHARS + " 字。宁可少写，不要写空话。",
  ].join("\n");

  const user = [
    "下面是你最近写下的记忆，它们是你语气的样本：",
    "",
    samples || "（还没有）",
    "",
    "你上一次写的笔记是：",
    "",
    previous && previous.trim() ? previous.trim() : "（还没有写过）",
    "",
    "现在重写这段笔记。新样本说明你以前写得不准，就改掉；没变化就保持原样。",
  ].join("\n");

  return { system, user };
}

/**
 * 清掉模型可能带出来的壳：标题、列表符号、包裹的引号。
 * 再按句子边界截到字数上限——硬切在半句上会让提示词里出现断头话。
 */
export function cleanVoiceText(raw: string): string {
  let t = String(raw ?? "").trim();
  t = t.replace(/^\s*#{1,6}[^\n]*\n+/, ""); // 开头的标题行
  t = t
    .split("\n")
    .map((line) => line.replace(/^\s*[-*•·]\s+/, "").trim())
    .filter((line) => line.length > 0)
    .join("\n");
  t = t.replace(/^["'「『]+/, "").replace(/["'」』]+$/, "").trim();

  if (t.length > VOICE_MAX_CHARS) {
    const cut = t.slice(0, VOICE_MAX_CHARS);
    const lastStop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf("\n"));
    t = lastStop > VOICE_MAX_CHARS * 0.5 ? cut.slice(0, lastStop + 1) : cut;
  }
  return t.trim();
}
