/**
 * 共享市场（v2）接口：URL、类型、解析。
 *
 * 与 FC `market-v2.js` 的返回结构一一对应；解析是**中等严格**：
 * 缺关键字段就抛中文 Error，页面显示「共享市场连接失败」而不是拿 undefined 去算账。
 */

import type { CoinAchievementStats, CoinStatus } from "./types.ts";

/** `/api/state` 里的 market 块。 */
export interface CoinMarketApiMarket {
  sessionDate: string;
  sessionNumber: number;
  status: CoinStatus;
  statusLabel: string;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  basePrice: number;
  price: number;
  changePct: number;
  impactPct: number;
  netBuy: number;
  volume: number;
}

/** 服务端签到状态（B7 追加连签加成字段；老服务端缺省按 0 兜底）。 */
export interface CoinMarketSignin {
  streak: number;
  lastSignDay: string;
  signedToday: boolean;
  canSign: boolean;
  nextStreak: number;
  /** 下一次签到实际奖励（已含连签加成）。 */
  nextReward: number;
  /** 下一次签到基础奖励（不含连签加成）。 */
  nextRewardBase: number;
  /** 下一次签到的连签加成百分比：0 或 5。 */
  bonusPct: number;
  /** 还差几天到「连签 7 天 +5%」；已经到 7 天就是 0。 */
  daysToBonus: number;
  /** 上次签到与本次之间断档了（连签已归零）。 */
  broken: boolean;
}

/** `/api/state` 里的 user 块。 */
export interface CoinMarketUser {
  name: string;
  htc: number;
  usdt: number;
  cost: number;
  todayBuy: number;
  todaySell: number;
  lastTradeAt: number;
  merged: boolean;
  streak: number;
  lastSignDay: string;
  value: number;
  /** B7：已解锁成就 id。 */
  achievements: string[];
  /** B7：成就计数器。 */
  achievementStats: CoinAchievementStats;
  /** B7 占位：B8 的破产次数。 */
  bankruptCount: number;
  signin: CoinMarketSignin;
}

export interface CoinMarketLimits {
  feeRate: number;
  maxOrder: number;
  buyPerDay: number;
  sellPerDay: number;
  cooldownMs: number;
  mergeCapHtc: number;
}

export interface CoinLeaderRow {
  rank: number;
  name: string;
  value: number;
}

export interface CoinMarketState {
  version: number;
  serverTime: string;
  market: CoinMarketApiMarket;
  user: CoinMarketUser;
  limits: CoinMarketLimits;
  leaderboard: CoinLeaderRow[];
}

type Json = Record<string, unknown>;

function stripBase(base: string): string {
  return base.replace(/\/+$/, "");
}

export function coinStateUrl(base: string, user: string): string {
  return stripBase(base) + "/api/state?user=" + encodeURIComponent(user);
}

export function coinTradeUrl(base: string): string {
  return stripBase(base) + "/api/trade";
}

export function coinSigninUrl(base: string): string {
  return stripBase(base) + "/api/signin";
}

export function coinClaimUrl(base: string): string {
  return stripBase(base) + "/api/claim";
}

/* ------------------------------------------------------------------ 解析 */

function bad(detail: string): never {
  throw new Error("共享市场数据格式不对：" + detail);
}

function asObject(value: unknown, where: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad(where + " 应该是对象");
  return value as Json;
}

function readNumber(obj: Json, key: string, where: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) bad(where + "." + key + " 缺失或不是数字");
  return v;
}

function readString(obj: Json, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string") bad(where + "." + key + " 缺失或不是字符串");
  return v;
}

function readBool(obj: Json, key: string, where: string): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") bad(where + "." + key + " 缺失或不是布尔值");
  return v;
}

/** B7 新字段：老服务端没有时按默认值走，不让整页失败。 */
function readNumberOr(obj: Json, key: string, where: string, fallback: number): number {
  const v = obj[key];
  if (v === undefined || v === null) return fallback;
  return readNumber(obj, key, where);
}

function readBoolOr(obj: Json, key: string, where: string, fallback: boolean): boolean {
  const v = obj[key];
  if (v === undefined || v === null) return fallback;
  return readBool(obj, key, where);
}

function readStringArray(obj: Json, key: string, where: string): string[] {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) bad(where + "." + key + " 不是数组");
  return v.map((item, i) => {
    if (typeof item !== "string") bad(where + "." + key + "[" + i + "] 不是字符串");
    return item;
  });
}

