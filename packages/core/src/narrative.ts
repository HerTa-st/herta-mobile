/**
 * 把她的一段输出拆成「想」与「说」。
 *
 * 旧版（herta-phone v0.1）是"先按正则抽，抽不到就剥首尾标签整段当内容"。
 * 那个兜底在**少一个闭合标签**时会闯祸：想的那一整段连同残标签一起被当成台词，
 * 交给复核——复核当然打回，于是每轮都白烧两次调用。
 *
 * 这里的规则改成"按标签位置切区间"，缺闭合标签时用下一个开标签当作边界：
 *
 *   两对都在   → 各取各的
 *   只有「说」 → 想 = 空
 *   只有「想」 → 说 = 「想」块之后剩下的文字（没有就留空，交给重说）
 *   一对也没有 → 说 = 整段去标签，想 = 空（模型彻底没守契约）
 *
 * 一条硬规矩：「想」永远不会自动变成「说」。把心里话当台词念出来，
 * 是最不能接受的一种坏输出——宁可这一轮空着让她重说。
 */

/**
 * 念出来的文本：把「（转了下椅子）」这种动作标注去掉。
 *
 * 动作是写给人看的，念出来就是一句奇怪的旁白。只去**短**括号标注：
 * 全角括号里的 1~20 字，或半角括号里带中文的短标注——`f(x)` 这种不能误伤。
 * 去完只剩空白就返回空串，调用方据此跳过这次合成。
 */
export function stripStageDirections(text: string): string {
  return String(text ?? "")
    .replace(/（[^（）]{1,20}）/g, "")
    .replace(/\((?=[^()]*[\u4e00-\u9fa5])[^()]{1,20}\)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/^[ \t]+|[ \t]+$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface Narrative {
  thought: string;
  speech: string;
  /** 输出里到底有没有出现过约定标签。没有说明模型没守契约，值得记一笔。 */
  tagged: boolean;
}

const LABEL = { thought: "想", speech: "说" };

interface Span {
  /** 开标签起点 */
  open: number;
  /** 内容起点 */
  bodyStart: number;
  /** 内容终点 */
  bodyEnd: number;
  /** 闭标签终点（缺闭合标签时为文本末尾） */
  close: number;
}

function findTagged(text: string, label: string): Span | null {
  const openMatch = new RegExp("（我\\s*" + label + "）").exec(text);
  if (!openMatch) return null;

  const bodyStart = openMatch.index + openMatch[0].length;
  const closeMatch = new RegExp("（/我\\s*" + label + "）").exec(text.slice(bodyStart));

  return {
    open: openMatch.index,
    bodyStart,
    bodyEnd: closeMatch ? bodyStart + closeMatch.index : text.length,
    close: closeMatch ? bodyStart + closeMatch.index + closeMatch[0].length : text.length,
  };
}

/** 去掉所有标签残留（包括写了半截的） */
export function stripTags(text: string): string {
  return text.replace(/（\/?我\s*[想说]）/g, "");
}

export function parseNarrative(raw: string | null | undefined): Narrative {
  const text = String(raw ?? "");
  const clean = (s: string): string => stripTags(s).trim();

  const thought = findTagged(text, LABEL.thought);
  const speech = findTagged(text, LABEL.speech);

  if (speech) {
    // 「想」的内容不能越过「说」的开标签：缺闭合标签时，边界就是对方。
    let inner = "";
    if (thought && thought.bodyStart < speech.open) {
      inner = text.slice(thought.bodyStart, Math.min(thought.bodyEnd, speech.open));
    }
    return { thought: clean(inner), speech: clean(text.slice(speech.bodyStart, speech.bodyEnd)), tagged: true };
  }

  if (thought) {
    return {
      thought: clean(text.slice(thought.bodyStart, thought.bodyEnd)),
      speech: clean(text.slice(thought.close)),
      tagged: true,
    };
  }

  return { thought: "", speech: clean(text), tagged: false };
}
