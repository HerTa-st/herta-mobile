import test from "node:test";
import assert from "node:assert/strict";

import { createRequire } from "node:module";
import {
  ACHIEVEMENTS,
  COIN_API_VERSION,
  TOTAL_BARS,
  INITIAL_HOLDINGS,
  SIGNIN_OPEN_MINUTE,
  achievementProgress,
  applyLedger,
  applySignin,
  coinApiUrl,
  createWallet,
  daysToStreakBonus,
  emptyAchievementStats,
  fetchCoinDaily,
  formatAmount,
  formatHtc,
  formatPct,
  formatPrice,
  isTradingDay,
  marketValue,
  mergeAchievementIds,
  nextTradingDay,
  parseCoinDaily,
  rewardForStreak,
  signinCheck,
  signinReward,
  snapshotFromWallet,
  todayPnl,
  todayPnlPct,
  unlockedAchievementIds,
} from "../src/index.ts";

/* ------------------------------------------------------------- 测试数据 */

function bar(t, o, c, extra = {}) {
  return { t, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1000, ...extra };
}

function market(over = {}) {
  return {
    name: "黑塔币",
    code: "HTC",
    pair: "HTC/USDT",
    sessionDate: "2026-10-29",
    sessionNumber: 214,
    status: "trading",
    statusLabel: "交易中 · 上午",
    prevClose: 88.98,
    open: 89.03,
    high: 90.03,
    low: 88.42,
    close: 89.87,
    changePct: 1.002,
    volume: 77000,
    turnover: 6871800,
    revealed: 2,
    partial: 0.5,
    keyFingerprint: "4CDBB70C",
    bars: [bar(0, 88.99, 89.04), bar(45, 89.04, 89.02, { partial: true })],
    ...over,
  };
}

function dailyJson(serverTime = "2026-10-29T10:15:30+08:00", marketOver = {}, rootOver = {}) {
  return JSON.stringify({ version: 1, serverTime, market: market(marketOver), ...rootOver });
}

function wallet(over = {}) {
  return {
    version: 1,
    holdings: 1000,
    costPrice: 89.03,
    initialAt: "2026-10-29T10:15:30+08:00",
    lastSign: null,
    history: [],
    updatedAt: "2026-10-29T10:15:30+08:00",
    ...over,
  };
}

function signed(date, streak, over = {}) {
  return wallet({
    lastSign: { date, streak, price: 89.87, reward: rewardForStreak(streak) },
    ...over,
  });
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function localYmd(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

/** 本地时区某天中午的时间戳：用来把 mock 时钟钉在一个确定的本地日期。 */
function localNoonMs(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).getTime();
}

/** 从某个日期起找第一个工作日（只用于挑测试日，跟进程时区无关）。 */
function firstWeekday(ymd) {
  let cur = ymd;
  for (let i = 0; i < 14; i++) {
    if (isTradingDay(cur)) return cur;
    cur = nextTradingDay(cur);
  }
  throw new Error("找不到工作日：" + ymd);
}

/* --------------------------------------------------------------- 常量 */

test("契约常量", () => {
  assert.equal(COIN_API_VERSION, 1);
  assert.equal(TOTAL_BARS, 240);
  assert.equal(SIGNIN_OPEN_MINUTE, 570);
  assert.equal(INITIAL_HOLDINGS, 1000);
});

/* --------------------------------------------------------- 连签曲线 */

test("连签奖励曲线 1~9 天 = 10/20/25/30/35/40/45/50/50", () => {
  const got = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => rewardForStreak(n));
  assert.deepEqual(got, [10, 20, 25, 30, 35, 40, 45, 50, 50]);
});

test("rewardForStreak 边界：0/负数按第 1 天，超长封顶 50", () => {
  assert.equal(rewardForStreak(0), 10);
  assert.equal(rewardForStreak(-3), 10);
  assert.equal(rewardForStreak(8), 50);
  assert.equal(rewardForStreak(99), 50);
});

