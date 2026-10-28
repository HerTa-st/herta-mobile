/**
 * 钱包与持仓口径。
 *
 * 初次激活送 1000 HTC，成本价 = 首次拿到行情时的开盘价（v1 固定，不随签到变）。
 * 今日盈亏按「较昨收」算：数量 ×（现价 − 昨收），不是较成本。
 */

import type { CoinWallet } from "./types.ts";

/** 首次激活送的 HTC 数量。 */
export const INITIAL_HOLDINGS = 1000;

/** 首次进入黑塔币页时建钱包。`openPrice` 用当前展示场次的开盘价。 */
export function createWallet(openPrice: number, nowISO: string): CoinWallet {
  return {
    version: 1,
    holdings: INITIAL_HOLDINGS,
    costPrice: openPrice,
    initialAt: nowISO,
    lastSign: null,
    history: [],
    updatedAt: nowISO,
  };
}

/** 当前市值 = 持有数量 × 现价。 */
export function marketValue(wallet: CoinWallet, price: number): number {
  return wallet.holdings * price;
}

/** 今日盈亏 = 数量 ×（现价 − 昨收）。 */
export function todayPnl(wallet: CoinWallet, price: number, prevClose: number): number {
  return wallet.holdings * (price - prevClose);
}

/** 今日盈亏率（百分数，口径与接口 changePct 一致）。昨收为 0 时返回 0。 */
export function todayPnlPct(price: number, prevClose: number): number {
  if (!Number.isFinite(prevClose) || prevClose === 0 || !Number.isFinite(price)) return 0;
  return ((price - prevClose) / prevClose) * 100;
}
