/**
 * B8 共享市场的纯规则：限价单（条件单）、空头、借币利息、欠款。
 *
 * 这些函数不碰网络/存储，服务端 market-v2.js 镜像同一套口径，测试向量保证两边
 * 的触发、过期、利息与护栏一致。没有订单簿：限价单只是“价格到了就按市价成交”的条件单。
 */

import type {
  CoinLimitOrder,
  CoinOrderSide,
  CoinOrderTtl,
  CoinShortPosition,
} from "./types.ts";

export const DAY_MS = 86_400_000;
/** 借币日息 0.1%，按开仓时锁定的价值算。 */
export const INTEREST_RATE_PER_DAY = 0.001;
/** 空头开仓上限：净资产 × 3。 */
export const SHORT_MAX_LEVERAGE = 3;

export const ORDER_TTL_MS: Record<CoinOrderTtl, number> = {
  "1h": 3_600_000,
  "24h": DAY_MS,
  "3d": 3 * DAY_MS,
};

export const ORDER_TTL_LABELS: Record<CoinOrderTtl, string> = {
  "1h": "1 小时",
  "24h": "24 小时",
  "3d": "3 天",
};

export function isOrderTtl(value: unknown): value is CoinOrderTtl {
  return value === "1h" || value === "24h" || value === "3d";
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 挂单绝对过期时间。 */
export function orderExpiresAt(ttl: CoinOrderTtl, nowMs: number): number {
  return nowMs + ORDER_TTL_MS[ttl];
}

/** 是否已过期（到点即作废，不成交）。 */
export function isOrderExpired(order: Pick<CoinLimitOrder, "expiresAt">, nowMs: number): boolean {
  return nowMs >= order.expiresAt;
}

/**
 * 条件单是否触发：买入挂单在市价 <= 限价时触发，卖出挂单在市价 >= 限价时触发。
 * 触发后由系统按市价成交，不按限价成交。
 */
export function orderTriggered(
  side: CoinOrderSide,
  limitPrice: number,
  marketPrice: number
): boolean {
  if (!Number.isFinite(limitPrice) || !Number.isFinite(marketPrice)) return false;
  return side === "buy" ? marketPrice <= limitPrice : marketPrice >= limitPrice;
}

/** 账户快照：现金 + 多头持仓 + 空头仓位。 */
export interface CoinAccountSnapshot {
  htc: number;
  usdt: number;
  short?: CoinShortPosition | null;
}

/** 借入 HTC 按当前市价折算的负债。 */
export function shortLiability(short: CoinShortPosition | null | undefined, price: number): number {
  if (!short || !Number.isFinite(short.amount) || !Number.isFinite(price)) return 0;
  return short.amount * price;
}

/**
 * 净资产 = 现金 + 持仓市值 − 借入负债（设计文档 §7 的会计口径）。
 * 不算借入负债等于做空不欠账，负数也就没有意义。
 */
export function netWorthOf(account: CoinAccountSnapshot, price: number): number {
  const holdings = Number(account.htc) || 0;
  const cash = Number(account.usdt) || 0;
  return cash + holdings * price - shortLiability(account.short, price);
}

/**
 * 欠款：空头负债 + 负现金。欠款榜按它从大到小排。
 * 注意这不是净资产；净资产还扣了多头持仓。
 */
export function debtOf(account: CoinAccountSnapshot, price: number): number {
  const cash = Number(account.usdt) || 0;
  return shortLiability(account.short, price) + (cash < 0 ? -cash : 0);
}

/** 开仓上限（名义价值）：净资产 × 3；净资产不为正时是 0。 */
export function shortMaxNotional(netWorth: number): number {
  return netWorth > 0 ? netWorth * SHORT_MAX_LEVERAGE : 0;
}

/** 护栏：净资产为负不能开新仓；已有空头时按总额合并计算。 */
export function canOpenShort(
  account: CoinAccountSnapshot,
  price: number,
  addAmount: number
): { ok: boolean; reason?: "negative_equity" | "leverage_cap"; netWorth: number; maxNotional: number } {
  const netWorth = netWorthOf(account, price);
  const maxNotional = shortMaxNotional(netWorth);
  if (netWorth <= 0) {
    return { ok: false, reason: "negative_equity", netWorth, maxNotional };
  }
  const existing = account.short ? account.short.notional : 0;
  if (existing + addAmount * price > maxNotional + 1e-9) {
    return { ok: false, reason: "leverage_cap", netWorth, maxNotional };
  }
  return { ok: true, netWorth, maxNotional };
}

/** 从上次计息到 now 过了几个整天（不满一天不计息，零头保留）。 */
export function shortInterestDays(short: CoinShortPosition, nowMs: number): number {
  const last = Number.isFinite(short.lastInterestAt)
    ? short.lastInterestAt
    : Number.isFinite(short.borrowedAt)
      ? short.borrowedAt
      : nowMs;
  if (!Number.isFinite(nowMs) || nowMs <= last) return 0;
  return Math.floor((nowMs - last) / DAY_MS);
}

/** 本次应补的利息（信用点，可能把余额扣成负数）。 */
export function shortInterestDue(
  short: CoinShortPosition,
  nowMs: number
): { days: number; interest: number } {
  const days = shortInterestDays(short, nowMs);
  const interest = round2(days * (Number(short.notional) || 0) * INTEREST_RATE_PER_DAY);
  return { days, interest };
}

/**
 * 惰性计息：把 lastInterestAt 推进整数天，零头留在下一次。
 * 返回新对象，不改入参。
 */
export function accrueShortInterest(
  short: CoinShortPosition,
  nowMs: number
): { short: CoinShortPosition; days: number; interest: number } {
  const { days, interest } = shortInterestDue(short, nowMs);
  if (days <= 0) return { short, days: 0, interest: 0 };
  return {
    short: {
      ...short,
      lastInterestAt: short.lastInterestAt + days * DAY_MS,
    },
    days,
    interest,
  };
}

/** 空头浮动盈亏（未扣利息）：(开仓价 − 现价) × 数量。 */
export function shortPnl(short: CoinShortPosition | null | undefined, price: number): number {
  if (!short) return 0;
  return (short.entryPrice - price) * short.amount;
}

/** 空头杠杆倍数（按当前名义价值 / 净资产）；净资产不为正时返回 0。 */
export function shortLeverage(
  short: CoinShortPosition | null | undefined,
  netWorth: number,
  price: number
): number {
  if (!short || netWorth <= 0) return 0;
  return (short.amount * price) / netWorth;
}