test("连签加成：第 7 天起实际奖励 ×1.05，四舍五入到分", () => {
  const got = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => signinReward(n));
  assert.deepEqual(got, [10, 20, 25, 30, 35, 40, 47.25, 52.5, 52.5]);
  assert.equal(daysToStreakBonus(0), 7);
  assert.equal(daysToStreakBonus(6), 1);
  assert.equal(daysToStreakBonus(7), 0);
  assert.equal(daysToStreakBonus(99), 0);
});

test("签到卡：连签 6 天，下一次第 7 天 +5%", () => {
  const w = signed("2026-11-04", 6); // 周三已签、连签 6
  const check = signinCheck({
    wallet: w,
    sessionDate: "2026-11-05",
    serverTime: "2026-11-05T10:00:00+08:00", // 周四
  });
  assert.equal(check.canSign, true);
  assert.equal(check.currentStreak, 6);
  assert.equal(check.nextStreak, 7);
  assert.equal(check.rewardBase, 45);
  assert.equal(check.reward, 47.25);
  assert.equal(check.bonusPct, 5);
  assert.equal(check.daysToBonus, 1);
  assert.ok(check.message.includes("+47.25 HTC"));
  assert.ok(check.message.includes("连签 +5%"));
});

test("断签：连续天数归零、broken 标记，奖励回到第 1 天", () => {
  const w = signed("2026-10-28", 4); // 周三签过，周四周五断档
  const check = signinCheck({
    wallet: w,
    sessionDate: "2026-10-30",
    serverTime: "2026-10-30T10:15:30+08:00",
  });
  assert.equal(check.canSign, true);
  assert.equal(check.currentStreak, 0);
  assert.equal(check.nextStreak, 1);
  assert.equal(check.reward, 10);
  assert.equal(check.broken, true);
});

/* --------------------------------------------------------- 交易日历 */

test("isTradingDay：周一到周五为交易日，周末与脏数据不是", () => {
  assert.equal(isTradingDay("2026-10-26"), true); // 周一
  assert.equal(isTradingDay("2026-10-30"), true); // 周五
  assert.equal(isTradingDay("2026-10-31"), false); // 周六
  assert.equal(isTradingDay("2026-11-01"), false); // 周日
  assert.equal(isTradingDay(""), false);
  assert.equal(isTradingDay("2026-02-31"), false); // 不存在的日期
  assert.equal(isTradingDay("2026/10/29"), false);
});

test("nextTradingDay：周五→周一，周六→周一", () => {
  assert.equal(nextTradingDay("2026-10-29"), "2026-10-30"); // 周四→周五
  assert.equal(nextTradingDay("2026-10-30"), "2026-11-02"); // 周五→周一
  assert.equal(nextTradingDay("2026-10-31"), "2026-11-02"); // 周六→周一
  assert.equal(nextTradingDay("2026-11-01"), "2026-11-02"); // 周日→周一
});

/* ------------------------------------------------------------- 签到 */

test("周五签到后，周一续签：连签 3、奖励 25", () => {
  const w = signed("2026-10-30", 2); // 上周五已签、连签 2
  const check = signinCheck({
    wallet: w,
    sessionDate: "2026-11-02",
    serverTime: "2026-11-02T10:15:30+08:00", // 周一
  });
  assert.equal(check.canSign, true);
  assert.equal(check.reason, "ok");
  assert.equal(check.targetDate, "2026-11-02");
  assert.equal(check.currentStreak, 2);
  assert.equal(check.nextStreak, 3);
  assert.equal(check.reward, 25);
  assert.equal(check.message, "连续签到第 3 天，+25 HTC · 还差 4 天 +5%");
});

test("周三断签后重置：连签从 1 重新算、奖励 10", () => {
  const w = signed("2026-10-28", 4); // 周三已签、连签 4；周四周五都没签
  const check = signinCheck({
    wallet: w,
    sessionDate: "2026-10-30",
    serverTime: "2026-10-30T10:15:30+08:00", // 周五
  });
  assert.equal(check.canSign, true);
  assert.equal(check.reason, "ok");
  assert.equal(check.currentStreak, 0);
  assert.equal(check.nextStreak, 1);
  assert.equal(check.reward, 10);
});

