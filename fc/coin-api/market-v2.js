/*
 * 黑塔币 v2 · 共享市场逻辑（纯函数，不碰网络/存储）
 *
 * 价格 = 确定性行情基准价 ×（1 + 当日净买入冲击）
 *   impact = clamp(当日净买入 HTC × 5e-7, -0.20, +0.20)
 *   即每净买入 1 万 HTC 约推动 +0.5%，单日最多 ±20%
 *
 * 交易规则：市价买卖、手续费 0.3%（USDT）、5 秒 1 单、每天买卖各 5 次、单笔 ≤ 10000 HTC
 * 每个交易日（sessionDate）换场时净买入与次数归零。
 *
 * 共享市场账本：
 *   - 首次开户：1000 HTC + 100000 USDT
 *   - 支持一次性「本地钱包合并」（/api/claim，单次、上限 100000 HTC）
 *   - 签到在服务端（/api/signin）：每天 09:30 后可签，连签 10/20/25/.../50
 *
 * 状态结构：
 * {
 *   version: 2,
 *   day: "2026-10-29",
 *   market: { netBuy, buyVol, sellVol, updatedAt },
 *   users: { "昵称": { name, htc, usdt, cost, todayBuy, todaySell, lastTradeAt,
 *                      merged, streak, lastSignDay, updatedAt } }
 * }
 */
'use strict';

const { buildDailyResponse } = require('./coin-core');

const RULES = {
  feeRate: 0.003,
  maxOrder: 10000,
  buyPerDay: 5,
  sellPerDay: 5,
  cooldownMs: 5000,
  impactPerHtc: 5e-7,
  impactCap: 0.2,
  initialHtc: 1000,
  initialUsdt: 100000,
  /** B8：破产重开的起点（不是新账号起点）。 */
  restartUsdt: 10000,
  mergeCapHtc: 100000,
  shortMaxLeverage: 3,
  interestRateDaily: 0.001
};

/** B8：一天毫秒数、挂单有效期、单用户最多挂几单。 */
const DAY_MS = 86400000;
const ORDER_TTL_MS = { '1h': 3600000, '24h': DAY_MS, '3d': 3 * DAY_MS };
const ORDER_TTLS = ['1h', '24h', '3d'];
const MAX_ORDERS_PER_USER = 10;

/** B7：连签从第 7 天起 +5%（与 packages/coin/src/signin.ts 同一口径）。 */
const STREAK_BONUS_FROM = 7;
const STREAK_BONUS_RATE = 0.05;
/** 每个账户最多留多少条收支审计。 */
const LEDGER_MAX = 200;

/**
 * 成就目录（20 条）。与 packages/coin/src/achievements.ts 的 id / target 一一对应；
 * 服务端只存已解锁 id，判定用的是计数器 + 当前资产。
 */
const ACHIEVEMENTS = [
  { id: 'first_signin', target: 1, value: function (s) { return s.signins; } },
  { id: 'signin_10', target: 10, value: function (s) { return s.signins; } },
  { id: 'signin_50', target: 50, value: function (s) { return s.signins; } },
  { id: 'streak_3', target: 3, value: function (s) { return s.maxStreak; } },
  { id: 'streak_7', target: 7, value: function (s) { return s.maxStreak; } },
  { id: 'streak_30', target: 30, value: function (s) { return s.maxStreak; } },
  { id: 'reward_500', target: 500, value: function (s) { return s.totalReward; } },
  { id: 'first_trade', target: 1, value: function (s) { return s.trades; } },
  { id: 'first_buy', target: 1, value: function (s) { return s.buys; } },
  { id: 'first_sell', target: 1, value: function (s) { return s.sells; } },
  { id: 'trade_10', target: 10, value: function (s) { return s.trades; } },
  { id: 'trade_50', target: 50, value: function (s) { return s.trades; } },
  { id: 'volume_10000', target: 10000, value: function (s) { return s.volume; } },
  { id: 'fee_100', target: 100, value: function (s) { return s.fees; } },
  { id: 'networth_250k', target: 250000, value: function (s) { return s.netWorth; } },
  { id: 'htc_2000', target: 2000, value: function (s) { return s.htc; } },
  { id: 'htc_5000', target: 5000, value: function (s) { return s.htc; } },
  { id: 'usdt_200k', target: 200000, value: function (s) { return s.usdt; } },
  { id: 'merged', target: 1, value: function (s) { return s.merged ? 1 : 0; } },
  { id: 'first_bankrupt', target: 1, value: function (s) { return s.bankruptCount; } }
];

function emptyStats() {
  return {
    signins: 0,
    maxStreak: 0,
    totalReward: 0,
    trades: 0,
    buys: 0,
    sells: 0,
    volume: 0,
    fees: 0
  };
}

const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_\-]{1,20}$/;

function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function normalizeName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) throw httpError(400, 'invalid_name', '请填写昵称 / QQ 号');
  if (!NAME_RE.test(name)) {
    throw httpError(400, 'invalid_name', '昵称只能包含中文、字母、数字、下划线、短横线，1~20 字');
  }
  return name;
}

function createState(day) {
  return {
    version: 2,
    day: day,
    market: { netBuy: 0, buyVol: 0, sellVol: 0, updatedAt: 0 },
    /** B8：所有活跃限价单（共享可见，不是订单簿）。 */
    orders: [],
    /** B8：最近一次日结的服务器日期；老状态没有就当晚结过。 */
    lastSettleDay: '',
    users: {}
  };
}

