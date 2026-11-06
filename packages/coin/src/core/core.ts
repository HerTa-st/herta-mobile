/*
 * 黑塔币 HTC · 手机端行情核心（TypeScript 逐行移植）
 *
 * 唯一事实来源：fc/coin-api/coin-core.js（唯一事实来源是 phantom-market/app.js，2026-10-29 版）。
 * 本文件是它的逐行同构移植：日期密钥 -> 确定性日线 -> 当日计划（新闻排点 + 开盘跳空 +
 * 240 根分钟路径 + 桥接到收盘 + 成交量）-> 按当前时间揭示已走过的分钟 -> 报价。
 * 新闻池在 news-pool.ts（同样是原样副本），对账脚本见 test/core-parity.test.mjs。
 *
 * 与网页的唯一差别是两处时间口径，两处都必须逐位一致：
 *   1. 固定模拟 UTC+8（Asia/Shanghai，无夏令时）：所有日期/星期/分钟都先用「墙上时间」
 *      （epoch + 8h）再做 UTC 换算，绝不使用 new Date(y, m, d) / 本地时区语义，
 *      也不碰 Node 的时区 API（Intl / toLocaleString 之类一律不用）。
 *   2. 种子字符串带密钥（docs/价格密钥-设计-2026-11-07.md §1）：
 *      CUTOVER = "2026-11-07"（含当天）
 *      daySeed(date)  = date < CUTOVER ? "HTC|daily|" + date     : "HTC|daily|" + date + "|" + secret(date)
 *      planSeed(date) = date < CUTOVER ? "HTC|intraday|" + date  : "HTC|intraday|" + date + "|" + secret(date)
 *      date 一律 YYYY-MM-DD（上海时间）。
 *
 * getSecret 是可选的：
 *   - 不传 = 全部日期走旧派生（历史日期复算、现存测试用；与服务端 2026-11-07 之前的实现逐位一致）；
 *   - 传了但某个 >= CUTOVER 的日期没有密钥 = 这天开不了盘，抛错（不拿日期派生备用密钥降级，
 *     否则会和服务端算出两条线）。< CUTOVER 的日期一律不调 getSecret（设计文档允许不实现）。
 */

import type { CoinBar, CoinDailyResponse, CoinStatus } from "../types.ts";
import { COIN_API_VERSION, TOTAL_BARS } from "../types.ts";
import { NEWS_POOL } from "./news-pool.ts";

export { TOTAL_BARS };

/* ============================================================
 * 常量（与 FC 一致）
 * ============================================================ */
export const COIN = {
  name: "黑塔币",
  code: "HTC",
  pair: "HTC/USDT",
  genesis: "2026-01-05",
  genesisClose: 88.88,
  dailyVol: 0.03
};

/** 接口版本（与 types.ts 的 COIN_API_VERSION 同一个值，服务端叫 API_VERSION）。 */
export const API_VERSION = COIN_API_VERSION;

/** 密钥切换日（含当天）：这天起种子串要接 |secret。 */
export const COIN_CUTOVER = "2026-11-07";

const EXCHANGES = ["模拟宇宙交易所", "星际所", "深空所", "奇物所", "空间站 OTC"];
const AM_START = 570; // 09:30
const AM_END = 690; // 11:30
const PM_START = 780; // 13:00
const PM_END = 900; // 15:00

export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
export const WEEK_NAMES = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** 取某一天的密钥；日期 < CUTOVER 时不会被调用。null 表示「还没拿到」。 */
export type GetSecret = (date: string) => string | null;

/* ============================================================
 * 确定性随机数（逐行同构）
 * ============================================================ */
export interface Rng {
  next(): number;
  range(a: number, b: number): number;
  int(a: number, b: number): number;
  chance(p: number): boolean;
  pick<T>(arr: readonly T[]): T;
  norm(): number;
}