test("09:29 不可签，09:30 整点可签", () => {
  const w = wallet();
  const before = signinCheck({
    wallet: w,
    sessionDate: "2026-10-29",
    serverTime: "2026-10-29T09:29:59+08:00",
  });
  assert.equal(before.canSign, false);
  assert.equal(before.reason, "preopen");
  assert.equal(before.targetDate, "2026-10-29");
  assert.equal(before.message, "09:30 开盘后可签到");

  const at = signinCheck({
    wallet: w,
    sessionDate: "2026-10-29",
    serverTime: "2026-10-29T09:30:00+08:00",
  });
  assert.equal(at.canSign, true);
  assert.equal(at.reason, "ok");
});

test("周末不可签：周六/周日都拒绝，文案带休市", () => {
  for (const serverTime of ["2026-10-31T12:00:00+08:00", "2026-11-01T12:00:00+08:00"]) {
    const check = signinCheck({ wallet: wallet(), sessionDate: "2026-10-30", serverTime });
    assert.equal(check.canSign, false);
    assert.equal(check.reason, "weekend");
    assert.equal(check.targetDate, null);
    assert.equal(check.message, "休市 · 下一场开盘后可签");
  }
});

test("周末连签不断：周五签过，周一开盘续签 2", () => {
  const w = signed("2026-10-30", 1);
  const sat = signinCheck({ wallet: w, sessionDate: "2026-10-30", serverTime: "2026-10-31T12:00:00+08:00" });
  assert.equal(sat.reason, "weekend");
  assert.equal(sat.currentStreak, 1);
  assert.equal(sat.nextStreak, 2);
  assert.equal(sat.reward, 20);

  const mon = signinCheck({ wallet: w, sessionDate: "2026-11-02", serverTime: "2026-11-02T10:00:00+08:00" });
  assert.equal(mon.canSign, true);
  assert.equal(mon.nextStreak, 2);
  assert.equal(mon.reward, 20);
});

test("同日重复签到被拒：reason=already、不涨持仓", () => {
  const w = signed("2026-10-29", 3);
  const check = signinCheck({
    wallet: w,
    sessionDate: "2026-10-29",
    serverTime: "2026-10-29T10:15:30+08:00",
  });
  assert.equal(check.canSign, false);
  assert.equal(check.reason, "already");
  assert.equal(check.targetDate, "2026-10-29");
  assert.equal(check.currentStreak, 3);
  assert.equal(check.reward, 30); // 下一次（第 4 天）的奖励

  // 幂等：不可签时 applySignin 原样返回
  const same = applySignin({ wallet: w, check, price: 1, nowISO: "2026-10-29T10:16:00+08:00" });
  assert.deepEqual(same, w);
});

test("防改时间：手机日期与服务器日期不一致时提示「以服务器时间为准，未到下一场」", (t) => {
  // 把「现在」钉在一个本地工作日的正午；服务器日期换成另一个交易日 → 必然不一致
  const today = firstWeekday("2026-11-02");
  t.mock.timers.enable({ apis: ["Date"], now: localNoonMs(today) });
  assert.equal(localYmd(new Date()), today);

  const serverDate = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"].find(
    (d) => d !== today && isTradingDay(d)
  );
  assert.ok(serverDate, "应当有一个与手机日期不同的交易日");
  assert.notEqual(serverDate, today);

  const check = signinCheck({
    wallet: signed(serverDate, 2),
    sessionDate: serverDate,
    serverTime: serverDate + "T10:15:30+08:00",
  });
  assert.equal(check.canSign, false);
  assert.equal(check.reason, "already");
  assert.equal(check.message, "以服务器时间为准，未到下一场");
});

test("手机日期与服务器一致时，已签文案是「今日已签到 · 连续 N 天」", (t) => {
  const today = firstWeekday("2026-11-02");
  t.mock.timers.enable({ apis: ["Date"], now: localNoonMs(today) });
  assert.equal(localYmd(new Date()), today);

  const check = signinCheck({
    wallet: signed(today, 3),
    sessionDate: today,
    serverTime: today + "T10:15:30+08:00",
  });
  assert.equal(check.reason, "already");
  assert.equal(check.message, "今日已签到 · 连续 3 天");
});