/** B8 老状态兼容：缺 orders / lastSettleDay 时补默认值，不整包失败。 */
function ensureStateDefaults(state) {
  if (!Array.isArray(state.orders)) state.orders = [];
  if (typeof state.lastSettleDay !== 'string') state.lastSettleDay = '';
  if (!state.market || typeof state.market !== 'object') {
    state.market = { netBuy: 0, buyVol: 0, sellVol: 0, updatedAt: 0 };
  }
  if (!state.users || typeof state.users !== 'object') state.users = {};
  return state;
}

function resetIfNewDay(state, day) {
  ensureStateDefaults(state);
  if (state.day === day) return false;
  state.day = day;
  state.market.netBuy = 0;
  state.market.buyVol = 0;
  state.market.sellVol = 0;
  for (const key of Object.keys(state.users)) {
    const u = state.users[key];
    u.todayBuy = 0;
    u.todaySell = 0;
  }
  return true;
}

/** 老数据兼容：B7 新字段读时兜底、写时补全（设计文档「老数据」一条）。 */
function ensureUserDefaults(user) {
  if (!Array.isArray(user.achievements)) user.achievements = [];
  if (!Array.isArray(user.ledger)) user.ledger = [];
  if (!user.stats || typeof user.stats !== 'object') user.stats = emptyStats();
  const defaults = emptyStats();
  for (const key of Object.keys(defaults)) {
    if (!Number.isFinite(user.stats[key])) user.stats[key] = defaults[key];
  }
  if (!Number.isFinite(user.bankruptCount)) user.bankruptCount = 0;
  if (!user.short || typeof user.short !== 'object') {
    user.short = null;
  } else {
    if (!Number.isFinite(user.short.amount)) user.short.amount = 0;
    if (!Number.isFinite(user.short.entryPrice)) user.short.entryPrice = 0;
    if (!Number.isFinite(user.short.notional)) user.short.notional = 0;
    if (!Number.isFinite(user.short.borrowedAt)) user.short.borrowedAt = 0;
    if (!Number.isFinite(user.short.lastInterestAt)) user.short.lastInterestAt = user.short.borrowedAt;
    if (user.short.amount <= 0) user.short = null;
  }
  return user;
}

function ensureUser(state, name, basePrice, nowIso) {
  let user = state.users[name];
  if (user) return { user: ensureUserDefaults(user), created: false };
  user = {
    name: name,
    htc: RULES.initialHtc,
    usdt: RULES.initialUsdt,
    cost: basePrice,
    todayBuy: 0,
    todaySell: 0,
    lastTradeAt: 0,
    merged: false,
    streak: 0,
    lastSignDay: '',
    achievements: [],
    stats: emptyStats(),
    ledger: [],
    bankruptCount: 0,
    short: null,
    updatedAt: nowIso
  };
  state.users[name] = user;
  return { user: user, created: true };
}

/** 当前有效价格（确定性基准价 + 净买入冲击） */
function effectivePrice(daily, state) {
  const basePrice = daily.market.close;
  const impact = clamp(state.market.netBuy * RULES.impactPerHtc, -RULES.impactCap, RULES.impactCap);
  return {
    basePrice: basePrice,
    impact: impact,
    price: basePrice * (1 + impact)
  };
}

/** 服务器时间的日期（YYYY-MM-DD）；日结按它判断，不按场次。 */
function serverYmd(serverTime) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(serverTime || ''));
  return m ? m[1] : '';
}

/**
 * 惰性补息：从 lastInterestAt 起每满 24h 扣一天，零头保留。
 * 返回本次扣掉的利息（信用点），可能把余额扣成负数。
 */
function settleInterest(user, nowMs) {
  ensureUserDefaults(user);
  if (!user.short) return 0;
  const last = Number.isFinite(user.short.lastInterestAt)
    ? user.short.lastInterestAt
    : user.short.borrowedAt;
  if (!Number.isFinite(nowMs) || nowMs <= last) return 0;
  const days = Math.floor((nowMs - last) / DAY_MS);
  if (days <= 0) return 0;
  const interest = round2(days * user.short.notional * RULES.interestRateDaily);
  const nowIso = new Date(nowMs).toISOString();
  if (interest > 0) {
    applyLedger(user, { usdt: -interest }, 'interest', { nowIso: nowIso });
  }
  user.short.lastInterestAt = last + days * DAY_MS;
  user.updatedAt = nowIso;
  return interest;
}

/** 清掉过期挂单；返回清掉的条数。 */
function pruneOrders(state, nowMs) {
  const before = state.orders.length;
  state.orders = state.orders.filter(function (o) {
    return o && Number.isFinite(o.expiresAt) && nowMs < o.expiresAt;
  });
  return before - state.orders.length;
}

/**
 * 日结：每天第一次打开市场时跑一次，补所有用户欠的整天利息 + 清过期挂单。
 * 隔几天才开，settleInterest 会把所有整天一次补齐（判据 lastInterestAt，不是 lastSettleDay）。
 */
function settleDay(state, daily, nowMs) {
  ensureStateDefaults(state);
  const today = serverYmd(daily.serverTime);
  if (!today || state.lastSettleDay === today) return false;
  for (const key of Object.keys(state.users)) {
    settleInterest(state.users[key], nowMs);
  }
  pruneOrders(state, nowMs);
  state.lastSettleDay = today;
  return true;
}

