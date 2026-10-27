/**
 * 标签语法：她的"想"与"说"两轨，以及记录的反向序列化。
 *
 * 标签是人格的一部分，不是实现细节——桌面版、旧手机版、这个版本必须完全一致，
 * 否则模型学到的输出契约会变，她的语气会跟着飘。
 * 所以这个文件里的每一个字面量都不是随便写的。
 */

import type { Block, SystemLabel } from "../../protocol/src/index.ts";
import { parseNarrative } from "./narrative.ts";

export type Surface = "thought" | "speech";

/** 「想」还是「说」——标签里只有这一个字不同。 */
const TAG_OF: Record<Surface, string> = { thought: "想", speech: "说" };

/** 全角括号 + 中间一个空格，成对出现。 */
function pairFor(surface: Surface): { open: string; close: string } {
  const t = TAG_OF[surface];
  return { open: "（我 " + t + "）", close: "（/我 " + t + "）" };
}

/** 只认标签里的内容；没有标签返回 null（不瞎猜）。 */
export function extractTagged(raw: string | null | undefined, surface: Surface): string | null {
  if (!raw) return null;
  const t = TAG_OF[surface];
  const m = String(raw).match(new RegExp("（我\\s*" + t + "）([\\s\\S]*?)（/我\\s*" + t + "）"));
  return m ? m[1].trim() : null;
}

/**
 * 取某一轨的内容。真正的切分逻辑在 narrative.ts —— 这里只是按 surface 选一路，
 * 免得两处各写一套正则、然后一起错。
 */
export function parseTagged(raw: string | null | undefined, surface: Surface): string {
  const n = parseNarrative(raw);
  return surface === "thought" ? n.thought : n.speech;
}

/**
 * 空回复、"（这里该说点什么）"这类占位，都要触发重试而不是发出去。
 *
 * 阈值是 2 而不是旧版的 3：手机上她本来就该说短句，「嗯。」「行吧」是正常的回话，
 * 按 3 字判会把它们当成占位反复重试，白烧 token 还把她的话拖长。
 */
export function isPlaceholder(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (t.length <= 2) return true;
  if (/^[（(［\[【].{0,60}[）)］\]】]$/.test(t)) return true;
  if (/这里该|这儿该|该说点|该想点|占位|placeholder/i.test(t) && t.length < 40) return true;
  return false;
}

export interface SerializeOptions {
  maxBlocks?: number;
}

/**
 * 把记录翻回她认识的那套标签格式。
 * 注意 herta 块的 surface 决定用「想」还是「说」——想与说混进同一轨会污染下一轮。
 */
export function serializeRecord(record: readonly Block[], { maxBlocks = 24 }: SerializeOptions = {}): string {
  const blocks = maxBlocks > 0 ? record.slice(-maxBlocks) : record;
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "user") {
      // 附件不是正文，但转录里得留一句：图会随请求作为图片片段发出去，模型不收图时
      // 就只剩这一行。少了它，「只发图」那句在转录里是一片空白，她会当成你没说话。
      const pics = b.attachments ?? [];
      const pic = pics.length
        ? "（附了一张图" +
          (pics[0]?.name ? "：" + pics[0].name : "") +
          (pics.length > 1 ? "，切成 " + pics.length + " 段，按顺序接起来是一整张" : "") +
          "）"
        : "";
      const body = (b.text ?? "") + (pic ? (b.text ? "\n" : "") + pic : "");
      out.push("（开拓者 说）\n" + body + "\n（/开拓者 说）");
    } else if (b.kind === "sticker") {
      // 表情没有台词，只有一行旁白。
      // 你发的记成"你在说话"（那确实是你这一轮唯一的一句话）；
      // 她发的记成系统旁白——写成她的话，她会以为"（发来一张表情）"是能照抄的句式，
      // 于是下一轮不调工具，直接在嘴里写一句括号。
      if (b.from === "user") {
        out.push("（开拓者 说）\n（发来一张表情：" + b.name + "）\n（/开拓者 说）");
      } else {
        out.push("〔系统〕（她发来一张表情：" + b.name + "）");
      }
    } else if (b.kind === "herta") {
      const tag = b.surface === "thought" ? "想" : "说";
      out.push("（我 " + tag + "）\n" + (b.text ?? "") + "\n（/我 " + tag + "）");
    } else {
      // 旧版写成 `〔系统〕系统：正文`，标签重复了一遍，而且「差分协处理器」会被
      // 一律印成「系统」。这里直接用块自己的 label。
      const label: SystemLabel = b.label ?? "系统";
      out.push("〔" + label + "〕" + (b.body ?? ""));
    }
  }
  return out.join("\n\n");
}

export interface Verdict {
  ok: boolean;
  category: string | null;
  reason: string | null;
  raw: string;
}

/**
 * 复核结论：四行检查 + 一行 OK，或者 `BLOCK：类别：第一人称理由`。
 * 没写 BLOCK 就当过——模型跑偏时不能因此把她要说的话全吞掉。
 */
export function parseSupervisorVerdict(text: string | null | undefined): Verdict {
  const raw = String(text ?? "");
  const blocks = [...raw.matchAll(/BLOCK[:：]\s*([^：:\n]{0,14})[：:]\s*([^\n]+)/g)];
  if (blocks.length === 0) {
    return { ok: true, category: null, reason: null, raw: raw.trim().slice(0, 200) };
  }
  const first = blocks[0];
  return {
    ok: false,
    category: (first[1] ?? "").trim() || "声音",
    reason: (first[2] ?? "").trim(),
    raw: raw.trim().slice(0, 200),
  };
}