test("服务器时间解析不了时只认服务器时间：reason=clock", () => {
  const check = signinCheck({ wallet: wallet(), sessionDate: "2026-10-29", serverTime: "不是时间" });
  assert.equal(check.canSign, false);
  assert.equal(check.reason, "clock");
  assert.equal(check.message, "以服务器时间为准");
});

test("历史签到日期在服务器之后（脏数据）：reason=clock，不瞎算连签", () => {
  const check = signinCheck({
    wallet: signed("2026-12-01", 5),
    sessionDate: "2026-10-29",
    serverTime: "2026-10-29T10:15:30+08:00",
  });
  assert.equal(check.canSign, false);
  assert.equal(check.reason, "clock");
  assert.equal(check.message, "以服务器时间为准");
});

/* ------------------------------------------------------------- 钱包 */

test("钱包初始 1000 HTC，成本价 = 首次开盘价", () => {
  const w = createWallet(89.03, "2026-10-29T10:15:30+08:00");
  assert.equal(w.version, 1);
  assert.equal(w.holdings, 1000);
  assert.equal(w.costPrice, 89.03);
  assert.equal(w.initialAt, "2026-10-29T10:15:30+08:00");
  assert.equal(w.lastSign, null);
  assert.deepEqual(w.history, []);
});

test("市值 = 数量 × 现价；今日盈亏 = 数量 ×（现价 − 昨收）", () => {
  const w = createWallet(89.03, "2026-10-29T10:15:30+08:00");
  assert.equal(marketValue(w, 89.87), 1000 * 89.87);

  const pnl = todayPnl(w, 89.87, 88.98);
  assert.ok(Math.abs(pnl - 1000 * (89.87 - 88.98)) < 1e-9);

  const pct = todayPnlPct(89.87, 88.98);
  assert.ok(Math.abs(pct - ((89.87 - 88.98) / 88.98) * 100) < 1e-9);
  assert.equal(todayPnlPct(100, 0), 0); // 昨收 0 不炸
});

test("签到入账：持仓 +奖励、lastSign 记录、成本价不变", () => {
  const w = createWallet(89.03, "2026-10-29T10:15:30+08:00");
  const check = signinCheck({
    wallet: w,
    sessionDate: "2026-10-29",
    serverTime: "2026-10-29T10:15:30+08:00",
  });
  assert.equal(check.canSign, true);
  assert.equal(check.reward, 10);

  const after = applySignin({
    wallet: w,
    check,
    price: 89.87,
    nowISO: "2026-10-29T10:16:00+08:00",
  });
  assert.equal(after.holdings, 1010);
  assert.equal(after.costPrice, 89.03); // 成本价 v1 固定
  assert.equal(after.lastSign.date, "2026-10-29");
  assert.equal(after.lastSign.streak, 1);
  assert.equal(after.lastSign.price, 89.87);
  assert.equal(after.lastSign.reward, 10);
  assert.equal(after.history.length, 1);
  assert.deepEqual(after.history[0], { date: "2026-10-29", reward: 10, price: 89.87 });
  assert.equal(after.updatedAt, "2026-10-29T10:16:00+08:00");
  assert.equal(after.version, 1);
  // B7：奖励走统一记账入口，来源打标；成就/计数器同步
  assert.equal(after.ledger.length, 1);
  assert.equal(after.ledger[0].source, "signin");
  assert.equal(after.ledger[0].htc, 10);
  assert.equal(after.stats.signins, 1);
  assert.equal(after.stats.maxStreak, 1);
  assert.equal(after.stats.totalReward, 10);
  assert.deepEqual(after.achievements, ["first_signin"]);
});