function parseAchievementStats(value: unknown): CoinAchievementStats {
  const where = "user.achievementStats";
  if (value === undefined || value === null) {
    return { signins: 0, maxStreak: 0, totalReward: 0, trades: 0, buys: 0, sells: 0, volume: 0, fees: 0 };
  }
  const s = asObject(value, where);
  return {
    signins: readNumberOr(s, "signins", where, 0),
    maxStreak: readNumberOr(s, "maxStreak", where, 0),
    totalReward: readNumberOr(s, "totalReward", where, 0),
    trades: readNumberOr(s, "trades", where, 0),
    buys: readNumberOr(s, "buys", where, 0),
    sells: readNumberOr(s, "sells", where, 0),
    volume: readNumberOr(s, "volume", where, 0),
    fees: readNumberOr(s, "fees", where, 0),
  };
}

const STATUSES: readonly string[] = ["trading", "preopen", "lunch", "closed", "weekend"];

function parseMarketApi(value: unknown): CoinMarketApiMarket {
  const where = "market";
  const m = asObject(value, where);
  const status = readString(m, "status", where);
  if (!STATUSES.includes(status)) bad(where + ".status 不认识：" + status);
  return {
    sessionDate: readString(m, "sessionDate", where),
    sessionNumber: readNumber(m, "sessionNumber", where),
    status: status as CoinStatus,
    statusLabel: readString(m, "statusLabel", where),
    prevClose: readNumber(m, "prevClose", where),
    open: readNumber(m, "open", where),
    high: readNumber(m, "high", where),
    low: readNumber(m, "low", where),
    basePrice: readNumber(m, "basePrice", where),
    price: readNumber(m, "price", where),
    changePct: readNumber(m, "changePct", where),
    impactPct: readNumber(m, "impactPct", where),
    netBuy: readNumber(m, "netBuy", where),
    volume: readNumber(m, "volume", where),
  };
}

function parseSignin(value: unknown): CoinMarketSignin {
  const where = "user.signin";
  const s = asObject(value, where);
  const nextReward = readNumber(s, "nextReward", where);
  return {
    streak: readNumber(s, "streak", where),
    lastSignDay: readString(s, "lastSignDay", where),
    signedToday: readBool(s, "signedToday", where),
    canSign: readBool(s, "canSign", where),
    nextStreak: readNumber(s, "nextStreak", where),
    nextReward,
    nextRewardBase: readNumberOr(s, "nextRewardBase", where, nextReward),
    bonusPct: readNumberOr(s, "bonusPct", where, 0),
    daysToBonus: readNumberOr(s, "daysToBonus", where, 0),
    broken: readBoolOr(s, "broken", where, false),
  };
}

function parseUserApi(value: unknown): CoinMarketUser {
  const where = "user";
  const u = asObject(value, where);
  return {
    name: readString(u, "name", where),
    htc: readNumber(u, "htc", where),
    usdt: readNumber(u, "usdt", where),
    cost: readNumber(u, "cost", where),
    todayBuy: readNumber(u, "todayBuy", where),
    todaySell: readNumber(u, "todaySell", where),
    lastTradeAt: readNumber(u, "lastTradeAt", where),
    merged: readBool(u, "merged", where),
    streak: readNumber(u, "streak", where),
    lastSignDay: readString(u, "lastSignDay", where),
    value: readNumber(u, "value", where),
    achievements: readStringArray(u, "achievements", where),
    achievementStats: parseAchievementStats(u["achievementStats"]),
    bankruptCount: readNumberOr(u, "bankruptCount", where, 0),
    signin: parseSignin(u["signin"]),
  };
}

function parseLimits(value: unknown): CoinMarketLimits {
  const where = "limits";
  const l = asObject(value, where);
  return {
    feeRate: readNumber(l, "feeRate", where),
    maxOrder: readNumber(l, "maxOrder", where),
    buyPerDay: readNumber(l, "buyPerDay", where),
    sellPerDay: readNumber(l, "sellPerDay", where),
    cooldownMs: readNumber(l, "cooldownMs", where),
    mergeCapHtc: readNumber(l, "mergeCapHtc", where),
  };
}

function parseLeaderboard(value: unknown): CoinLeaderRow[] {
  if (!Array.isArray(value)) bad("leaderboard 不是数组");
  return value.slice(0, 50).map((item, i) => {
    const where = "leaderboard[" + i + "]";
    const row = asObject(item, where);
    return {
      rank: readNumber(row, "rank", where),
      name: readString(row, "name", where),
      value: readNumber(row, "value", where),
    };
  });
}

/** 把 `/api/state` 返回文本解析成 `CoinMarketState`。 */
export function parseCoinState(text: string): CoinMarketState {
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    bad("不是合法的 JSON");
  }
  const root = asObject(raw, "响应");
  const version = readNumber(root, "version", "响应");
  const serverTime = readString(root, "serverTime", "响应");
  return {
    version,
    serverTime,
    market: parseMarketApi(root["market"]),
    user: parseUserApi(root["user"]),
    limits: parseLimits(root["limits"]),
    leaderboard: parseLeaderboard(root["leaderboard"]),
  };
}
