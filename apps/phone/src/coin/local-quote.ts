/**
 * 本地行情：用当天密钥在手机上把 K 线算出来。
 *
 * 网络只负责两件事：拿当日密钥（/api/seeds）、拿共享账务（/api/state）。
 * 真实价格路径、240 根分钟 K、新闻排点全在本地算——口径见 docs/价格密钥-设计-2026-11-07.md。
 *
 * 注意「要哪一天的密钥」：不是日历上的今天，而是**这一场行情的场次日期**
 * （周末 / 盘前看的是上一个交易日）。周一到周五 09:30 前要的是上周五的密钥，
 * 周六周日也还是上周五——按今天去要，周末会误判成「没密钥、开不了盘」。
 */

import { buildDailyResponse, buildNews, getSession, type CoinDailyResponse } from "@herta/coin";
import {
  COIN_CUTOVER,
  mergeSeeds,
  parseSeeds,
  readSeedCache,
  writeSeedCache,
  type SeedMap,
} from "./seeds.ts";

type SeedStorage = Pick<Storage, "getItem" | "setItem"> | null;

/** 客户端给算法用的取密钥函数：切换日之前不查表。 */
export function secretLookup(seeds: SeedMap): (date: string) => string | null {
  return (date) => (date >= COIN_CUTOVER ? seeds[date] ?? null : null);
}

/** 这一刻画的是哪一场（周末/盘前回落到上一个交易日）。 */
export function sessionDateFor(nowMs: number): string {
  return getSession(nowMs).sessionDate;
}

/** 这一场要的密钥拿到没有；切换日之前的场次不需要密钥。 */
export function hasSessionSeed(nowMs: number, seeds: SeedMap): boolean {
  const date = sessionDateFor(nowMs);
  return date < COIN_CUTOVER || Boolean(seeds[date]);
}

/**
 * 算一份行情。这一场的密钥没有就返回 null——不拿日期派生备用钥匙，
 * 那样会和服务端算出两条线（账务立刻对不上）。
 */
export function buildLocalQuote(nowMs: number, seeds: SeedMap): CoinDailyResponse | null {
  if (!hasSessionSeed(nowMs, seeds)) return null;
  const lookup = secretLookup(seeds);
  try {
    const quote = buildDailyResponse(nowMs, lookup);
    // 快讯也得自己排：以前是 /api/daily 里带下来的，现在行情在本地算，这块跟着一起搬。
    return { ...quote, news: buildNews(quote, lookup) };
  } catch {
    return null;
  }
}

/**
 * 取一次密钥：成功就并进缓存；失败退回缓存（fromCache=true，签到会拦住）。
 * 页面首次打开、跨天、和「这一场还没拿到」时各调一次，不跟 30s 的节拍。
 */
export async function syncSeeds(
  base: string,
  getText: (url: string) => Promise<string>,
  storage: SeedStorage
): Promise<{ seeds: SeedMap; fromCache: boolean }> {
  const cached = readSeedCache(storage);
  const root = base.trim().replace(/\/+$/, "");
  if (!root) return { seeds: cached, fromCache: true };
  try {
    const text = await getText(root + "/api/seeds?from=" + COIN_CUTOVER);
    const fresh = parseSeeds(text).seeds;
    const merged = mergeSeeds(cached, fresh);
    writeSeedCache(storage, merged);
    return { seeds: merged, fromCache: false };
  } catch {
    return { seeds: cached, fromCache: true };
  }
}
