/**
 * 这一轮能花多少。
 *
 * 一轮里最贵的三样：判心情（一次带 12 块历史的请求）、复核（一次，被打回还要再重说
 * 一次带全转录的请求）、长上下文（每轮都整段重发）。省 token 模式不是"让她少说两句"，
 * 是把这三样一刀切掉，并把长图与工具轮压到更小的上限。
 *
 * 放在 core 里是为了能测：这里每个数字都对应账单上的一笔。
 */

export interface BudgetInput {
  cheap: boolean;
  moodEnabled: boolean;
  reviewEnabled: boolean;
  contextBlocks: number;
  memorySeeds: number;
}

export interface Budget {
  /** 这一轮判不判心情。 */
  mood: boolean;
  /** 这一轮走不走复核。 */
  review: boolean;
  /** 带多少块历史。 */
  contextBlocks: number;
  /** 挑几篇记忆进系统提示词。 */
  memorySeeds: number;
  /** 工具循环最多几轮——每轮都要把整段转录重发一次。 */
  toolRounds: number;
  /** 一张长图最多切几段寄出去——每段按 1024 token 封顶算。 */
  imagePieces: number;
}

/** 省 token 档的上限。 */
export const CHEAP_LIMITS = {
  contextBlocks: 8,
  memorySeeds: 1,
  toolRounds: 2,
  imagePieces: 4,
} as const;

/** 正常档的上限。 */
export const FULL_LIMITS = {
  toolRounds: 4,
  imagePieces: 12,
} as const;

/**
 * 算出这一轮实际用的预算。
 *
 * 上下文与种子取「用户设的值」和「这一档上限」里的小者：用户自己已经调得更省时，
 * 开关不该反而把他的数值调大。心情与复核是强制关——它们不是"少一点"，是整次请求。
 */
export function budgetFor(input: BudgetInput): Budget {
  const cheap = input.cheap;
  return {
    mood: input.moodEnabled && !cheap,
    review: input.reviewEnabled && !cheap,
    contextBlocks: cheap ? Math.min(input.contextBlocks, CHEAP_LIMITS.contextBlocks) : input.contextBlocks,
    memorySeeds: cheap ? Math.min(input.memorySeeds, CHEAP_LIMITS.memorySeeds) : input.memorySeeds,
    toolRounds: cheap ? CHEAP_LIMITS.toolRounds : FULL_LIMITS.toolRounds,
    imagePieces: cheap ? CHEAP_LIMITS.imagePieces : FULL_LIMITS.imagePieces,
  };
}