/** 净资产 = 现金 + 持仓市值 − 借入负债。 */
function userValue(user, price) {
  const liability = user.short ? user.short.amount * price : 0;
  return user.htc * price + user.usdt - liability;
}

/** 欠款 = 空头负债 + 负现金。 */
function userDebt(user, price) {
  const shortDebt = user.short ? user.short.amount * price : 0;
  return shortDebt + (user.usdt < 0 ? -user.usdt : 0);
}

function userLeverage(user, price) {
  if (!user.short) return 0;
  const net = userValue(user, price);
  if (net <= 0) return 0;
  return (user.short.amount * price) / net;
}

function buildLeaderboard(state, price, limit) {
  const rows = Object.keys(state.users).map(function (key) {
    const u = state.users[key];
    return { name: u.name, value: round2(userValue(u, price)) };
  });
  rows.sort(function (a, b) { return b.value - a.value; });
  return rows.slice(0, limit || 20).map(function (r, i) {
    return { rank: i + 1, name: r.name, value: r.value };
  });
}

/** 欠款榜：按负债绝对值从大到小；副指标显示 负债 / 净资产。 */
function buildDebtLeaderboard(state, price, limit) {
  const rows = Object.keys(state.users).map(function (key) {
    const u = state.users[key];
    const debt = round2(userDebt(u, price));
    const value = round2(userValue(u, price));
    return {
      name: u.name,
      debt: debt,
      value: value,
      ratio: value === 0 ? 0 : debt / value
    };
  }).filter(function (r) { return r.debt > 0.005; });
  rows.sort(function (a, b) { return b.debt - a.debt; });
  return rows.slice(0, limit || 20).map(function (r, i) {
    return {
      rank: i + 1,
      name: r.name,
      debt: r.debt,
      value: r.value,
      ratio: round2(r.ratio)
    };
  });
}

/* ---------------- 统一记账 / 成就 ---------------- */

/**
 * 统一记账入口（验收：所有收入与支出都走它）。
 * change = { htc, usdt } 的净变动；source 打标；同时维护成就计数器。
 */
function applyLedger(user, change, source, meta) {
  ensureUserDefaults(user);
  const htc = (change && Number(change.htc)) || 0;
  const usdt = (change && Number(change.usdt)) || 0;
  const nowIso = (meta && meta.nowIso) || new Date().toISOString();

  user.htc = round2(user.htc + htc);
  user.usdt = round2(user.usdt + usdt);
  user.ledger = user.ledger.concat({
    at: nowIso,
    source: source,
    htc: round2(htc),
    usdt: round2(usdt)
  }).slice(-LEDGER_MAX);

  const stats = user.stats;
  if (source === 'signin') {
    stats.signins += 1;
    stats.totalReward = round2(stats.totalReward + htc);
    stats.maxStreak = Math.max(stats.maxStreak, Math.floor((meta && meta.streak) || 0));
  } else if (source === 'trade:buy' || source === 'trade:sell' ||
             source === 'trade:short_open' || source === 'trade:short_close') {
    stats.trades += 1;
    if (source === 'trade:buy' || source === 'trade:short_close') stats.buys += 1;
    else stats.sells += 1;
    stats.volume = round2(stats.volume + ((meta && meta.amount) || 0));
    stats.fees = round2(stats.fees + ((meta && meta.fee) || 0));
  }
  return user;
}

function achievementSnapshot(user, price) {
  const stats = user.stats || emptyStats();
  return {
    signins: stats.signins,
    maxStreak: stats.maxStreak,
    totalReward: stats.totalReward,
    trades: stats.trades,
    buys: stats.buys,
    sells: stats.sells,
    volume: stats.volume,
    fees: stats.fees,
    netWorth: userValue(user, price),
    htc: user.htc,
    usdt: user.usdt,
    merged: !!user.merged,
    bankruptCount: user.bankruptCount || 0
  };
}

function unlockedAchievementIds(snapshot) {
  const out = [];
  for (const item of ACHIEVEMENTS) {
    if (item.value(snapshot) >= item.target) out.push(item.id);
  }
  return out;
}

/** 按当前状态判定一次成就；返回新解锁的 id（调用方负责标 dirty / 写回）。 */
function refreshAchievements(user, price) {
  ensureUserDefaults(user);
  const have = new Set(user.achievements);
  const now = unlockedAchievementIds(achievementSnapshot(user, price));
  const added = now.filter(function (id) { return !have.has(id); });
  if (added.length) {
    for (const id of added) have.add(id);
    user.achievements = ACHIEVEMENTS.filter(function (a) { return have.has(a.id); }).map(function (a) { return a.id; });
  }
  return added;
}

/* ---------------- 签到 / 本地钱包合并 ---------------- */

function parseDay(day) {
  const parts = String(day).split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}