function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0, k: number; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return function (): number {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function makeRng(seed: string): Rng {
  const w = cyrb128(seed);
  const gen = sfc32(w[0], w[1], w[2], w[3]);
  for (let i = 0; i < 12; i++) gen();
  let spare: number | null = null;
  return {
    next: gen,
    range(a: number, b: number): number { return a + (b - a) * gen(); },
    int(a: number, b: number): number { return Math.floor(a + (b - a + 1) * gen()); },
    chance(p: number): boolean { return gen() < p; },
    pick<T>(arr: readonly T[]): T { return arr[Math.floor(gen() * arr.length) % arr.length]; },
    norm(): number {
      if (spare !== null) { const v0 = spare; spare = null; return v0; }
      let u = 0, v = 0;
      while (u === 0) u = gen();
      while (v === 0) v = gen();
      const mag = Math.sqrt(-2 * Math.log(u));
      spare = mag * Math.sin(2 * Math.PI * v);
      return mag * Math.cos(2 * Math.PI * v);
    }
  };
}

export function fingerprint(str: string): string {
  const w = cyrb128(str);
  return w.map(function (n) { return n.toString(16).padStart(8, "0"); }).join("").toUpperCase().slice(0, 8);
}

/* ============================================================
 * 种子派生（带密钥）。所有 makeRng 的种子都从这两个函数出。
 * ============================================================ */
function secretOf(dateStr: string, getSecret: GetSecret): string {
  const secret = getSecret(dateStr);
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("缺 " + dateStr + " 的价格密钥：这天开不了盘");
  }
  return secret;
}

function seedOf(kind: "daily" | "intraday", dateStr: string, getSecret?: GetSecret): string {
  const base = "HTC|" + kind + "|" + dateStr;
  if (dateStr < COIN_CUTOVER) return base; // 旧日期：历史价格一根都不许变
  if (!getSecret) return base; // 没传 getSecret：整体走旧派生（历史复算 / 现存测试）
  return base + "|" + secretOf(dateStr, getSecret);
}

/** 日线种子：旧日期 "HTC|daily|YYYY-MM-DD"，CUTOVER 起再接 "|secret"。 */
export function daySeed(dateStr: string, getSecret?: GetSecret): string {
  return seedOf("daily", dateStr, getSecret);
}

/** 分钟路径种子：旧日期 "HTC|intraday|YYYY-MM-DD"，CUTOVER 起再接 "|secret"。 */
export function planSeed(dateStr: string, getSecret?: GetSecret): string {
  return seedOf("intraday", dateStr, getSecret);
}

/* ============================================================
 * 日期工具（固定 UTC+8）：所有「本地」语义都换成「墙上时间的 UTC」
 * ============================================================ */
function pad2(n: number): string { return n < 10 ? "0" + n : "" + n; }

// epoch 毫秒 -> 墙上时间 Date（其 UTC 字段 == 上海本地字段）
function wallFromMs(nowMs: number): Date { return new Date(nowMs + SHANGHAI_OFFSET_MS); }

// 上海本地零点（以 UTC 零点存放的墙上日期）
function wallDate(y: number, m: number, d: number): Date { return new Date(Date.UTC(y, m, d)); }

