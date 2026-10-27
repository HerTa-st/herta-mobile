/**
 * 用量（token）。
 *
 * 一轮对话不止一次请求：判心情一次、主对话一到四轮、复核一次、被打回还要重说一次。
 * 每一次的 `usage` 都要加进来，否则徽章上的数字会比账单小一大截。
 *
 * 这里只做两件事：加起来（cached / calls 不能丢），和缩写成一行——
 * 气泡下面放不下 "4103827"，能放下 "4.1M"。
 */

import type { TokenUsage } from "../../protocol/src/index.ts";

export function emptyUsage(): TokenUsage {
  return { prompt: 0, completion: 0, cached: 0, calls: 0 };
}

/** 加一笔。传 null / undefined 就当没发生（那家接口没给 usage）。 */
export function addUsage(a: TokenUsage, b: TokenUsage | null | undefined): TokenUsage {
  if (!b) return a;
  return {
    prompt: a.prompt + b.prompt,
    completion: a.completion + b.completion,
    cached: (a.cached ?? 0) + (b.cached ?? 0),
    calls: (a.calls ?? 0) + (b.calls ?? 0),
  };
}

/** 这一轮一共烧了多少 token（输入 + 输出）。 */
export function usageTotal(u: TokenUsage): number {
  return u.prompt + u.completion;
}

/**
 * 4.1M / 1.2k / 856。
 *
 * 1000 以下原样；一万以上只留整数换行——徽章不是精确到个位的账本，
 * 但也不能出现 "1000k" 这种（999.6k 要进位成 1M）。
 */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  if (v < 1000) return String(v);
  if (v < 999_500) {
    const k = v / 1000;
    return (k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "")) + "k";
  }
  const m = v / 1_000_000;
  return (m >= 100 ? String(Math.round(m)) : m.toFixed(1).replace(/\.0$/, "")) + "M";
}
