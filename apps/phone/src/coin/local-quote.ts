/**
 * 本地行情：用当天密钥在手机上把 K 线算出来。
 *
 * 网络只负责两件事：拿当日密钥（/api/seeds）、拿共享账务（/api/state）。
 * 真实价格路径、240 根分钟 K、新闻排点全在本地算——口径见 docs/价格密钥-设计-2026-11-07.md。
 */

import { buildDailyResponse, type CoinDailyResponse } from "@herta/coin";
import {
  COIN_CUTOVER,
  mergeSeeds,
  parseSeeds,
  readSeedCache,
  shanghaiDate,
  writeSeedCache,
  type SeedMap,
} from "./seeds.ts";

type SeedStorage = Pick<Storage, "getItem" | "setItem"> | null;

/** 客户端给算法用的取密钥函数：切换日之前不查表。 */
export function secretLookup(seeds: SeedMap): (date: string) => string | null {
  return (date) => (date >= COIN_CUTOVER ? seeds[date] ?? null : null);
}

/** 今天（上海时间）的密钥拿到没有。 */
export function hasTodaySeed(seeds: SeedMap, nowMs: number): boolean {
  const today = shanghaiDate(nowMs);
  return today < COIN_CUTOVER || Boolean(seeds[today]);
}

/**
 * 算一份行情。没拿到今天的密钥就返回 null——不拿日期派生备用钥匙，
 * 那样会和服务端算出两条线（账务立刻对不上）。
 */
export function buildLocalQuote(nowMs: number, seeds: SeedMap): CoinDailyResponse | null {
  if (!hasTodaySeed(seeds, nowMs)) return null;
  try {
    return buildDailyResponse(nowMs, secretLookup(seeds));
  } catch {
    return null;
  }
}

/**
 * 取一次密钥：成功就并进缓存；失败退回缓存（fromCache=true，签到会拦住）。
 * 页面首次打开、跨天、和「今天还没拿到」时各调一次，不跟 30s 的节拍。
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