function wallYmd(d: Date): [number, number, number] {
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

/** 墙上日期 -> YYYY-MM-DD（上海时间）。 */
export function ds(d: Date): string {
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

function parseDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error("日期格式不对：" + s);
  return wallDate(+m[1], +m[2] - 1, +m[3]);
}

function isTradingDay(d: Date): boolean {
  const w = d.getUTCDay();
  return w >= 1 && w <= 5;
}

function prevTradingDay(d: Date): Date {
  const x = wallDate(...wallYmd(d));
  do { x.setUTCDate(x.getUTCDate() - 1); } while (!isTradingDay(x));
  return x;
}

function nextTradingDay(d: Date): Date {
  const x = wallDate(...wallYmd(d));
  do { x.setUTCDate(x.getUTCDate() + 1); } while (!isTradingDay(x));
  return x;
}

function tradingDatesBetween(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const x = wallDate(...wallYmd(start));
  const e = wallDate(...wallYmd(end));
  while (x <= e) {
    if (isTradingDay(x)) out.push(new Date(x.getTime()));
    x.setUTCDate(x.getUTCDate() + 1);
  }
  return out;
}

// 上海本地 hh:mm -> 墙上时间
function openAt(date: Date, hour: number, minute: number): Date {
  const [y, m, d] = wallYmd(date);
  return new Date(Date.UTC(y, m, d, hour, minute, 0, 0));
}

/** 契约要求的 serverTime 形如 2026-10-29T10:15:30+08:00（不依赖任何时区 API）。 */
export function formatServerTime(nowMs: number): string {
  const w = wallFromMs(nowMs);
  return w.getUTCFullYear() + "-" + pad2(w.getUTCMonth() + 1) + "-" + pad2(w.getUTCDate()) +
    "T" + pad2(w.getUTCHours()) + ":" + pad2(w.getUTCMinutes()) + ":" + pad2(w.getUTCSeconds()) + "+08:00";
}

/* ============================================================
 * 新闻库（NEWS_POOL 由 news-pool.ts 原样提供）
 * ============================================================ */
export interface NewsPoolItem { sign: string; strength: number; text: string; }
export interface NewsPool { bull: NewsPoolItem[]; bear: NewsPoolItem[]; flat: NewsPoolItem[]; total: number; }

let POOL: NewsPool | null = null;

function getPool(): NewsPool {
  if (POOL) return POOL;
  const bull: NewsPoolItem[] = [], bear: NewsPoolItem[] = [], flat: NewsPoolItem[] = [];
  NEWS_POOL.forEach(function (raw) {
    if (typeof raw !== "string" || raw.length < 3) return;
    const sign = raw.charAt(0);
    const strength = Math.min(3, Math.max(1, parseInt(raw.charAt(1), 10) || 1));
    const text = raw.slice(2);
    const item = { sign: sign, strength: strength, text: text };
    if (sign === "+") bull.push(item);
    else if (sign === "-") bear.push(item);
    else if (sign === "=") flat.push(item);
  });
  let bullOut = bull, bearOut = bear, flatOut = flat;
  if (!bullOut.length || !bearOut.length) {
    bullOut = [{ sign: "+", strength: 2, text: "{name}获得大额买入" }];
    bearOut = [{ sign: "-", strength: 2, text: "{name}遭到集中抛售" }];
  }
  if (!flatOut.length) flatOut = [{ sign: "=", strength: 1, text: "{name}发布例行公告" }];
  POOL = { bull: bullOut, bear: bearOut, flat: flatOut, total: bullOut.length + bearOut.length + flatOut.length };
  return POOL;
}

/* ============================================================
 * 日收盘价链（连续行情的基础）
 * ============================================================ */
export interface DayClose { date: Date; close: number; }

/*
 * 单日收盘的记忆化：键 = 当日日线种子字符串（日期 + 密钥，天然唯一）。
 * 这样密钥换了/历史复算不会串味，也不必把整条链按「结束日期」缓存。
 */
const closeCache = new Map<string, number>();

function closeFor(dateStr: string, prevClose: number, getSecret?: GetSecret): number {
  const seed = daySeed(dateStr, getSecret);
  const hit = closeCache.get(seed);
  if (hit !== undefined) return hit;
  const dev = Math.log(prevClose / COIN.genesisClose);
  const rng = makeRng(seed);
  const ret = rng.norm() * COIN.dailyVol + 0.0005 - 0.010 * dev;
  let close = prevClose * (1 + ret);
  if (close < COIN.genesisClose * 0.2) close = COIN.genesisClose * 0.2;
  if (close > COIN.genesisClose * 5) close = COIN.genesisClose * 5;
  closeCache.set(seed, close);
  return close;
}

/** 从创世日走到 endDateStr 的日收盘价链（含两端，只含交易日）。 */
export function dailySeries(endDateStr: string, getSecret?: GetSecret): DayClose[] {
  const endDate = parseDate(endDateStr);
  const start = parseDate(COIN.genesis);
  let dates = tradingDatesBetween(start, endDate);
  if (!dates.length) {
    const [y, m, d] = wallYmd(endDate);
    dates = [wallDate(y, m, d)];
  }

  let close = COIN.genesisClose;
  const list: DayClose[] = [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const dstr = ds(d);
    if (dstr === COIN.genesis) {
      list.push({ date: d, close: close });
      continue;
    }
    close = closeFor(dstr, close, getSecret);
    list.push({ date: d, close: close });
  }
  return list;
}

/* ============================================================
 * 当日计划：分钟 K + 新闻事件
 * ============================================================ */
export interface PlanEvent { bar: number; dir: number; strength: number; tpl: string; }
export interface RawBar { open: number; high: number; low: number; close: number; volume: number; partial?: true; }
export interface Plan {
  /** 场次日期 YYYY-MM-DD。 */
  date: string;
  key: string;
  prevClose: number;
  open: number;
  targetClose: number;
  bars: RawBar[];
  events: PlanEvent[];
  eventAt: Record<number, PlanEvent>;
  dayVolume: number;
  sessionNumber: number;
}

const planCache = new Map<string, Plan>();

export function buildPlan(dateStr: string, getSecret?: GetSecret): Plan {
  const key = ds(parseDate(dateStr));
  const cacheKey = planSeed(key, getSecret);
  const cached = planCache.get(cacheKey);
  if (cached) return cached;

  const series = dailySeries(key, getSecret);
  const last = series.length - 1;
  const today = series[last];
  const prev = series[last - 1] || today;

  const rng = makeRng(cacheKey);
  const pool = getPool();

  /* --- 1. 排新闻：按分钟分布，方向和强度会在生成行情时给冲击 --- */
  const events: PlanEvent[] = [];
  const usedText: Record<string, boolean> = {};
  let cursor = rng.int(2, 7);
  while (cursor < TOTAL_BARS - 1) {
    const dir = rng.chance(0.52) ? 1 : -1;
    const arr = dir > 0 ? pool.bull : pool.bear;
    let item = rng.pick(arr);
    let guard = 0;
    while (usedText[item.text] && guard++ < 10) item = rng.pick(arr);
    usedText[item.text] = true;
    events.push({ bar: cursor, dir: dir, strength: item.strength, tpl: item.text });
    cursor += rng.int(7, 15);
  }
  const neutralCount = 2 + rng.int(0, 1);
  for (let n = 0; n < neutralCount; n++) {
    const idx = rng.int(4, TOTAL_BARS - 2);
    const closeBy = events.some(function (e) { return Math.abs(e.bar - idx) < 3; });
    const flatItem = rng.pick(pool.flat);
    if (!closeBy) {
      events.push({ bar: idx, dir: 0, strength: flatItem.strength, tpl: flatItem.text });
    }
  }
  events.sort(function (a, b) { return a.bar - b.bar; });
  const eventAt: Record<number, PlanEvent> = {};
  events.forEach(function (e) { eventAt[e.bar] = e; });

  /* --- 2. 当日开盘：承接昨日收盘 + 小幅跳空 --- */
  let gap = rng.norm() * 0.005;
  gap = Math.max(-0.018, Math.min(0.018, gap));
  const open = prev.close * (1 + gap);

  /* --- 3. 生成 240 根分钟收盘路径 --- */
  const sigma = 0.0016;
  let volState = 1;
  const drift = rng.norm() * 0.00008;
  let price = open;
  const rawCloses: number[] = [];
  const wickUp: number[] = [];
  const wickDown: number[] = [];
  const volumes: number[] = [];

  for (let i = 0; i < TOTAL_BARS; i++) {
    const ev = eventAt[i] || null;
    volState = volState * 0.94 + 0.06 * (0.8 + rng.next() * 0.6);
    let s = sigma * volState;
    let ret = drift + rng.norm() * s;
    if (ev) {
      ret += ev.dir * (0.0010 + ev.strength * 0.00045);
      s *= 1 + ev.strength * 0.25;
    }
    const next = price * (1 + ret);
    rawCloses.push(next);
    wickUp.push((0.18 + Math.abs(rng.norm()) * 0.5) * s);
    wickDown.push((0.18 + Math.abs(rng.norm()) * 0.5) * s);
    const baseVol = 1700;
    const vol = baseVol * (0.55 + Math.abs(ret) / (s + 1e-9) * 0.45) *
      Math.exp(rng.norm() * 0.25) * (ev ? 1 + ev.strength * 0.6 : 1);
    volumes.push(Math.max(60, Math.round(vol)));
    price = next;
  }

  /* --- 4. 桥接到当日目标收盘（保证日线连续） --- */
  const target = today.close;
  const correction = Math.log(target / rawCloses[TOTAL_BARS - 1]) / TOTAL_BARS;

  const bars: RawBar[] = [];
  for (let j = 0; j < TOTAL_BARS; j++) {
    const factor = Math.exp(correction * (j + 1));
    const close = rawCloses[j] * factor;
    const barOpen = j === 0 ? open : bars[j - 1].close;
    const high = Math.max(barOpen, close) * (1 + wickUp[j]);
    const low = Math.min(barOpen, close) * (1 - wickDown[j]);
    bars.push({
      open: barOpen,
      high: high,
      low: low,
      close: close,
      volume: volumes[j]
    });
  }

  const dayVolume = bars.reduce(function (sum, b) { return sum + b.volume; }, 0);

  const plan: Plan = {
    date: key,
    key: key,
    prevClose: prev.close,
    open: open,
    targetClose: target,
    bars: bars,
    events: events,
    eventAt: eventAt,
    dayVolume: dayVolume,
    sessionNumber: series.length
  };
  planCache.set(cacheKey, plan);
  return plan;
}

/* ============================================================
 * 交易时段（固定 UTC+8）
 * ============================================================ */
export interface SessionInfo {
  now: Date;
  today: Date;
  /** 展示场次的日期 YYYY-MM-DD（周末 / 盘前是上一场）。 */
  sessionDate: string;
  status: CoinStatus;
  label: string;
  inSession: boolean;
  revealed: number;
  partial: number;
  target: Date | null;
  countdownLabel: string;
}

export function getSession(nowMs: number): SessionInfo {
  const now = wallFromMs(nowMs);
  const wd = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60 + now.getUTCMilliseconds() / 60000;
  const today = wallDate(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const res: SessionInfo = {
    now: now,
    today: today,
    sessionDate: ds(today),
    status: "closed",
    label: "已收盘",
    inSession: false,
    revealed: 0,
    partial: 0,
    target: null,
    countdownLabel: "距开盘"
  };

  if (wd === 0 || wd === 6) {
    res.sessionDate = ds(prevTradingDay(today));
    res.status = "weekend";
    res.label = "休市 · 周末";
    res.revealed = TOTAL_BARS;
    res.target = openAt(nextTradingDay(today), 9, 30);
    return res;
  }

  if (mins < AM_START) {
    res.sessionDate = ds(prevTradingDay(today));
    res.status = "preopen";
    res.label = "盘前 · 未开盘";
    res.revealed = TOTAL_BARS;
    res.target = openAt(today, 9, 30);
    return res;
  }

  res.sessionDate = ds(today);

  if (mins < AM_END) {
    const e = mins - AM_START;
    res.status = "trading";
    res.inSession = true;
    res.label = "交易中 · 上午";
    res.revealed = Math.min(TOTAL_BARS, Math.floor(e));
    res.partial = Math.min(1, e - Math.floor(e));
    res.target = openAt(today, 11, 30);
    res.countdownLabel = "距午休";
    return res;
  }

  if (mins < PM_START) {
    res.status = "lunch";
    res.label = "午间休市";
    res.revealed = 120;
    res.target = openAt(today, 13, 0);
    res.countdownLabel = "距下午开盘";
    return res;
  }

  if (mins < PM_END) {
    const e2 = 120 + (mins - PM_START);
    res.status = "trading";
    res.inSession = true;
    res.label = "交易中 · 下午";
    res.revealed = Math.min(TOTAL_BARS, Math.floor(e2));
    res.partial = Math.min(1, e2 - Math.floor(e2));
    if (res.revealed >= TOTAL_BARS) {
      res.revealed = TOTAL_BARS;
      res.partial = 0;
    }
    res.target = openAt(today, 15, 0);
    res.countdownLabel = "距收盘";
    return res;
  }

  res.status = "closed";
  res.label = "已收盘";
  res.revealed = TOTAL_BARS;
  res.target = openAt(nextTradingDay(today), 9, 30);
  res.countdownLabel = "距下次开盘";
  return res;
}

/* ============================================================
 * 局部分钟 K（当前未走完的那根）
 * ============================================================ */
export function partialBar(plan: Plan, index: number, frac: number, nowMs: number): RawBar {
  const bar = plan.bars[index];
  const sec = Math.floor(nowMs / 1000);
  const rng = makeRng("HTC|tick|" + plan.key + "|" + index + "|" + sec);
  const ease = frac * frac * (3 - 2 * frac);
  const jitter = (rng.next() - 0.5) * 0.0012 * Math.sin(Math.PI * frac);
  const base = bar.open;
  const price = base + (bar.close - base) * ease + base * jitter;
  const upMax = Math.max(bar.open, bar.close);
  const downMin = Math.min(bar.open, bar.close);
  const high = Math.max(base, price) + (bar.high - upMax) * frac;
  const low = Math.min(base, price) - (downMin - bar.low) * frac;
  return {
    open: base,
    high: high,
    low: low,
    close: price,
    volume: bar.volume * frac,
    partial: true
  };
}

/** 按当前时刻揭示已走过的分钟；交易中再补一根未走完的。 */
export function buildDisplay(plan: Plan, info: SessionInfo, nowMs: number): RawBar[] {
  const out: RawBar[] = [];
  for (let i = 0; i < Math.min(info.revealed, TOTAL_BARS); i++) out.push(plan.bars[i]);
  if (info.inSession && info.revealed < TOTAL_BARS) {
    out.push(partialBar(plan, info.revealed, info.partial, nowMs));
  }
  return out;
}

/* ============================================================
 * 报价（与网页 computeQuote 一致）
 * ============================================================ */
export interface Quote {
  price: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  turnover: number;
  change: number;
  pct: number;
  amplitude: number;
}

export function computeQuote(plan: Plan, bars: readonly RawBar[]): Quote {
  const lastBar = bars[bars.length - 1];
  const price = lastBar.close;
  let high = -Infinity, low = Infinity, volume = 0, turnover = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volume += b.volume;
    turnover += ((b.open + b.close) / 2) * b.volume;
  }
  const change = price - plan.prevClose;
  const pct = change / plan.prevClose * 100;
  const amplitude = (high - low) / plan.prevClose * 100;
  return {
    price: price,
    open: plan.open,
    high: high,
    low: low,
    prevClose: plan.prevClose,
    volume: volume,
    turnover: turnover,
    change: change,
    pct: pct,
    amplitude: amplitude
  };
}

/* ============================================================
 * 契约 §2.2 返回体
 * ============================================================ */
export function buildDailyResponse(nowMs: number, getSecret?: GetSecret): CoinDailyResponse {
  const ms = typeof nowMs === "number" ? nowMs : Number(nowMs);
  if (!Number.isFinite(ms)) throw new TypeError("nowMs 必须是有效的毫秒时间戳，收到：" + nowMs);

  const info = getSession(ms);
  const plan = buildPlan(info.sessionDate, getSecret);
  const displayBars = buildDisplay(plan, info, ms);
  const quote = computeQuote(plan, displayBars);
  const sessionKey = plan.key; // == ds(info.sessionDate)，场次日期 YYYY-MM-DD

  const bars: CoinBar[] = displayBars.map(function (b, i) {
    const item: CoinBar = { t: i, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume };
    if (b.partial) item.partial = true;
    return item;
  });

  return {
    version: API_VERSION,
    serverTime: formatServerTime(ms),
    market: {
      name: COIN.name,
      code: COIN.code,
      pair: COIN.pair,
      sessionDate: sessionKey,
      sessionNumber: plan.sessionNumber,
      status: info.status,
      statusLabel: info.label,
      prevClose: quote.prevClose,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      close: quote.price,
      changePct: quote.pct,
      volume: quote.volume,
      turnover: quote.turnover,
      revealed: info.revealed,
      partial: info.partial,
      keyFingerprint: fingerprint(sessionKey),
      bars: bars
    }
  };
}