function formatDay(d) {
  function p(n) { return n < 10 ? '0' + n : '' + n; }
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

function prevWeekday(day) {
  const d = parseDay(day);
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return formatDay(d);
}

/** 连签**基础**奖励：1→10, 2→20, 3→25 ... 7→45, 8+→50（不含连签加成）。 */
function rewardForStreak(streak) {
  const n = Math.max(1, Math.floor(streak));
  if (n === 1) return 10;
  if (n === 2) return 20;
  return Math.min(50, 20 + (n - 2) * 5);
}

function streakBonusRate(streak) {
  return Math.floor(streak) >= STREAK_BONUS_FROM ? STREAK_BONUS_RATE : 0;
}

/** 实际签到奖励 = 基础 ×（1 + 连签加成），四舍五入到分（与客户端同口径）。 */
function signinReward(streak) {
  const base = rewardForStreak(streak);
  return Math.round(base * (1 + streakBonusRate(streak)) * 100) / 100;
}

function daysToBonus(streak) {
  const n = Math.max(0, Math.floor(streak) || 0);
  return Math.max(0, STREAK_BONUS_FROM - n);
}

function signinInfo(daily, user) {
  const sessionDate = daily.market.sessionDate;
  const signedToday = user.lastSignDay === sessionDate;
  const continued = !!user.lastSignDay && user.lastSignDay === prevWeekday(sessionDate);
  // 断签后对外显示 0，别把旧 streak 继续摆在界面上
  const streak = signedToday || continued ? (user.streak || 0) : 0;
  const nextStreak = streak + 1;
  return {
    streak: streak,
    lastSignDay: user.lastSignDay || '',
    signedToday: signedToday,
    canSign: !signedToday && daily.market.status !== 'preopen' && daily.market.status !== 'weekend',
    nextStreak: nextStreak,
    nextReward: signinReward(nextStreak),
    nextRewardBase: rewardForStreak(nextStreak),
    bonusPct: Math.round(streakBonusRate(nextStreak) * 100),
    daysToBonus: daysToBonus(streak),
    broken: !!user.lastSignDay && !signedToday && !continued
  };
}

/** POST /api/signin：服务端签到（改手机时间无效） */
function signIn(daily, state, rawName, nowMs) {
  const name = normalizeName(rawName);
  if (daily.market.status === 'preopen') {
    throw httpError(400, 'not_open', '09:30 开盘后才能签到');
  }
  if (daily.market.status === 'weekend') {
    throw httpError(400, 'market_closed', '周末休市，无法签到');
  }
  const t = Number.isFinite(nowMs) ? nowMs : Date.now();
  const nowIso = new Date(t).toISOString();
  resetIfNewDay(state, daily.market.sessionDate);
  const ensured = ensureUser(state, name, daily.market.close, nowIso);
  const user = ensured.user;
  settleInterest(user, t);
  if (user.lastSignDay === daily.market.sessionDate) {
    throw httpError(400, 'already_signed', '今天已经签过了，明天再来');
  }
  const continued = !!user.lastSignDay && user.lastSignDay === prevWeekday(daily.market.sessionDate);
  user.streak = continued ? (user.streak || 0) + 1 : 1;
  const reward = signinReward(user.streak);
  applyLedger(user, { htc: reward }, 'signin', {
    nowIso: nowIso,
    streak: user.streak
  });
  user.lastSignDay = daily.market.sessionDate;
  user.updatedAt = nowIso;
  refreshAchievements(user, effectivePrice(daily, state).price);
  return { reward: reward, streak: user.streak, user: user };
}

/** POST /api/claim：把单机钱包的 HTC 一次性并入共享账户 */
function claimLocalWallet(daily, state, rawName, rawAmount, nowMs) {
  const name = normalizeName(rawName);
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0 || amount > RULES.mergeCapHtc) {
    throw httpError(400, 'invalid_amount', '本地余额必须是 0~' + RULES.mergeCapHtc + ' 的整数');
  }
  const t = Number.isFinite(nowMs) ? nowMs : Date.now();
  const nowIso = new Date(t).toISOString();
  resetIfNewDay(state, daily.market.sessionDate);
  const ensured = ensureUser(state, name, daily.market.close, nowIso);
  const user = ensured.user;
  settleInterest(user, t);
  if (user.merged) {
    throw httpError(400, 'already_merged', '本地钱包已经合并过了，不能重复合并');
  }
  applyLedger(user, { htc: amount }, 'claim', { nowIso: nowIso });
  user.merged = true;
  user.updatedAt = nowIso;
  refreshAchievements(user, effectivePrice(daily, state).price);
  return { mergedHtc: amount, user: user };
}

/* ---------------- 对外数据 ---------------- */

function publicUser(user, price) {
  return {
    name: user.name,
    htc: round2(user.htc),
    usdt: round2(user.usdt),
    cost: round2(user.cost),
    todayBuy: user.todayBuy,
    todaySell: user.todaySell,
    lastTradeAt: user.lastTradeAt,
    merged: !!user.merged,
    streak: user.streak || 0,
    lastSignDay: user.lastSignDay || '',
    value: round2(userValue(user, price)),
    achievements: (user.achievements || []).slice(),
    achievementStats: Object.assign(emptyStats(), user.stats || {}),
    bankruptCount: user.bankruptCount || 0,
    short: user.short ? {
      amount: round2(user.short.amount),
      entryPrice: round2(user.short.entryPrice),
      notional: round2(user.short.notional),
      borrowedAt: user.short.borrowedAt,
      lastInterestAt: user.short.lastInterestAt
    } : null,
    debt: round2(userDebt(user, price)),
    leverage: round2(userLeverage(user, price)),
    canRestart: userValue(user, price) < 0
  };
}

/**
 * GET /api/state 用的数据整理。
 * 会建账号 / 重置场次（调用方负责把 state 写回）。
 * 返回 { payload, user, price, dirty }
 */
