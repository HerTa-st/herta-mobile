/**
 * 行情接口：URL、严格解析、取数与格式化。
 *
 * 解析是**严格**的：字段缺一个、类型不对、bars 越界、JSON 坏了，都抛中文 Error。
 * 理由：行情数据直接决定签到入账与盈亏，宁可让页面显示「行情暂不可用」，
 * 也不能把 `undefined` 当价格算进钱包。
 */

import { COIN_API_VERSION, TOTAL_BARS } from "./types.ts";
import type { CoinBar, CoinDailyResponse, CoinMarket, CoinStatus } from "./types.ts";

/** 接口路径。base 去尾斜杠，空串会得到相对路径 `/api/daily`（调用方应自己拦空 base）。 */
export function coinApiUrl(base: string): string {
  return base.replace(/\/+$/, "") + "/api/daily";
}

/* -------------------------------------------------------------- 严格解析 */

type Json = Record<string, unknown>;

function bad(detail: string): never {
  throw new Error("行情数据格式不对：" + detail);
}

function asObject(value: unknown, where: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad(where + " 应该是对象");
  return value as Json;
}

function readString(obj: Json, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) bad(where + "." + key + " 缺失或不是字符串");
  return v;
}

function readNumber(obj: Json, key: string, where: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) bad(where + "." + key + " 缺失或不是数字");
  return v;
}

const STATUSES: readonly string[] = ["trading", "preopen", "lunch", "closed", "weekend"];

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function readBar(value: unknown, where: string): CoinBar {
  const bar = asObject(value, where);
  const t = readNumber(bar, "t", where);
  if (!Number.isInteger(t) || t < 0 || t >= TOTAL_BARS) bad(where + ".t 应该是 0.." + (TOTAL_BARS - 1) + " 的整数");
  const bar_: CoinBar = {
    t,
    o: readNumber(bar, "o", where),
    h: readNumber(bar, "h", where),
    l: readNumber(bar, "l", where),
    c: readNumber(bar, "c", where),
    v: readNumber(bar, "v", where),
  };
  const partial = bar["partial"];
  if (partial !== undefined) {
    if (typeof partial !== "boolean") bad(where + ".partial 不是布尔值");
    bar_.partial = partial;
  }
  return bar_;
}

function parseMarket(value: unknown): CoinMarket {
  const where = "market";
  const m = asObject(value, where);

  const name = readString(m, "name", where);
  const code = readString(m, "code", where);
  const pair = readString(m, "pair", where);
  const sessionDate = readString(m, "sessionDate", where);
  if (!YMD_RE.test(sessionDate)) bad(where + ".sessionDate 不是 YYYY-MM-DD");
  const sessionNumber = readNumber(m, "sessionNumber", where);
  if (!Number.isInteger(sessionNumber) || sessionNumber < 0) bad(where + ".sessionNumber 不是非负整数");
  const status = readString(m, "status", where);
  if (!STATUSES.includes(status)) bad(where + ".status 不认识：" + status);
  const statusLabel = readString(m, "statusLabel", where);
  const prevClose = readNumber(m, "prevClose", where);
  const open = readNumber(m, "open", where);
  const high = readNumber(m, "high", where);
  const low = readNumber(m, "low", where);
  const close = readNumber(m, "close", where);
  const changePct = readNumber(m, "changePct", where);
  const volume = readNumber(m, "volume", where);
  const turnover = readNumber(m, "turnover", where);
  const revealed = readNumber(m, "revealed", where);
  if (!Number.isInteger(revealed) || revealed < 0 || revealed > TOTAL_BARS) {
    bad(where + ".revealed 应该是 0.." + TOTAL_BARS + " 的整数");
  }
  const partial = readNumber(m, "partial", where);
  const keyFingerprint = readString(m, "keyFingerprint", where);

  const barsRaw = m["bars"];
  if (!Array.isArray(barsRaw)) bad(where + ".bars 缺失或不是数组");
  const bars = barsRaw.map((item, i) => readBar(item, where + ".bars[" + i + "]"));

  return {
    name,
    code,
    pair,
    sessionDate,
    sessionNumber,
    status: status as CoinStatus,
    statusLabel,
    prevClose,
    open,
    high,
    low,
    close,
    changePct,
    volume,
    turnover,
    revealed,
    partial,
    keyFingerprint,
    bars,
  };
}

/**
 * 把接口返回的文本解析成 `CoinDailyResponse`。
 *
 * 非法 JSON / 字段缺失 / 类型不对 → `Error("行情数据格式不对：…")`。
 */
export function parseCoinDaily(text: string): CoinDailyResponse {
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    bad("不是合法的 JSON");
  }
  const root = asObject(raw, "响应");
  const version = readNumber(root, "version", "响应");
  if (version !== COIN_API_VERSION) bad("接口版本不支持：" + version);
  const serverTime = readString(root, "serverTime", "响应");
  if (Number.isNaN(Date.parse(serverTime))) bad("serverTime 不是合法时间");
  const market = parseMarket(root["market"]);
  return { version, serverTime, market };
}

/* ------------------------------------------------------------------ 取数 */

/**
 * 拉一次 `/api/daily`。`getText` 由调用方给：浏览器/native 都走 transport，包本身不碰网络。
 */
export async function fetchCoinDaily(
  base: string,
  getText: (url: string) => Promise<string>
): Promise<CoinDailyResponse> {
  if (!base.trim()) throw new Error("未配置行情接口");
  const text = await getText(coinApiUrl(base));
  return parseCoinDaily(text);
}

/* ---------------------------------------------------------------- 格式化 */

/**
 * 涨跌幅：`+1.00%` / `-0.50%` / `0.00%`（四舍五入到零就不带符号）。
 * 入参是百分数（接口的 changePct 口径）。
 */
export function formatPct(pct: number, digits = 2): string {
  const v = Number.isFinite(pct) ? pct : 0;
  const rounded = Number(v.toFixed(digits));
  const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "";
  return sign + Math.abs(rounded).toFixed(digits) + "%";
}

/** 价格：两位小数。 */
export function formatPrice(v: number, digits = 2): string {
  return Number.isFinite(v) ? v.toFixed(digits) : "—";
}

/**
 * 成交量/成交额缩写，逐字沿用网页 `fmtWan` 口径：
 * `≥1e8 → x.xx 亿`、`≥1e4 → x.xx 万`、否则整数。
 */
export function formatAmount(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + " 亿";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + " 万";
  return v.toFixed(0);
}
