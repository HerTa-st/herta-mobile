/**
 * 签到：连签曲线、断签判定、可签状态与入账。
 *
 * 几条铁律（设计文档决策 7/8/9/11，契约 §0 补充口径）：
 *   - 只在工作日、服务器本地时间 ≥ 09:30 后可签；周末不可签。
 *   - 目标场次 = **服务器本地日期**（不认手机日期，防改时间）。
 *   - 连签：`lastSign.date` 的下一个交易日 ≠ 目标场次 → 从 1 重算。
 *   - 奖励按签到当时实时价入账，v1 不并入成本价。
 *
 * 这个文件纯函数、无 I/O；时间只从入参 `serverTime` 拿，手机本地日期只用来选一句文案。
 */

import type { CoinHistoryEntry, CoinWallet } from "./types.ts";

export type SigninReason = "ok" | "already" | "preopen" | "weekend" | "clock";

export interface SigninCheck {
  canSign: boolean;
  reason: SigninReason;
  /** 本次要签的场次（服务器本地日期，工作日；周末为 null）。 */
  targetDate: string | null;
  /** 现在的连签天数（已签/未签都填；断签后为 0）。 */
  currentStreak: number;
  /** 下一次签到完成后的连签天数。 */
  nextStreak: number;
  /** 下一次签到能拿多少 HTC。 */
  reward: number;
  /** 签到卡副文案，UI 直接用。 */
  message: string;
}

/** 09:30（服务器本地时间）开始可签。 */
export const SIGNIN_OPEN_MINUTE = 570;

/** 签到历史只留最近这么多条。 */
export const SIGNIN_HISTORY_MAX = 60;

/* ------------------------------------------------------------ 小工具 */

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return (n < 10 ? "0" : "") + n;
}

function parseYmd(ymd: string): { y: number; m: number; d: number } | null {
  const m = YMD_RE.exec(ymd);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // 回读一遍，拦住 2026-02-31 这类会被 Date 悄悄进位的日期
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

function toYmd(dt: Date): string {
  return dt.getUTCFullYear() + "-" + pad2(dt.getUTCMonth() + 1) + "-" + pad2(dt.getUTCDate());
}

function addDays(ymd: string, days: number): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return toYmd(dt);
}

/** 周一~周五。格式不合法按 false 处理（脏数据不该把签到卡炸掉）。 */
export function isTradingDay(ymd: string): boolean {
  const p = parseYmd(ymd);
  if (!p) return false;
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return day >= 1 && day <= 5;
}

/** 指定日期之后的下一个交易日（周六/周日 → 下周一；非法日期原样返回）。 */
export function nextTradingDay(ymd: string): string {
  if (!parseYmd(ymd)) return ymd;
  let next = addDays(ymd, 1);
  for (let i = 0; i < 14 && !isTradingDay(next); i++) next = addDays(next, 1);
  return next;
}

/** 服务器本地日期：接口时间固定 UTC+8，形如 `2026-10-29T10:15:30+08:00`。 */
function serverDateOf(serverTime: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(serverTime);
  if (m && parseYmd(m[1])) return m[1];
  const t = Date.parse(serverTime);
  if (Number.isNaN(t)) return null;
  return toYmd(new Date(t + 8 * 3600_000));
}