function publicOrder(order) {
  return {
    id: order.id,
    user: order.user,
    side: order.side,
    amount: round2(order.amount),
    limitPrice: round2(order.limitPrice),
    ttl: order.ttl,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt
  };
}

function buildStatePayload(daily, state, name, nowMs) {
  ensureStateDefaults(state);
  const day = daily.market.sessionDate;
  const t = Number.isFinite(nowMs) ? nowMs : Date.now();
  const nowIso = new Date(t).toISOString();
  let dirty = false;

  if (settleDay(state, daily, t)) dirty = true;
  if (pruneOrders(state, t) > 0) dirty = true;
  if (resetIfNewDay(state, day)) dirty = true;

  const priceInfo = effectivePrice(daily, state);
  const ensured = ensureUser(state, name, priceInfo.basePrice, nowIso);
  if (ensured.created) dirty = true;

  const user = ensured.user;
  if (settleInterest(user, t) > 0) dirty = true;
  const prevClose = daily.market.prevClose;
  const price = priceInfo.price;
  const changePct = (price / prevClose - 1) * 100;

  // 持仓/资产会随行情变化：每次出 state 都判一次成就，解锁了就标 dirty 落库
  const unlocked = refreshAchievements(user, price);
  if (unlocked.length) dirty = true;

  const payload = {
    version: 2,
    serverTime: daily.serverTime,
    market: {
      sessionDate: day,
      sessionNumber: daily.market.sessionNumber,
      status: daily.market.status,
      statusLabel: daily.market.statusLabel,
      prevClose: round2(prevClose),
      open: round2(daily.market.open),
      high: round2(daily.market.high),
      low: round2(daily.market.low),
      basePrice: round2(priceInfo.basePrice),
      price: round2(price),
      changePct: round2(changePct),
      impactPct: round2(priceInfo.impact * 100),
      netBuy: round2(state.market.netBuy),
      volume: round2(daily.market.volume)
    },
    user: publicUser(user, price),
    limits: {
      feeRate: RULES.feeRate,
      maxOrder: RULES.maxOrder,
      buyPerDay: RULES.buyPerDay,
      sellPerDay: RULES.sellPerDay,
      cooldownMs: RULES.cooldownMs,
      mergeCapHtc: RULES.mergeCapHtc,
      shortMaxLeverage: RULES.shortMaxLeverage,
      interestRateDaily: RULES.interestRateDaily,
      restartUsdt: RULES.restartUsdt,
      orderTtls: ORDER_TTLS.slice()
    },
    leaderboard: buildLeaderboard(state, price, 20),
    debtLeaderboard: buildDebtLeaderboard(state, price, 20),
    orders: state.orders.map(publicOrder),
    lastSettleDay: state.lastSettleDay || ''
  };
  payload.user.signin = signinInfo(daily, user);

  return { payload: payload, user: user, price: price, dirty: dirty };
}

/* ---------------- B8：挂单 / 空头 / 日结 / 重开 ---------------- */

function assertTrading(daily) {
  if (daily.market.status !== 'trading') {
    throw httpError(400, 'market_closed', '当前休市，无法交易（工作日 09:30–11:30 / 13:00–15:00 可交易）');
  }
}

function parseAmount(raw) {
  const amount = Number(raw);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    throw httpError(400, 'invalid_amount', '数量必须是正整数');
  }
  if (amount > RULES.maxOrder) {
    throw httpError(400, 'amount_too_large', '单笔最多 ' + RULES.maxOrder + ' HTC');
  }
  return amount;
}

function checkCooldown(user, nowMs) {
  if (user.lastTradeAt && nowMs - user.lastTradeAt < RULES.cooldownMs) {
    throw httpError(429, 'cooldown', '慢一点，' + Math.ceil((RULES.cooldownMs - (nowMs - user.lastTradeAt)) / 1000) + ' 秒后再试');
  }
}

function checkDaily(user, side) {
  if (side === 'buy' && user.todayBuy >= RULES.buyPerDay) {
    throw httpError(429, 'buy_limit', '今天已经买满 ' + RULES.buyPerDay + ' 次了，明天再来');
  }
  if (side === 'sell' && user.todaySell >= RULES.sellPerDay) {
    throw httpError(429, 'sell_limit', '今天已经卖满 ' + RULES.sellPerDay + ' 次了，明天再来');
  }
}

function marketInfo(daily, state) {
  const p = effectivePrice(daily, state);
  return {
    price: round2(p.price),
    changePct: round2((p.price / daily.market.prevClose - 1) * 100),
    netBuy: round2(state.market.netBuy)
  };
}

/** 条件单触发：买入看市价 <= 限价，卖出看市价 >= 限价。 */
function orderTriggered(side, limitPrice, price) {
  return side === 'buy' ? price <= limitPrice : price >= limitPrice;
}

/**
 * 市价买卖内部实现。opts.skipCooldown 给条件单成交用（成交时才计数，但系统撮合不等 5 秒）。
 * opts.orderId 只用于回执，方便界面说清是哪张挂单成交了。
 */
