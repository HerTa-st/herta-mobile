/**
 * 把一整段长对话"消化"成记忆。
 *
 * 跟做梦不是一回事，差别在**门槛**：
 *   做梦   —— 你正常聊天，她攒够了就自己判断值不值得记；
 *   消化   —— 你明确说了"这段我要你记住"，所以跳过"值不值得"那道门，
 *             只保留"写成什么"和"格式对不对"。
 *
 * 为什么必须分段：一段 600 多条消息的对话塞不进一次生成，也没法写成一则废案。
 * 所以按用户发言切成若干段，每段独立生成一则。段与段之间不共享上下文，
 * 这正是"回忆"该有的样子——人也不会把三个月的事记得连成一整块。
 */

import type { Block } from "../../protocol/src/index.ts";
import { repairFeian } from "./feian.ts";
import type { DreamDeps, DreamPrompt } from "./dream.ts";
import { extractJson } from "./dream.ts";
import { memoryFileName, memoryTitle, nextMemoryIndex, type MemoryRecord } from "./memory.ts";

export interface DistillConfig {
  /** 想切成几段。段数越多，每则记忆越短、调用次数越多。 */
  chunks: number;
  /** 每段最少几块对话，太短的段直接并进上一段。 */
  minBlocksPerChunk: number;
}

export const DISTILL_DEFAULTS: DistillConfig = { chunks: 8, minBlocksPerChunk: 6 };

export interface DistillOutcome {
  made: MemoryRecord[];
  failed: number;
  voiceUpdated: boolean;
}

/**
 * 按"用户开口"切段：每段以一条用户消息开头。
 * 只在用户边界上切，免得一段以她的半句话结尾。
 */
export function segmentBlocks(blocks: readonly Block[], chunks: number, minBlocks = 6): Block[][] {
  const turns: Block[][] = [];
  let cur: Block[] = [];
  for (const b of blocks) {
    if (b.kind === "user" && cur.length > 0) {
      turns.push(cur);
      cur = [];
    }
    cur.push(b);
  }
  if (cur.length > 0) turns.push(cur);
  if (turns.length === 0) return [];

  const want = Math.max(1, Math.min(chunks, turns.length));
  const per = Math.ceil(turns.length / want);

  const out: Block[][] = [];
  for (let i = 0; i < turns.length; i += per) {
    const group = turns.slice(i, i + per).flat();
    if (out.length > 0 && group.length < minBlocks) {
      out[out.length - 1].push(...group);
    } else {
      out.push(group);
    }
  }
  return out;
}

async function askJson(deps: DreamDeps, prompt: DreamPrompt | string, maxTokens: number): Promise<Record<string, unknown> | null> {
  const { systemPrompt, userPayload } = typeof prompt === "string" ? { systemPrompt: "", userPayload: prompt } : prompt;
  const raw = await deps.chat({ system: systemPrompt, user: userPayload, maxTokens });
  const parsed = extractJson(raw);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

/**
 * 跑一次消化。**串行**——同时写记忆库会撞编号。
 * `onProgress` 每写完一则以 (done, total) 回调，UI 用来显示进度。
 */
export async function distillSession(
  deps: DreamDeps,
  input: { sessionId: string; blocks: readonly Block[]; config?: Partial<DistillConfig> },
  onProgress?: (done: number, total: number, note: string) => void
): Promise<DistillOutcome> {
  const cfg: DistillConfig = { ...DISTILL_DEFAULTS, ...(input.config ?? {}) };
  const groups = segmentBlocks(input.blocks, cfg.chunks, cfg.minBlocksPerChunk);
  const made: MemoryRecord[] = [];
  let failed = 0;

  for (const [i, group] of groups.entries()) {
    const records = await deps.store.list();
    const summaries = records.map((r) => ({ title: memoryTitle(r), tag: r.tag ?? "" }));
    const voiceGuide = (await deps.store.state()).voice?.text ?? "";
    const digest = deps.prompts.buildEpisodeDigest([...group]);

    const draftRaw = (await askJson(
      deps,
      deps.prompts.buildGenerationPrompt(
        digest,
        records.slice(-3).map((r) => r.body),
        summaries,
        voiceGuide,
        deps.scene.env,
        deps.scene.lang
      ),
      3000
    )) as { feian?: string; situationTag?: string } | null;

    let body = String(draftRaw?.feian ?? "").trim();
    if (!body) {
      failed += 1;
      onProgress?.(made.length, groups.length, "第 " + (i + 1) + " 段没写出来");
      continue;
    }

    const index = nextMemoryIndex(records);
    const tag = String(draftRaw?.situationTag ?? "").trim();
    let check = deps.prompts.validateFeian(body);
    if (!check.ok) {
      const fix = repairFeian(body, index, tag || "无题");
      if (fix.changed && deps.prompts.validateFeian(fix.text).ok) body = fix.text;
      else {
        check = deps.prompts.validateFeian(body);
        if (!check.ok) {
          failed += 1;
          onProgress?.(made.length, groups.length, "第 " + (i + 1) + " 段格式没救回来");
          continue;
        }
      }
    }

    const title = memoryTitle({ name: "### 废案_00：新记忆.txt", body, createdAt: "", sessionId: input.sessionId });
    const record: MemoryRecord = {
      name: memoryFileName(index, title),
      body,
      createdAt: new Date(deps.now()).toISOString(),
      sessionId: input.sessionId,
      tag,
    };
    await deps.store.write(record);
    made.push(record);
    onProgress?.(made.length, groups.length, "记住了「" + title + "」");
  }

  /* 末尾重写一次语气笔记：这一整段的样本比平时三篇厚得多。 */
  let voiceUpdated = false;
  if (deps.reviseVoice && made.length > 0) {
    try {
      const records = await deps.store.list();
      const written = await deps.reviseVoice(records, (await deps.store.state()).voice?.text ?? null);
      if (written && written.trim()) {
        const st = await deps.store.state();
        await deps.store.saveState({
          ...st,
          voice: { text: written.trim(), updatedAt: new Date(deps.now()).toISOString(), basis: records.length },
          lastNote: "消化完了：" + made.length + " 则记忆，语气笔记也重写了",
        });
        voiceUpdated = true;
      }
    } catch {
      // 语气没写成不影响记忆已经落库
    }
  }

  return { made, failed, voiceUpdated };
}
