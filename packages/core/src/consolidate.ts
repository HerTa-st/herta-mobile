/**
 * 记忆整理与遗忘。
 *
 * 整理（20 条触发）做三件事，全部由**一次**模型调用给出计划：
 *   1. 建立关联——只连真正相关的（同一个人、同一件事、同一种情境）；
 *   2. 简化——权重低的记忆压成一句要点（正文保留，进提示词时用要点）；
 *   3. 加深——权重高的记下"这条还能怎么长"，同时把权重抬一点。
 *
 * 遗忘（50 条触发）不需要模型：按有效权重从低到高划掉 10 条，标记 forgotten，
 * 不进提示词、列表默认不显示，但没删——万一哪天你想起它，还能翻出来。
 */

import type { MemoryStore, MemoryRecord } from "./memory.ts";
import { memoryTitle } from "./memory.ts";
import { WEIGHT_CAP, effectiveWeight, isProtected, pickForgettable } from "./weights.ts";

export interface ConsolidatePlan {
  links: [string, string][];
  simplify: { name: string; gist: string }[];
  deepen: { name: string; note: string }[];
}

export interface ConsolidatePrompt {
  system: string;
  user: string;
}

const PREVIEW_CHARS = 220;
const GIST_MAX = 140;
const MAX_LINKS_PER_NODE = 4;

export function buildConsolidatePrompt(records: readonly MemoryRecord[], nowMs: number): ConsolidatePrompt {
  const list = records
    .map((r, i) => {
      const w = effectiveWeight(r, nowMs).toFixed(2);
      const preview = r.body.replace(/\s+/g, " ").slice(0, PREVIEW_CHARS);
      return `${i + 1}. 【${r.name}】 权重 ${w}\n   标题：${memoryTitle(r)}\n   内容：${preview}`;
    })
    .join("\n\n");

  const system = [
    "你在整理自己的记忆。给你的每一条都有编号、文件名、权重和内容片段。",
    "",
    "要做三件事：",
    "1. **建立关联**：找出彼此真正相关的记忆（同一个人、同一件事、同一种情境、同一种语气）。不相关的不要硬连。",
    "2. **简化**：权重低的（<0.5）压成一句要点，不超过 " + GIST_MAX + " 字。要点要能替代原文用于回忆，不要写成评价。",
    "3. **加深**：权重高的（>=0.7）写一句「这条还能怎么长」——具体该补什么细节，不要泛泛而谈。",
    "",
    "规则：",
    "- 只处理确实需要的条目，不必每条都给动作。",
    "- 名字必须一字不差地从上面抄，不要改写。",
    "- 输出 JSON，别的什么都不要。",
    "",
    "```json",
    '{"links": [["文件名A", "文件名B"]], "simplify": [{"name": "文件名", "gist": "一句要点"}], "deepen": [{"name": "文件名", "note": "还能怎么长"}]}',
    "```",
  ].join("\n");

  return { system, user: "这些是我的记忆：\n\n" + list };
}

function asRecords(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter((x) => typeof x === "object" && x !== null) as Record<string, unknown>[]) : [];
}

/** 解析计划并按白名单过滤：模型编出来的文件名一律丢掉。 */
export function parseConsolidatePlan(raw: unknown, knownNames: ReadonlySet<string>): ConsolidatePlan {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const plan: ConsolidatePlan = { links: [], simplify: [], deepen: [] };

  const rawLinks: unknown[] = Array.isArray(obj.links) ? obj.links : [];
  for (const pair of rawLinks) {
    if (!Array.isArray(pair)) continue;
    const a = String(pair[0] ?? "");
    const b = String(pair[1] ?? "");
    if (knownNames.has(a) && knownNames.has(b) && a !== b) plan.links.push([a, b]);
  }
  for (const item of asRecords(obj.simplify)) {
    const name = String(item.name ?? "");
    const gist = String(item.gist ?? "").trim();
    if (knownNames.has(name) && gist) plan.simplify.push({ name, gist: gist.slice(0, GIST_MAX) });
  }
  for (const item of asRecords(obj.deepen)) {
    const name = String(item.name ?? "");
    const note = String(item.note ?? "").trim();
    if (knownNames.has(name) && note) plan.deepen.push({ name, note: note.slice(0, 120) });
  }
  return plan;
}

/** 把计划落到记录上。返回改了几条。 */
export function applyConsolidatePlan(
  records: readonly MemoryRecord[],
  plan: ConsolidatePlan,
  nowMs: number
): { next: MemoryRecord[]; touched: number } {
  const byName = new Map(records.map((r) => [r.name, { ...r }]));
  const touched = new Set<string>();

  const linkCount = new Map<string, number>();
  for (const [a, b] of plan.links) {
    const add = (from: string, to: string) => {
      const rec = byName.get(from);
      if (!rec) return;
      const used = linkCount.get(from) ?? 0;
      if (used >= MAX_LINKS_PER_NODE) return;
      const links = new Set(rec.links ?? []);
      if (links.has(to)) return;
      links.add(to);
      rec.links = [...links];
      linkCount.set(from, used + 1);
      touched.add(from);
    };
    add(a, b);
    add(b, a);
  }

  for (const { name, gist } of plan.simplify) {
    const rec = byName.get(name);
    if (!rec) continue;
    rec.gist = gist;
    touched.add(name);
  }

  for (const { name, note } of plan.deepen) {
    const rec = byName.get(name);
    if (!rec) continue;
    rec.deepenNote = note;
    rec.weight = Math.min(WEIGHT_CAP, (rec.weight ?? 0.5) + 0.1);
    touched.add(name);
  }

  void nowMs;
  return { next: [...byName.values()], touched: touched.size };
}

export interface ConsolidateOutcome {
  plan: ConsolidatePlan;
  touched: number;
}

/** 跑一次整理。模型调用由调用方注入（`chat`），core 不碰网络。 */
export async function consolidateMemories(
  deps: {
    store: MemoryStore;
    chat(input: { system: string; user: string; maxTokens: number }): Promise<string>;
    now(): number;
  },
  extractJson: (raw: string) => unknown
): Promise<ConsolidateOutcome> {
  const now = deps.now();
  const records = (await deps.store.list()).filter((r) => !r.forgotten);
  const prompt = buildConsolidatePrompt(records, now);
  const raw = await deps.chat({ system: prompt.system, user: prompt.user, maxTokens: 2000 });
  const plan = parseConsolidatePlan(extractJson(raw), new Set(records.map((r) => r.name)));
  const { next, touched } = applyConsolidatePlan(records, plan, now);
  for (const rec of next) {
    const before = records.find((r) => r.name === rec.name);
    if (!before) continue;
    if (JSON.stringify(before) !== JSON.stringify(rec)) await deps.store.write(rec);
  }
  return { plan, touched };
}

/** 遗忘：按有效权重划掉最低的 `count` 条（受保护的不动）。返回被忘掉的。 */
export async function forgetMemories(
  store: MemoryStore,
  nowMs: number,
  count?: number
): Promise<MemoryRecord[]> {
  const records = await store.list();
  const victims = pickForgettable(records, nowMs, count);
  for (const v of victims) {
    await store.write({ ...v, forgotten: true });
  }
  return victims;
}

/** 给 UI 用：还剩哪些会被遗忘（不实际修改）。 */
export function forgettingPreview(records: readonly MemoryRecord[], nowMs: number, count?: number): MemoryRecord[] {
  return records.filter((r) => !r.forgotten && !isProtected(r, nowMs)).length > 0
    ? pickForgettable(records, nowMs, count)
    : [];
}