function doMarket(daily, state, user, side, amount, nowMs, opts) {
  opts = opts || {};
  const nowIso = new Date(nowMs).toISOString();
  settleInterest(user, nowMs);

  const priceInfo = effectivePrice(daily, state);
  const price = priceInfo.price;

  if (!opts.skipCooldown) checkCooldown(user, nowMs);
  checkDaily(user, side);

  if (side === 'buy') {
    // 护栏②：净资产为负只能平仓/还债，不能再开新多头
    if (userValue(user, price) <= 0) {
      throw httpError(400, 'negative_equity', '净资产已为负，只能平仓，不能开新仓');
    }
    const cost = amount * price * (1 + RULES.feeRate);
    if (user.usdt + 1e-9 < cost) {
      throw httpError(400, 'insufficient_usdt', '信用点不足（需要 ' + round2(cost) + '）');
    }
  }

  let fee;
  if (side === 'buy') {
    fee = amount * price * RULES.feeRate;
    const newHtc = user.htc + amount;
    user.cost = (user.htc * user.cost + amount * price) / newHtc;
    applyLedger(user, { htc: amount, usdt: -(amount * price + fee) }, 'trade:buy', {
      nowIso: nowIso,
      amount: amount,
      fee: fee,
      orderId: opts.orderId || ''
    });
    user.todayBuy += 1;
    state.market.netBuy += amount;
    state.market.buyVol += amount;
  } else {
    if (user.htc + 1e-9 < amount) {
      throw httpError(400, 'insufficient_htc', 'HTC 不足（持有 ' + round2(user.htc) + '）');
    }
    const gross = amount * price;
    fee = gross * RULES.feeRate;
    applyLedger(user, { htc: -amount, usdt: gross - fee }, 'trade:sell', {
      nowIso: nowIso,
      amount: amount,
      fee: fee,
      orderId: opts.orderId || ''
    });
    user.todaySell += 1;
    state.market.netBuy -= amount;
    state.market.sellVol += amount;
  }

  user.lastTradeAt = nowMs;
  user.updatedAt = nowIso;
  state.market.updatedAt = nowMs;

  const after = effectivePrice(daily, state);
  refreshAchievements(user, after.price);
  return {
    trade: {
      side: side,
      amount: amount,
      price: round2(price),
      fee: round2(fee),
      feeRate: RULES.feeRate,
      priceAfter: round2(after.price),
      impactPct: round2(after.impact * 100),
      orderId: opts.orderId || ''
    },
    user: user
  };
}

function marketAction(daily, state, rawName, body, nowMs) {
  const name = normalizeName(rawName);
  const side = String((body && body.side) || '').toLowerCase();
  if (side !== 'buy' && side !== 'sell') {
    throw httpError(400, 'invalid_side', 'side 只能是 buy 或 sell');
  }
  const amount = parseAmount(body && body.amount);
  assertTrading(daily);

  const nowIso = new Date(nowMs).toISOString();
  resetIfNewDay(state, daily.market.sessionDate);
  const priceInfo = effectivePrice(daily, state);
  const ensured = ensureUser(state, name, priceInfo.basePrice, nowIso);
  const user = ensured.user;

  const out = doMarket(daily, state, user, side, amount, nowMs, {});
  const fills = matchOrders(daily, state, nowMs);
  const p = effectivePrice(daily, state);
  refreshAchievements(user, p.price);
  return {
    kind: 'trade',
    trade: out.trade,
    fills: fills,
    user: publicUser(user, p.price),
    market: marketInfo(daily, state)
  };
}

/** 挂限价单：条件单，不是订单簿；下单只做一次顺手撮合。 */
function limitAction(daily, state, rawName, body, nowMs) {
  const name = normalizeName(rawName);
  const side = String((body && body.side) || '').toLowerCase();
  if (side !== 'buy' && side !== 'sell') {
    throw httpError(400, 'invalid_side', 'side 只能是 buy 或 sell');
  }
  const amount = parseAmount(body && body.amount);
  const limitPrice = round2(Number(body && body.limitPrice));
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
    throw httpError(400, 'invalid_price', '限价必须是正数');
  }
  const ttl = String((body && body.ttl) || '24h');
  if (!ORDER_TTLS.includes(ttl)) {
    throw httpError(400, 'invalid_ttl', '有效期只能是 1h / 24h / 3d');
  }
  assertTrading(daily);

  const nowIso = new Date(nowMs).toISOString();
  resetIfNewDay(state, daily.market.sessionDate);
  const priceInfo = effectivePrice(daily, state);
  const ensured = ensureUser(state, name, priceInfo.basePrice, nowIso);
  const user = ensured.user;
  settleInterest(user, nowMs);
  const price = priceInfo.price;

  if (side === 'buy') {
    if (userValue(user, price) <= 0) {
      throw httpError(400, 'negative_equity', '净资产已为负，只能平仓，不能挂买单');
    }
    const reserve = amount * limitPrice * (1 + RULES.feeRate);
    if (user.usdt + 1e-9 < reserve) {
      throw httpError(400, 'insufficient_usdt', '信用点不足（按限价需 ' + round2(reserve) + '）');
    }
  } else if (user.htc + 1e-9 < amount) {
    throw httpError(400, 'insufficient_htc', 'HTC 不足（持有 ' + round2(user.htc) + '）');
  }

  const mine = state.orders.filter(function (o) { return o.user === name; }).length;
  if (mine >= MAX_ORDERS_PER_USER) {
    throw httpError(400, 'too_many_orders', '一个人最多同时挂 ' + MAX_ORDERS_PER_USER + ' 单');
  }

  const order = {
    id: 'o' + nowMs.toString(36) + '-' + state.orders.length.toString(36) + '-' + Math.random().toString(36).slice(2, 7),
    user: name,
    side: side,
    amount: amount,
    limitPrice: limitPrice,
    ttl: ttl,
    createdAt: nowIso,
    expiresAt: nowMs + ORDER_TTL_MS[ttl]
  };
  state.orders.push(order);
  user.updatedAt = nowIso;

  const fills = matchOrders(daily, state, nowMs);
  const p = effectivePrice(daily, state);
  refreshAchievements(user, p.price);
  return {
    kind: 'order',
    order: publicOrder(order),
    orderActive: state.orders.some(function (o) { return o.id === order.id; }),
    fills: fills,
    user: publicUser(user, p.price),
    market: marketInfo(daily, state)
  };
}