test("applyLedger：统一记账、来源打标、交易计数器", () => {
  const w = createWallet(100, "2026-01-05T10:00:00+08:00");
  const signedUp = applyLedger(w, { htc: 10 }, "signin", {
    nowISO: "2026-01-05T10:01:00+08:00",
    streak: 1,
  });
  assert.equal(signedUp.holdings, 1010);
  assert.equal(signedUp.ledger.at(-1).source, "signin");
  assert.equal(signedUp.stats.signins, 1);

  const bought = applyLedger(signedUp, { htc: 100, usdt: -900 }, "trade:buy", {
    nowISO: "2026-01-05T10:02:00+08:00",
    amount: 100,
    fee: 2.7,
  });
  assert.equal(bought.holdings, 1110);
  assert.equal(bought.ledger.at(-1).source, "trade:buy");
  assert.equal(bought.ledger.at(-1).usdt, -900);
  assert.equal(bought.stats.trades, 1);
  assert.equal(bought.stats.buys, 1);
  assert.equal(bought.stats.volume, 100);
  assert.equal(bought.stats.fees, 2.7);
});

test("成就目录：20 条、id 唯一、与服务端同目录同阈值", () => {
  assert.equal(ACHIEVEMENTS.length, 20);
  assert.equal(new Set(ACHIEVEMENTS.map((a) => a.id)).size, 20);
  const require = createRequire(import.meta.url);
  const market = require("../../../fc/coin-api/market-v2.js");
  assert.deepEqual(market.ACHIEVEMENTS.map((a) => a.id), ACHIEVEMENTS.map((a) => a.id));
  assert.deepEqual(market.ACHIEVEMENTS.map((a) => a.target), ACHIEVEMENTS.map((a) => a.target));
});

test("成就判定：阈值、进度、去重合并", () => {
  const base = {
    ...emptyAchievementStats(),
    netWorth: 0,
    htc: 0,
    usdt: 0,
    merged: false,
    bankruptCount: 0,
  };
  assert.deepEqual(unlockedAchievementIds(base), []);

  const one = { ...base, signins: 1, maxStreak: 1 };
  assert.deepEqual(unlockedAchievementIds(one), ["first_signin"]);

  const rich = {
    ...one,
    signins: 50,
    maxStreak: 7,
    totalReward: 500,
    trades: 10,
    buys: 5,
    sells: 5,
    volume: 10000,
    fees: 100,
    netWorth: 250000,
    htc: 5000,
    usdt: 200000,
    merged: true,
  };
  const ids = unlockedAchievementIds(rich);
  for (const id of [
    "signin_10",
    "signin_50",
    "streak_7",
    "reward_500",
    "trade_10",
    "volume_10000",
    "fee_100",
    "networth_250k",
    "htc_5000",
    "usdt_200k",
    "merged",
  ]) {
    assert.ok(ids.includes(id), "应当解锁 " + id);
  }
  assert.ok(!ids.includes("streak_30"));

  const progress = achievementProgress("streak_30", rich);
  assert.equal(progress.unlocked, false);
  assert.equal(progress.value, 7);
  assert.equal(progress.target, 30);

  const wallet = { ...createWallet(100, "2026-01-05T10:00:00+08:00"), holdings: 2000 };
  const merged = mergeAchievementIds(undefined, snapshotFromWallet(wallet, 100));
  assert.ok(merged.includes("htc_2000"));
  assert.ok(merged.includes("networth_250k") === false); // 2000 × 100 = 200,000，还差 50,000
});

test("本地与服务端签到奖励口径一致（含连签 +5%）", () => {
  const require = createRequire(import.meta.url);
  const market = require("../../../fc/coin-api/market-v2.js");
  for (let n = 1; n <= 12; n++) assert.equal(market.signinReward(n), signinReward(n));
});

test("history 最多 60 条，只留最近 60 次签到", () => {
  let w = createWallet(100, "2026-01-05T10:00:00+08:00");
  let date = "2026-01-05"; // 周一
  let expectedHoldings = 1000;
  const allDates = [];
  for (let i = 1; i <= 65; i++) {
    const reward = rewardForStreak(i);
    expectedHoldings += reward;
    const check = {
      canSign: true,
      reason: "ok",
      targetDate: date,
      currentStreak: i - 1,
      nextStreak: i,
      reward,
      message: "",
    };
    w = applySignin({ wallet: w, check, price: 100 + i, nowISO: date + "T10:15:00+08:00" });
    allDates.push(date);
    date = nextTradingDay(date);
  }
  assert.equal(w.history.length, 60);
  assert.deepEqual(
    w.history.map((h) => h.date),
    allDates.slice(-60)
  );
  assert.equal(w.lastSign.date, allDates[64]);
  assert.equal(w.lastSign.streak, 65);
  assert.equal(w.holdings, expectedHoldings);
});

