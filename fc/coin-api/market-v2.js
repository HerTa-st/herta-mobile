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

function ensureUser(state, name, basePrice, nowIso) {
  let user = state.users[name];
  if (user) return { user: user, created: false };
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

/** 连签奖励：1→10, 2→20, 3→25 ... 7→45, 8+→50 */
function rewardForStreak(streak) {
  const n = Math.max(1, Math.floor(streak));
  if (n === 1) return 10;
  if (n === 2) return 20;
  return Math.min(50, 20 + (n - 2) * 5);
}

function signinInfo(daily, user) {
  const sessionDate = daily.market.sessionDate;
  const signedToday = user.lastSignDay === sessionDate;
  const continued = !!user.lastSignDay && user.lastSignDay === prevWeekday(sessionDate);
  const nextStreak = signedToday ? (user.streak || 0) + 1 : (continued ? (user.streak || 0) + 1 : 1);
  return {
    streak: user.streak || 0,
    lastSignDay: user.lastSignDay || '',
    signedToday: signedToday,
    canSign: !signedToday && daily.market.status !== 'preopen' && daily.market.status !== 'weekend',
    nextStreak: nextStreak,
    nextReward: rewardForStreak(nextStreak)
  };
}

/** POST /api/signin：服务端签到（改手机时间无效） */
function signIn(daily, state, rawName) {
  const name = normalizeName(rawName);
  if (daily.market.status === 'preopen') {
    throw httpError(400, 'not_open', '09:30 开盘后才能签到');
  }
  if (daily.market.status === 'weekend') {
    throw httpError(400, 'market_closed', '周末休市，无法签到');
  }
  resetIfNewDay(state, daily.market.sessionDate);
  const ensured = ensureUser(state, name, daily.market.close, new Date().toISOString());
  const user = ensured.user;
  if (user.lastSignDay === daily.market.sessionDate) {
    throw httpError(400, 'already_signed', '今天已经签过了，明天再来');
  }
  const continued = !!user.lastSignDay && user.lastSignDay === prevWeekday(daily.market.sessionDate);
  user.streak = continued ? (user.streak || 0) + 1 : 1;
  const reward = rewardForStreak(user.streak);
  user.htc += reward;
  user.lastSignDay = daily.market.sessionDate;
  user.updatedAt = new Date().toISOString();
  return { reward: reward, streak: user.streak, user: user };
}

/** POST /api/claim：把单机钱包的 HTC 一次性并入共享账户 */
function claimLocalWallet(daily, state, rawName, rawAmount) {
  const name = normalizeName(rawName);
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0 || amount > RULES.mergeCapHtc) {
    throw httpError(400, 'invalid_amount', '本地余额必须是 0~' + RULES.mergeCapHtc + ' 的整数');
  }
  resetIfNewDay(state, daily.market.sessionDate);
  const ensured = ensureUser(state, name, daily.market.close, new Date().toISOString());
  const user = ensured.user;
  if (user.merged) {
    throw httpError(400, 'already_merged', '本地钱包已经合并过了，不能重复合并');
  }
  user.htc += amount;
  user.merged = true;
  user.updatedAt = new Date().toISOString();
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
    value: round2(userValue(user, price))
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
      throw httpError(400, 'insufficient_usdt', 'USDT 不足（需要 ' + round2(cost) + '）');
    }
    fee = amount * price * RULES.feeRate;
    user.usdt -= amount * price + fee;
    const newHtc = user.htc + amount;
    user.cost = (user.htc * user.cost + amount * price) / newHtc;
    user.htc = newHtc;
    user.todayBuy += 1;
    state.market.netBuy += amount;
    state.market.buyVol += amount;
  } else {
    if (user.htc + 1e-9 < amount) {
      throw httpError(400, 'insufficient_htc', 'HTC 不足（持有 ' + round2(user.htc) + '）');
    }
    const gross = amount * price;
    fee = gross * RULES.feeRate;
    user.htc -= amount;
    user.usdt += gross - fee;
    user.todaySell += 1;
    state.market.netBuy -= amount;
    state.market.sellVol += amount;
  }

  user.lastTradeAt = nowMs;
  user.updatedAt = nowIso;
  state.market.updatedAt = nowMs;

  const after = effectivePrice(daily, state);
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
  publicUser: publicUser
};