/** 开空：借 HTC 按市价卖出，现金增加，负债记在 short.amount。 */
function openShortAction(daily, state, rawName, body, nowMs) {
  const name = normalizeName(rawName);
  const amount = parseAmount(body && body.amount);
  assertTrading(daily);
  const nowIso = new Date(nowMs).toISOString();
  resetIfNewDay(state, daily.market.sessionDate);
  const priceInfo = effectivePrice(daily, state);
  const ensured = ensureUser(state, name, priceInfo.basePrice, nowIso);
  const user = ensured.user;
  settleInterest(user, nowMs);
  checkCooldown(user, nowMs);
  checkDaily(user, 'sell');

  const price = priceInfo.price;
  const net = userValue(user, price);
  if (net <= 0) {
    throw httpError(400, 'negative_equity', '净资产已为负，只能平仓，不能开新仓');
  }
  if (user.short) {
    throw httpError(400, 'already_short', '已有空头仓位，先平掉再开新仓');
  }
  const notional = amount * price;
  const maxNotional = net * RULES.shortMaxLeverage;
  if (notional > maxNotional + 1e-9) {
    throw httpError(400, 'leverage_cap',
      '开仓上限 = 净资产 × ' + RULES.shortMaxLeverage + '（最多 ' + round2(maxNotional) + ' 信用点名义）');
  }

  const fee = notional * RULES.feeRate;
  applyLedger(user, { usdt: notional - fee }, 'trade:short_open', {
    nowIso: nowIso,
    amount: amount,
    fee: fee
  });
  user.short = {
    amount: amount,
    entryPrice: price,
    notional: notional,
    borrowedAt: nowMs,
    lastInterestAt: nowMs
  };
  user.todaySell += 1;
  user.lastTradeAt = nowMs;
  user.updatedAt = nowIso;
  state.market.netBuy -= amount;
  state.market.sellVol += amount;
  state.market.updatedAt = nowMs;

  const after = effectivePrice(daily, state);
  refreshAchievements(user, after.price);
  const fills = matchOrders(daily, state, nowMs);
  const p = effectivePrice(daily, state);
  refreshAchievements(user, p.price);
  return {
    kind: 'short_open',
    trade: {
      side: 'short_open',
      amount: amount,
      price: round2(price),
      fee: round2(fee),
      feeRate: RULES.feeRate,
      notional: round2(notional),
      priceAfter: round2(after.price),
      impactPct: round2(after.impact * 100)
    },
    fills: fills,
    user: publicUser(user, p.price),
    market: marketInfo(daily, state)
  };
}

/** 平空：按市价买回 HTC，信用点减少；允许扣成负数。 */
function closeShortAction(daily, state, rawName, body, nowMs) {
  const name = normalizeName(rawName);
  assertTrading(daily);
  const nowIso = new Date(nowMs).toISOString();
  resetIfNewDay(state, daily.market.sessionDate);
  const priceInfo = effectivePrice(daily, state);
  const ensured = ensureUser(state, name, priceInfo.basePrice, nowIso);
  const user = ensured.user;
  settleInterest(user, nowMs);
  if (!user.short) {
    throw httpError(400, 'no_short', '当前没有空头仓位');
  }
  const amount = body && body.amount != null ? parseAmount(body.amount) : user.short.amount;
  if (amount > user.short.amount + 1e-9) {
    throw httpError(400, 'amount_too_large', '平空数量不能超过空头仓位 ' + round2(user.short.amount) + ' HTC');
  }
  checkCooldown(user, nowMs);
  checkDaily(user, 'buy');

  const price = priceInfo.price;
  const gross = amount * price;
  const fee = gross * RULES.feeRate;
  applyLedger(user, { usdt: -(gross + fee) }, 'trade:short_close', {
    nowIso: nowIso,
    amount: amount,
    fee: fee
  });

  const remaining = user.short.amount - amount;
  if (remaining <= 1e-9) {
    user.short = null;
  } else {
    user.short = {
      amount: remaining,
      entryPrice: user.short.entryPrice,
      notional: round2(user.short.notional * (remaining / user.short.amount)),
      borrowedAt: user.short.borrowedAt,
      lastInterestAt: user.short.lastInterestAt
    };
  }
  user.todayBuy += 1;
  user.lastTradeAt = nowMs;
  user.updatedAt = nowIso;
  state.market.netBuy += amount;
  state.market.buyVol += amount;
  state.market.updatedAt = nowMs;

  const after = effectivePrice(daily, state);
  refreshAchievements(user, after.price);
  const fills = matchOrders(daily, state, nowMs);
  const p = effectivePrice(daily, state);
  refreshAchievements(user, p.price);
  return {
    kind: 'short_close',
    trade: {
      side: 'short_close',
      amount: amount,
      price: round2(price),
      fee: round2(fee),
      feeRate: RULES.feeRate,
      priceAfter: round2(after.price),
      impactPct: round2(after.impact * 100)
    },
    fills: fills,
    user: publicUser(user, p.price),
    market: marketInfo(daily, state)
  };
}