/* --------------------------------------------------------------- API */

test("coinApiUrl：去尾斜杠拼 /api/daily", () => {
  assert.equal(coinApiUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787/api/daily");
  assert.equal(coinApiUrl("http://127.0.0.1:8787/"), "http://127.0.0.1:8787/api/daily");
  assert.equal(coinApiUrl("https://fc.example.com///"), "https://fc.example.com/api/daily");
  assert.equal(coinApiUrl(""), "/api/daily");
});

test("parseCoinDaily：合法响应完整解析", () => {
  const res = parseCoinDaily(dailyJson());
  assert.equal(res.version, 1);
  assert.equal(res.serverTime, "2026-10-29T10:15:30+08:00");
  assert.equal(res.market.name, "黑塔币");
  assert.equal(res.market.code, "HTC");
  assert.equal(res.market.pair, "HTC/USDT");
  assert.equal(res.market.sessionDate, "2026-10-29");
  assert.equal(res.market.sessionNumber, 214);
  assert.equal(res.market.status, "trading");
  assert.equal(res.market.statusLabel, "交易中 · 上午");
  assert.equal(res.market.prevClose, 88.98);
  assert.equal(res.market.open, 89.03);
  assert.equal(res.market.high, 90.03);
  assert.equal(res.market.low, 88.42);
  assert.equal(res.market.close, 89.87);
  assert.equal(res.market.changePct, 1.002);
  assert.equal(res.market.volume, 77000);
  assert.equal(res.market.turnover, 6871800);
  assert.equal(res.market.revealed, 2);
  assert.equal(res.market.partial, 0.5);
  assert.equal(res.market.keyFingerprint, "4CDBB70C");
  assert.equal(res.market.bars.length, 2);
  assert.deepEqual(res.market.bars[0], { t: 0, o: 88.99, h: 89.04, l: 88.99, c: 89.04, v: 1000 });
  assert.equal(res.market.bars[1].partial, true);
});

test("parseCoinDaily：非法 JSON / 字段缺失 / 类型不对都抛中文 Error", () => {
  const cases = [
    ["坏 JSON", "{不是 json"],
    ["空文本", ""],
    ["缺 version", JSON.stringify({ serverTime: "2026-10-29T10:15:30+08:00", market: market() })],
    ["version 不对", dailyJson("2026-10-29T10:15:30+08:00", {}, { version: 2 })],
    ["缺 market", JSON.stringify({ version: 1, serverTime: "2026-10-29T10:15:30+08:00" })],
    ["market 不是对象", dailyJson("2026-10-29T10:15:30+08:00", {}, { market: [] })],
    ["serverTime 不是时间", dailyJson("昨天")],
    ["缺 serverTime", JSON.stringify({ version: 1, market: market() })],
    ["缺 prevClose", dailyJson("2026-10-29T10:15:30+08:00", { prevClose: undefined })],
    ["close 是字符串", dailyJson("2026-10-29T10:15:30+08:00", { close: "89.87" })],
    ["volume 是 NaN", dailyJson("2026-10-29T10:15:30+08:00", { volume: Number.NaN })],
    ["status 不认识", dailyJson("2026-10-29T10:15:30+08:00", { status: "auction" })],
    ["sessionDate 格式错", dailyJson("2026-10-29T10:15:30+08:00", { sessionDate: "2026/10/29" })],
    ["revealed 越界", dailyJson("2026-10-29T10:15:30+08:00", { revealed: 241 })],
    ["bars 不是数组", dailyJson("2026-10-29T10:15:30+08:00", { bars: {} })],
    ["bar.t 越界", dailyJson("2026-10-29T10:15:30+08:00", { bars: [bar(240, 1, 2)] })],
    ["bar.o 缺失", dailyJson("2026-10-29T10:15:30+08:00", { bars: [{ t: 0, h: 1, l: 1, c: 1, v: 1 }] })],
    ["bar.partial 非布尔", dailyJson("2026-10-29T10:15:30+08:00", { bars: [bar(0, 1, 2, { partial: 1 })] })],
  ];
  for (const [name, text] of cases) {
    assert.throws(
      () => parseCoinDaily(text),
      (err) => err instanceof Error && /^行情数据格式不对：/.test(err.message),
      "应当抛中文格式错误：" + name
    );
  }
});

test("fetchCoinDaily：走注入的 getText、拼 url、解析结果", async () => {
  const urls = [];
  const res = await fetchCoinDaily("http://127.0.0.1:8787/", async (url) => {
    urls.push(url);
    return dailyJson();
  });
  assert.deepEqual(urls, ["http://127.0.0.1:8787/api/daily"]);
  assert.equal(res.market.close, 89.87);

  // 空 base 不请求
  await assert.rejects(
    () => fetchCoinDaily("", async () => dailyJson()),
    (err) => err instanceof Error && err.message === "未配置行情接口"
  );

  // getText 的错误原样上抛
  await assert.rejects(
    () =>
      fetchCoinDaily("http://x", async () => {
        throw new Error("接口 500");
      }),
    (err) => err instanceof Error && err.message === "接口 500"
  );
});

test("parseCoinDaily：快讯随行情下发（可选字段，结构严格）", () => {
  const feed = {
    total: 3,
    items: [
      { bar: 45, time: "10:15", dir: "up", tag: "利好", strength: 3, text: "黑塔币获得大额买入" },
      { bar: 12, time: "09:42", dir: "flat", tag: "中性", strength: 1, text: "黑塔币发布例行公告" },
    ],
  };
  const withNews = parseCoinDaily(dailyJson("2026-10-29T10:15:30+08:00", {}, { news: feed }));
  assert.deepEqual(withNews.news, feed);
  assert.equal(parseCoinDaily(dailyJson()).news, undefined);

  const badDir = dailyJson("2026-10-29T10:15:30+08:00", {}, {
    news: { total: 1, items: [{ bar: 1, time: "09:31", dir: "sideways", tag: "利好", strength: 1, text: "x" }] },
  });
  assert.throws(() => parseCoinDaily(badDir), /news/);

  const badBar = dailyJson("2026-10-29T10:15:30+08:00", {}, {
    news: { total: 1, items: [{ bar: 240, time: "15:00", dir: "up", tag: "利好", strength: 1, text: "x" }] },
  });
  assert.throws(() => parseCoinDaily(badBar), /news/);
});

/* ------------------------------------------------------------ 格式化 */

test("formatHtc：整数不带小数、非整数保留两位", () => {
  assert.equal(formatHtc(1000), "1000");
  assert.equal(formatHtc(47.25), "47.25");
  assert.equal(formatHtc(47.2), "47.20");
  assert.equal(formatHtc(47.256), "47.26");
  assert.equal(formatHtc(Number.NaN), "—");
});

test("formatPct：正数带 +、负数带 -、零不带符号", () => {
  assert.equal(formatPct(1.002), "+1.00%");
  assert.equal(formatPct(-0.5), "-0.50%");
  assert.equal(formatPct(0), "0.00%");
  assert.equal(formatPct(12.3456, 2), "+12.35%");
  assert.equal(formatPct(1.2, 1), "+1.2%");
  assert.equal(formatPct(0.0001, 2), "0.00%"); // 四舍五入到零就不带符号
});

test("formatPrice：默认两位小数", () => {
  assert.equal(formatPrice(89.87), "89.87");
  assert.equal(formatPrice(89.8), "89.80");
  assert.equal(formatPrice(1), "1.00");
  assert.equal(formatPrice(89.8, 3), "89.800");
  assert.equal(formatPrice(1.23456, 4), "1.2346");
});

test("formatAmount：万/亿缩写沿用网页 fmtWan 口径", () => {
  assert.equal(formatAmount(77000), "7.70 万");
  assert.equal(formatAmount(6871800), "687.18 万");
  assert.equal(formatAmount(123456789), "1.23 亿");
  assert.equal(formatAmount(999), "999");
  assert.equal(formatAmount(10000), "1.00 万");
  assert.equal(formatAmount(1e8), "1.00 亿");
});
