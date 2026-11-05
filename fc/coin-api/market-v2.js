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
  mergeCapHtc: 100000
};

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
    users: {}
  };
}

function resetIfNewDay(state, day) {
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

function userValue(user, price) {
  return user.htc * price + user.usdt;
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
  } else if (source === 'trade:buy' || source === 'trade:sell') {
    stats.trades += 1;
    if (source === 'trade:buy') stats.buys += 1;
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
    netWorth: user.htc * price + user.usdt,
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
  const nowIso = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
  resetIfNewDay(state, daily.market.sessionDate);
  const ensured = ensureUser(state, name, daily.market.close, nowIso);
  const user = ensured.user;
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
  const nowIso = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
  resetIfNewDay(state, daily.market.sessionDate);
  const ensured = ensureUser(state, name, daily.market.close, nowIso);
  const user = ensured.user;
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
    bankruptCount: user.bankruptCount || 0
  };
}

/**
 * GET /api/state 用的数据整理。
 * 会建账号 / 重置场次（调用方负责把 state 写回）。
 * 返回 { payload, user, price, dirty }
 */
function buildStatePayload(daily, state, name, nowMs) {
  const day = daily.market.sessionDate;
  const nowIso = new Date(nowMs).toISOString();
  let dirty = false;

  if (resetIfNewDay(state, day)) dirty = true;

  const priceInfo = effectivePrice(daily, state);
  const ensured = ensureUser(state, name, priceInfo.basePrice, nowIso);
  if (ensured.created) dirty = true;

  const user = ensured.user;
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
      mergeCapHtc: RULES.mergeCapHtc
    },
    leaderboard: buildLeaderboard(state, price, 20)
  };
  payload.user.signin = signinInfo(daily, user);

  return { payload: payload, user: user, price: price, dirty: dirty };
}

/**
 * POST /api/trade 的纯逻辑。调用方负责加锁、读状态、把 state 写回。
 * 返回 { trade, user, market }，失败抛 httpError。
 */
function executeTrade(daily, state, rawName, side, rawAmount, nowMs) {
  const name = normalizeName(rawName);
  const tSide = String(side || '').toLowerCase();
  if (tSide !== 'buy' && tSide !== 'sell') {
    throw httpError(400, 'invalid_side', 'side 只能是 buy 或 sell');
  }
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    throw httpError(400, 'invalid_amount', '数量必须是正整数');
  }
  if (amount > RULES.maxOrder) {
    throw httpError(400, 'amount_too_large', '单笔最多 ' + RULES.maxOrder + ' HTC');
  }
  if (daily.market.status !== 'trading') {
    throw httpError(400, 'market_closed', '当前休市，无法交易（工作日 09:30–11:30 / 13:00–15:00 可交易）');
  }

  const day = daily.market.sessionDate;
  const nowIso = new Date(nowMs).toISOString();
  resetIfNewDay(state, day);
  const priceInfo = effectivePrice(daily, state);
  const price = priceInfo.price;
  const ensured = ensureUser(state, name, priceInfo.basePrice, nowIso);
  const user = ensured.user;

  // 频率与次数
  if (user.lastTradeAt && nowMs - user.lastTradeAt < RULES.cooldownMs) {
    throw httpError(429, 'cooldown', '慢一点，' + Math.ceil((RULES.cooldownMs - (nowMs - user.lastTradeAt)) / 1000) + ' 秒后再试');
  }
  if (tSide === 'buy' && user.todayBuy >= RULES.buyPerDay) {
    throw httpError(429, 'buy_limit', '今天已经买满 ' + RULES.buyPerDay + ' 次了，明天再来');
  }
  if (tSide === 'sell' && user.todaySell >= RULES.sellPerDay) {
    throw httpError(429, 'sell_limit', '今天已经卖满 ' + RULES.sellPerDay + ' 次了，明天再来');
  }

  let fee;
  if (tSide === 'buy') {
    const cost = amount * price * (1 + RULES.feeRate);
    if (user.usdt + 1e-9 < cost) {
      throw httpError(400, 'insufficient_usdt', '信用点不足（需要 ' + round2(cost) + '）');
    }
    fee = amount * price * RULES.feeRate;
    const newHtc = user.htc + amount;
    user.cost = (user.htc * user.cost + amount * price) / newHtc;
    applyLedger(user, { htc: amount, usdt: -(amount * price + fee) }, 'trade:buy', {
      nowIso: nowIso,
      amount: amount,
      fee: fee
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
      fee: fee
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
      side: tSide,
      amount: amount,
      price: round2(price),
      fee: round2(fee),
      feeRate: RULES.feeRate,
      priceAfter: round2(after.price),
      impactPct: round2(after.impact * 100)
    },
    user: publicUser(user, after.price),
    market: {
      price: round2(after.price),
      changePct: round2((after.price / daily.market.prevClose - 1) * 100),
      netBuy: round2(state.market.netBuy)
    }
  };
}

module.exports = {
  RULES: RULES,
  normalizeName: normalizeName,
  createState: createState,
  buildStatePayload: buildStatePayload,
  executeTrade: executeTrade,
  effectivePrice: effectivePrice,
  buildLeaderboard: buildLeaderboard,
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