/** 主动重开：清仓、撤挂单、重置 1000 HTC / 10000 信用点，破产次数 +1。 */
function restartAction(daily, state, rawName, nowMs) {
  const name = normalizeName(rawName);
  const nowIso = new Date(nowMs).toISOString();
  resetIfNewDay(state, daily.market.sessionDate);
  const priceInfo = effectivePrice(daily, state);
  const ensured = ensureUser(state, name, priceInfo.basePrice, nowIso);
  const user = ensured.user;
  settleInterest(user, nowMs);
  const price = priceInfo.price;
  const net = userValue(user, price);
  if (net >= 0) {
    throw httpError(400, 'not_bankrupt', '净资产还没为负，不能重开');
  }

  state.orders = state.orders.filter(function (o) { return o.user !== name; });
  const deltaHtc = RULES.initialHtc - user.htc;
  const deltaUsdt = RULES.restartUsdt - user.usdt;
  applyLedger(user, { htc: deltaHtc, usdt: deltaUsdt }, 'restart', { nowIso: nowIso });
  user.short = null;
  user.cost = price;
  user.bankruptCount = (user.bankruptCount || 0) + 1;
  // 连签归零，但保留 lastSignDay：今天已经签过就不能靠重开再签一次
  user.streak = 0;
  user.todayBuy = 0;
  user.todaySell = 0;
  user.lastTradeAt = 0;
  user.updatedAt = nowIso;
  refreshAchievements(user, price);

  return {
    kind: 'restart',
    user: publicUser(user, price),
    market: marketInfo(daily, state),
    bankruptCount: user.bankruptCount
  };
}

/**
 * 只在“有人下单/成交”的请求里顺手撮合；没有定时扫盘。
 * 一次请求按创建时间顺序尝试，成交会改价，后面的单按新价重新判断。
 */
function matchOrders(daily, state, nowMs) {
  pruneOrders(state, nowMs);
  const snapshot = state.orders.slice().sort(function (a, b) {
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
  const fills = [];
  for (const order of snapshot) {
    if (!state.orders.some(function (o) { return o.id === order.id; })) continue;
    if (nowMs >= order.expiresAt) {
      state.orders = state.orders.filter(function (o) { return o.id !== order.id; });
      continue;
    }
    const price = effectivePrice(daily, state).price;
    if (!orderTriggered(order.side, order.limitPrice, price)) continue;
    const user = state.users[order.user];
    if (!user) {
      state.orders = state.orders.filter(function (o) { return o.id !== order.id; });
      continue;
    }
    try {
      const out = doMarket(daily, state, user, order.side, order.amount, nowMs, {
        skipCooldown: true,
        orderId: order.id
      });
      state.orders = state.orders.filter(function (o) { return o.id !== order.id; });
      fills.push(out.trade);
    } catch (e) {
      // 余额/次数/负净资产挡住就先留着，等过期或用户补足；
      // 不做定时重试，下一次有人下单时还会再试。
    }
  }
  return fills;
}

/** POST /api/trade 的统一入口：action = market | limit | open_short | close_short | restart。 */
function executeAction(daily, state, rawName, body, nowMs) {
  ensureStateDefaults(state);
  const b = body || {};
  const action = String(b.action || 'market').toLowerCase();
  if (action === 'market') return marketAction(daily, state, rawName, b, nowMs);
  if (action === 'limit') return limitAction(daily, state, rawName, b, nowMs);
  if (action === 'open_short' || action === 'short_open') return openShortAction(daily, state, rawName, b, nowMs);
  if (action === 'close_short' || action === 'short_close') return closeShortAction(daily, state, rawName, b, nowMs);
  if (action === 'restart') return restartAction(daily, state, rawName, nowMs);
  throw httpError(400, 'invalid_action', 'action 只能是 market / limit / open_short / close_short / restart');
}

/** 兼容 B7 的直接调用：executeTrade(... 'buy' ...) 等价于 market action。 */
function executeTrade(daily, state, rawName, side, rawAmount, nowMs) {
  return executeAction(daily, state, rawName, { action: 'market', side: side, amount: rawAmount }, nowMs);
}

module.exports = {
  RULES: RULES,
  normalizeName: normalizeName,
  createState: createState,
  buildStatePayload: buildStatePayload,
  executeTrade: executeTrade,
  executeAction: executeAction,
  effectivePrice: effectivePrice,
  buildLeaderboard: buildLeaderboard,
  buildDebtLeaderboard: buildDebtLeaderboard,
  settleInterest: settleInterest,
  settleDay: settleDay,
  userValue: userValue,
  userDebt: userDebt,
  signIn: signIn,
  claimLocalWallet: claimLocalWallet,
  signinInfo: signinInfo,
  rewardForStreak: rewardForStreak,
  signinReward: signinReward,
  daysToBonus: daysToBonus,
  applyLedger: applyLedger,
  refreshAchievements: refreshAchievements,
  ACHIEVEMENTS: ACHIEVEMENTS,
  publicUser: publicUser
};