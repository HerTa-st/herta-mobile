/*
 * 黑塔币 · 快讯排点（手机端）
 *
 * 唯一事实来源：fc/coin-api/index.js 的 buildNews / renderNewsText / newsTimeLabel。
 * 服务端曾经把这块算好在 /api/daily 里下发；现在手机端自己算行情，快讯也得自己排，
 * 否则币页的「快讯」会整块消失。文案、交易所名、随机流必须与服务端逐字一致——
 * 对账见 packages/coin/test/core-parity.test.mjs。
 */

import { COIN, buildPlan, makeRng, type GetSecret } from "./core.ts";
import type { CoinDailyResponse, CoinNewsFeed, CoinNewsItem } from "../types.ts";

/** 与网页 app.js 的 EXCHANGES 同列表（只用于把 {ex} 渲染成人话）。 */
const NEWS_EXCHANGES = ["模拟宇宙交易所", "星际所", "深空所", "奇物所", "空间站 OTC"];

/** 新闻文案占位符替换：逐字对齐网页 app.js 的 renderNewsText。 */
export function renderNewsText(tpl: string, rng: { pick: (arr: readonly string[]) => string; int: (a: number, b: number) => number }): string {
  return String(tpl).replace(/\{name\}|\{code\}|\{ex\}|%a%|%b%|%c%|%n%/g, (token) => {
    switch (token) {
      case "{name}":
        return COIN.name;
      case "{code}":
        return COIN.code;
      case "{ex}":
        return rng.pick(NEWS_EXCHANGES);
      case "%a%":
        return String(rng.int(1, 99));
      case "%b%":
        return String(rng.int(1, 98) * 100);
      case "%c%":
        return String(rng.int(5, 300));
      case "%n%":
        return String(rng.int(1, 99));
      default:
        return token;
    }
  });
}

/** 分钟下标 -> HH:MM（与图表时间轴同一口径：t<120 是上午，其余是下午）。 */
export function newsTimeLabel(bar: number): string {
  const i = Math.max(0, Math.min(239, Math.floor(bar)));
  const minutes = i < 120 ? 9 * 60 + 30 + i : 13 * 60 + (i - 120);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return hh + ":" + mm;
}

/**
 * 把当日计划里已经到点的新闻抽出来；未解锁的不下发，只给 total。
 * 交易中：revealed 是已走完的根数，当前分钟的部分 K 也算「已到点」（与网页一致）。
 */
export function buildNews(daily: CoinDailyResponse, getSecret?: GetSecret): CoinNewsFeed {
  const plan = buildPlan(daily.market.sessionDate, getSecret);
  const maxBar = daily.market.status === "trading" ? daily.market.revealed : daily.market.revealed - 1;
  const items: CoinNewsItem[] = plan.events
    .filter((e) => e.bar <= maxBar)
    .sort((a, b) => b.bar - a.bar)
    .map((e) => {
      const rng = makeRng(plan.key + "|news|" + e.bar);
      return {
        bar: e.bar,
        time: newsTimeLabel(e.bar),
        dir: e.dir > 0 ? "up" : e.dir < 0 ? "down" : "flat",
        tag: e.dir > 0 ? "利好" : e.dir < 0 ? "利空" : "中性",
        strength: e.strength,
        text: renderNewsText(e.tpl, rng),
      };
    });
  return { total: plan.events.length, items };
}
