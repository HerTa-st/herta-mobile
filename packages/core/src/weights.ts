/**
 * 记忆的权重与代谢。
 *
 * 一条记忆不是"有"或"没有"两种状态：它会被想起来（变重）、被冷落（变轻），
 * 攒多了要整理，攒太多了要忘掉一些。这不是附加功能——记忆库要是只进不出，
 * 早晚会变成一堆她自己都不认得的噪声。
 *
 * 规则（数字都可调，但先讲清为什么是这些）：
 *   - 基础权重：种子 0.55（别人写的样例，重要性不如她自己经历的），自造 0.5
 *   - 每被召回一次 +0.06，最多到 1
 *   - 不动的衰减：半衰期 90 天（三个月没人提起，重要性掉一半）
 *   - 20 条触发一次整理：低权重的简化，高权重的加深，顺带建立关联
 *   - 50 条触发遗忘：按有效权重从低到高忘掉 10 条
 *   - 保护：编号 ≤ 2 的种子（语气锚点）与权重 ≥ 0.85 的记忆不参与遗忘
 */

import { memoryIndex, type MemoryRecord } from "./memory.ts";

export const WEIGHT_BASE_SEED = 0.55;
export const WEIGHT_BASE_NEW = 0.5;
export const WEIGHT_RECALL_BONUS = 0.06;
export const WEIGHT_CAP = 1;
export const HALF_LIFE_DAYS = 90;

export const CONSOLIDATE_AT = 20;
export const FORGET_AT = 50;
export const FORGET_COUNT = 10;
export const PROTECTED_MAX_INDEX = 2;
export const PROTECTED_MIN_WEIGHT = 0.85;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 有效权重：基础权重 × 时间衰减，钳到 [0,1]。 */
export function effectiveWeight(record: MemoryRecord, nowMs: number): number {
  const base = typeof record.weight === "number" ? record.weight : record.sessionId ? WEIGHT_BASE_NEW : WEIGHT_BASE_SEED;
  const last = record.lastRecallAt ? Date.parse(record.lastRecallAt) : Date.parse(record.createdAt);
  const days = Number.isFinite(last) ? Math.max(0, (nowMs - last) / DAY_MS) : 0;
  const decayed = base * Math.pow(2, -days / HALF_LIFE_DAYS);
  return Math.max(0, Math.min(WEIGHT_CAP, decayed));
}

/** 被想起一次：权重加一点，时间戳刷新。 */
export function reinforce(record: MemoryRecord, nowMs: number): MemoryRecord {
  const base = typeof record.weight === "number" ? record.weight : record.sessionId ? WEIGHT_BASE_NEW : WEIGHT_BASE_SEED;
  return {
    ...record,
    weight: Math.min(WEIGHT_CAP, base + WEIGHT_RECALL_BONUS),
    recalls: (record.recalls ?? 0) + 1,
    lastRecallAt: new Date(nowMs).toISOString(),
  };
}

export function activeRecords(records: readonly MemoryRecord[]): MemoryRecord[] {
  return records.filter((r) => !r.forgotten);
}

/** 该不该整理：到 20 条，且距离上次整理又多了 20 条。 */
export function shouldConsolidate(activeCount: number, lastConsolidatedCount: number | null): boolean {
  if (activeCount < CONSOLIDATE_AT) return false;
  if (lastConsolidatedCount === null) return true;
  return activeCount - lastConsolidatedCount >= CONSOLIDATE_AT;
}

/** 该不该遗忘：到 50 条就该处理一次（每次忘 FORGET_COUNT 条）。 */
export function shouldForget(activeCount: number): boolean {
  return activeCount >= FORGET_AT;
}

/** 不参与遗忘：语气锚点种子，或者已经很重的记忆。 */
export function isProtected(record: MemoryRecord, nowMs: number): boolean {
  const idx = memoryIndex(record.name);
  if (idx !== null && idx <= PROTECTED_MAX_INDEX) return true;
  return effectiveWeight(record, nowMs) >= PROTECTED_MIN_WEIGHT;
}

/**
 * 挑出要被遗忘的：有效权重最低的那些（已忘的不算，受保护的不算）。
 * 不足 `count` 条时就返回现有的全部——宁可忘得少，不要顺手把不该忘的也划掉。
 */
export function pickForgettable(
  records: readonly MemoryRecord[],
  nowMs: number,
  count = FORGET_COUNT
): MemoryRecord[] {
  const pool = activeRecords(records).filter((r) => !isProtected(r, nowMs));
  return [...pool]
    .sort((a, b) => effectiveWeight(a, nowMs) - effectiveWeight(b, nowMs))
    .slice(0, Math.max(0, count));
}