/** 服务器本地时间的「当天第几分钟」。 */
function serverMinuteOf(serverTime: string): number | null {
  const m = /T(\d{2}):(\d{2})/.exec(serverTime);
  if (m) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h < 24 && mi < 60) return h * 60 + mi;
  }
  const t = Date.parse(serverTime);
  if (Number.isNaN(t)) return null;
  const shifted = new Date(t + 8 * 3600_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** 手机本地日期（只用来判断「用户是不是把手机日期改了」）。 */
function phoneLocalDate(now: Date): string {
  return now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
}

/* ------------------------------------------------------------ 连签曲线 */

/**
 * 连签奖励：1→10、2→20、之后每天 +5，第 8 天起 +50 封顶。
 * 即 10 / 20 / 25 / 30 / 35 / 40 / 45 / 50 / 50 …
 */
export function rewardForStreak(streak: number): number {
  const day = Number.isFinite(streak) ? Math.floor(streak) : 0;
  if (day <= 1) return 10;
  if (day === 2) return 20;
  return Math.min(50, 10 + day * 5);
}

/* ------------------------------------------------------------ 主逻辑 */

export function signinCheck(input: { wallet: CoinWallet | null; sessionDate: string; serverTime: string }): SigninCheck {
  const { wallet, serverTime } = input;
  const lastSign = wallet?.lastSign ?? null;
  const lastStreak = lastSign && Number.isFinite(lastSign.streak) && lastSign.streak > 0 ? Math.floor(lastSign.streak) : 0;

  const serverDate = serverDateOf(serverTime);
  const minute = serverMinuteOf(serverTime);
  if (!serverDate || minute === null) {
    // 连服务器时间都解析不了：不猜，一律以服务器为准
    return {
      canSign: false,
      reason: "clock",
      targetDate: null,
      currentStreak: lastStreak,
      nextStreak: lastStreak + 1,
      reward: rewardForStreak(lastStreak + 1),
      message: "以服务器时间为准",
    };
  }

  // 周末：不签，只能等下一场开盘
  if (!isTradingDay(serverDate)) {
    const next = nextTradingDay(serverDate);
    const keep = lastSign ? nextTradingDay(lastSign.date) === next : false;
    const currentStreak = keep ? lastStreak : 0;
    const nextStreak = currentStreak + 1;
    return {
      canSign: false,
      reason: "weekend",
      targetDate: null,
      currentStreak,
      nextStreak,
      reward: rewardForStreak(nextStreak),
      message: "休市 · 下一场开盘后可签",
    };
  }

  const targetDate = serverDate;

  // 老数据/被改过：上次签到日期在服务器日期之后 → 只信服务器
  if (lastSign && lastSign.date > targetDate) {
    return {
      canSign: false,
      reason: "clock",
      targetDate,
      currentStreak: lastStreak,
      nextStreak: lastStreak + 1,
      reward: rewardForStreak(lastStreak + 1),
      message: "以服务器时间为准",
    };
  }

  // 今日已签：防改时间的提示也走这一支
  if (lastSign && lastSign.date === targetDate) {
    const local = phoneLocalDate(new Date());
    const nextStreak = lastStreak + 1;
    return {
      canSign: false,
      reason: "already",
      targetDate,
      currentStreak: lastStreak,
      nextStreak,
      reward: rewardForStreak(nextStreak),
      message: local !== targetDate ? "以服务器时间为准，未到下一场" : "今日已签到 · 连续 " + lastStreak + " 天",
    };
  }

  // 09:30 前：开盘后再说
  if (minute < SIGNIN_OPEN_MINUTE) {
    const keep = lastSign ? nextTradingDay(lastSign.date) === targetDate : false;
    const currentStreak = keep ? lastStreak : 0;
    const nextStreak = currentStreak + 1;
    return {
      canSign: false,
      reason: "preopen",
      targetDate,
      currentStreak,
      nextStreak,
      reward: rewardForStreak(nextStreak),
      message: "09:30 开盘后可签到",
    };
  }

  // 可签：看上次签到是不是上一个交易日，决定连签是续还是重来
  const keep = lastSign ? nextTradingDay(lastSign.date) === targetDate : false;
  const currentStreak = keep ? lastStreak : 0;
  const nextStreak = currentStreak + 1;
  const reward = rewardForStreak(nextStreak);
  return {
    canSign: true,
    reason: "ok",
    targetDate,
    currentStreak,
    nextStreak,
    reward,
    message: "连续签到第 " + nextStreak + " 天，+" + reward + " HTC",
  };
}

/**
 * 把一次签到写进钱包：history 追加（最多 60 条）、holdings 加奖励、lastSign 更新。
 * 不可签时原样返回（幂等，防手滑重复入账）。
 */
export function applySignin(input: {
  wallet: CoinWallet;
  check: SigninCheck;
  price: number;
  nowISO: string;
}): CoinWallet {
  const { wallet, check, price, nowISO } = input;
  if (!check.canSign || !check.targetDate) return wallet;
  const date = check.targetDate;
  if (wallet.lastSign?.date === date) return wallet;

  const entry: CoinHistoryEntry = { date, reward: check.reward, price };
  const history = [...wallet.history, entry].slice(-SIGNIN_HISTORY_MAX);
  return {
    ...wallet,
    version: 1,
    holdings: wallet.holdings + check.reward,
    lastSign: { date, streak: check.nextStreak, price, reward: check.reward },
    history,
    updatedAt: nowISO,
  };
}
