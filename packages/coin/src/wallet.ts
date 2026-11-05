/**
 * 钱包与持仓口径 + 统一记账入口。
 *
 * 初次激活送 1000 HTC，成本价 = 首次拿到行情时的开盘价（v1 固定，不随签到变）。
 * 今日盈亏按「较昨收」算：数量 ×（现价 − 昨收），不是较成本。
 *
 * B7：所有收入/支出都走 `applyLedger(账户, 变动, 来源)`——签到奖励、以后的交易/合并
 * 都从这里过，来源打标并留最近 200 条审计。单机钱包没有信用点现金，只记 HTC 变动。
 */

import { emptyAchievementStats } from "./achievements.ts";
import type {
  CoinAchievementStats,
  CoinLedgerEntry,
  CoinLedgerSource,
  CoinWallet,
} from "./types.ts";

/** 首次激活送的 HTC 数量。 */
export const INITIAL_HOLDINGS = 1000;

/** 钱包里最多留多少条收支审计。 */
export const LEDGER_MAX = 200;

/** 一次记账的净变动；单机只认 htc。 */
export interface LedgerChange {
  htc?: number;
  usdt?: number;
}

export interface ApplyLedgerOptions {
  nowISO?: string;
  /** 签到类：本次之后的连签天数，用于 maxStreak。 */
  streak?: number;
  /** 交易类：成交 HTC 数量与手续费（信用点），用于成就计数器。 */
  amount?: number;
  fee?: number;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function finiteOrZero(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * 统一记账入口：改余额、记一条 ledger、维护成就计数器。
 *
 * 纯函数：返回新钱包，不写库。`source` 由调用方打标（signin / trade:buy / trade:sell / claim…）。
 */
export function applyLedger(
  wallet: CoinWallet,
  change: LedgerChange,
  source: CoinLedgerSource,
  opts: ApplyLedgerOptions = {}
): CoinWallet {
  const htc = finiteOrZero(change.htc);
  const usdt = finiteOrZero(change.usdt);
  const nowISO = opts.nowISO ?? new Date().toISOString();
  const stats: CoinAchievementStats = { ...emptyAchievementStats(), ...(wallet.stats ?? {}) };

  if (source === "signin") {
    stats.signins += 1;
    stats.totalReward = round2(stats.totalReward + htc);
    stats.maxStreak = Math.max(stats.maxStreak, Math.max(0, Math.floor(opts.streak ?? 0)));
  } else if (source === "trade:buy" || source === "trade:sell") {
    stats.trades += 1;
    if (source === "trade:buy") stats.buys += 1;
    else stats.sells += 1;
    stats.volume = round2(stats.volume + finiteOrZero(opts.amount));
    stats.fees = round2(stats.fees + finiteOrZero(opts.fee));
  }

  const entry: CoinLedgerEntry = {
    at: nowISO,
    source,
    htc: round2(htc),
    usdt: round2(usdt),
  };
  const ledger = [...(wallet.ledger ?? []), entry].slice(-LEDGER_MAX);

  return {
    ...wallet,
    version: 1,
    holdings: round2(wallet.holdings + htc),
    stats,
    ledger,
    updatedAt: nowISO,
  };
}

/** 首次进入黑塔币页时建钱包。`openPrice` 用当前展示场次的开盘价。 */
export function createWallet(openPrice: number, nowISO: string): CoinWallet {
  return {
    version: 1,
    holdings: INITIAL_HOLDINGS,
    costPrice: openPrice,
    initialAt: nowISO,
    lastSign: null,
    history: [],
    achievements: [],
    stats: emptyAchievementStats(),
    ledger: [],
    bankruptCount: 0,
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
