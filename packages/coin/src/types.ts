/**
 * 黑塔币 v1 的数据模型。
 *
 * 与 `docs/coin-实现契约.md` §2.2 / §3 完全同形：FC 返回体、本地钱包、签到记录都定义在这。
 * 这个包是纯逻辑（Node 里直接跑 .ts 测试），所以不 import 任何 app / 浏览器 API。
 */

/** 接口版本。FC 返回 `version`，对不上就拒（v1 只认 1）。 */
export const COIN_API_VERSION = 1;

/** 一场 240 根分钟 K（09:30–11:30、13:00–15:00）。 */
export const TOTAL_BARS = 240;

/** 交易时段状态，与 FC 的 `market.status` 一一对应。 */
export type CoinStatus = "trading" | "preopen" | "lunch" | "closed" | "weekend";

/** 一根分钟 K。`t` 是 0..239 的固定时间轴下标；`partial` 只出现在当前未走完的那根上。 */
export interface CoinBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  partial?: boolean;
}

/** FC `/api/daily` 返回的 market 一整块（字段一个不能少，见契约 §2.2）。 */
export interface CoinMarket {
  name: string;
  code: string;
  pair: string;
  /** 展示场次的日期 YYYY-MM-DD（周末/盘前是上一场）。 */
  sessionDate: string;
  sessionNumber: number;
  status: CoinStatus;
  statusLabel: string;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 百分数，不是小数：1.002 表示 +1.002%。 */
  changePct: number;
  volume: number;
  turnover: number;
  revealed: number;
  /** 当前分钟进度 0..1。 */
  partial: number;
  keyFingerprint: string;
  bars: CoinBar[];
}

/** `/api/daily` 返回体。 */
export interface CoinDailyResponse {
  version: number;
  /** 服务器时间（固定 UTC+8），形如 `2026-10-29T10:15:30+08:00`。签到只认它。 */
  serverTime: string;
  market: CoinMarket;
}

/** 钱包里最近一次签到。 */
export interface CoinSignRecord {
  /** 服务器场次日期 YYYY-MM-DD。 */
  date: string;
  /** 连续签到天数。 */
  streak: number;
  /** 入账价。 */
  price: number;
  /** 本次奖励 HTC。 */
  reward: number;
}

/** 签到历史（只留最近 60 条，供备份与以后展示用）。 */
export interface CoinHistoryEntry {
  date: string;
  reward: number;
  price: number;
}

/** 本地钱包。首次进黑塔币页时送 1000 HTC，成本价 = 首次激活时的开盘价。 */
export interface CoinWallet {
  version: 1;
  holdings: number;
  costPrice: number;
  /** 首次激活时间（ISO）。 */
  initialAt: string;
  lastSign: CoinSignRecord | null;
  history: CoinHistoryEntry[];
  updatedAt: string;
}
