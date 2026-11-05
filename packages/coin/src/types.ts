/**
 * 黑塔币 v1 的数据模型。
 *
 * 与 `docs/coin-实现契约.md` §2.2 / §3 完全同形：FC 返回体、本地钱包、签到记录都定义在这。
 * 这个包是纯逻辑（Node 里直接跑 .ts 测试），所以不 import 任何 app / 浏览器 API。
 *
 * B7 追加（全部向后兼容，新字段都可缺省）：
 *   - 签到：连签 7 天起 +5%，SigninCheck 增加 bonusPct / daysToBonus / broken；
 *   - 成就：20 条目录 + 判定纯函数（achievements.ts），钱包里只存已解锁 id；
 *   - 收支：统一走 applyLedger，钱包里留最近 200 条 ledger；
 *   - 快讯：/api/daily 可带 news（服务端用 news-pool 排好，客户端不重算）。
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

/** 服务端随行情下发的快讯（与网页同一套 news-pool 种子；不在客户端重算）。 */
export interface CoinNewsItem {
  /** 冲击的那根分钟 K 的下标 0..239；点条目就定位到它。 */
  bar: number;
  /** HH:MM（与图表时间轴同一口径）。 */
  time: string;
  dir: "up" | "down" | "flat";
  /** 利好 / 利空 / 中性。 */
  tag: string;
  /** 1..3，界面用圆点表示强度。 */
  strength: number;
  text: string;
}

export interface CoinNewsFeed {
  /** 本场一共多少条（未解锁的不下发，只给总数）。 */
  total: number;
  /** 已解锁的快讯，按时间倒序。 */
  items: CoinNewsItem[];
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
  /** B7：服务端随行情下发的虚构快讯；老服务端没有这一块。 */
  news?: CoinNewsFeed;
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

/** 挂单方向：限价买入 / 限价卖出（双向）。 */
export type CoinOrderSide = "buy" | "sell";

/** 挂单有效期：1 小时 / 24 小时 / 3 天。 */
export type CoinOrderTtl = "1h" | "24h" | "3d";

/**
 * 共享挂单表里的一条限价单。
 *
 * 它不是订单簿：没有对手方，价格触及后由系统按当时市价成交。
 * expiresAt 是绝对毫秒时间戳；过期后日结/下一次下单时清掉。
 */
export interface CoinLimitOrder {
  id: string;
  /** 下单昵称；共享挂单表可见，但不是撮合对手。 */
  user: string;
  side: CoinOrderSide;
  amount: number;
  limitPrice: number;
  ttl: CoinOrderTtl;
  createdAt: string;
  expiresAt: number;
}

/** 空头仓位（逐仓，一笔）。borrowedAt / lastInterestAt 都是毫秒时间戳。 */
export interface CoinShortPosition {
  amount: number;
  entryPrice: number;
  /** 开仓时锁定的价值（amount × entryPrice），利息按它算。 */
  notional: number;
  borrowedAt: number;
  lastInterestAt: number;
}

/** 收支来源：签到、买卖、合并、利息、重开等。 */
export type CoinLedgerSource =
  | "signin"
  | "trade:buy"
  | "trade:sell"
  | "trade:short_open"
  | "trade:short_close"
  | "interest"
  | "claim"
  | "restart"
  | string;

/** 一条收支审计记录（净变动，单位见 htc / usdt）。 */
export interface CoinLedgerEntry {
  at: string;
  source: CoinLedgerSource;
  /** HTC 变动（含签到奖励、合并入账）。 */
  htc: number;
  /** 信用点（接口字段仍叫 usdt）变动。单机钱包没有现金，恒为 0。 */
  usdt: number;
}

/** 成就判定用的累计计数器（与来源打标一起维护）。 */
export interface CoinAchievementStats {
  signins: number;
  maxStreak: number;
  totalReward: number;
  trades: number;
  buys: number;
  sells: number;
  volume: number;
  fees: number;
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
  /** 已解锁成就 id（B7；老钱包没有就是空数组）。 */
  achievements?: string[];
  /** 成就计数器（B7；老钱包没有就按 0 兜底）。 */
  stats?: CoinAchievementStats;
  /** 最近 200 条收支（B7；老钱包没有就是空数组）。 */
  ledger?: CoinLedgerEntry[];
  /** B7 先占位：B8 的破产次数；单机当前恒为 0。 */
  bankruptCount?: number;
  updatedAt: string;
}
