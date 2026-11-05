/*
 * 黑塔币 v2 · 共享市场逻辑测试（不依赖网络/OSS，用内存存储 + 固定时钟）
 * 运行：node fc/coin-api/test/market-v2.test.mjs
 */
'use strict';

import assert from 'node:assert';
import { createRequire } from 'node:module';
import { applyLedger as clientApplyLedger } from '../../../packages/coin/src/wallet.ts';

const require = createRequire(import.meta.url);
const { createHandler } = require('../index.js');

function createMemoryStore() {
  let state = null;
  return {
    async read() { return state ? JSON.parse(JSON.stringify(state)) : null; },
    async write(next) { state = JSON.parse(JSON.stringify(next)); },
    async withLock(fn) { return fn(); }
  };
}

function makeEnv(startIso) {
  const env = {
    ms: Date.parse(startIso),
    store: createMemoryStore()
  };
  env.handler = createHandler({
    now: () => env.ms,
    storeFactory: () => env.store
  });
  env.call = async function (method, path, opts) {
    opts = opts || {};
    const event = {
      httpMethod: method,
      path: path,
      rawPath: path,
      queryParameters: opts.query || {},
      queryStringParameters: opts.query || {},
      body: opts.body ? JSON.stringify(opts.body) : '',
      isBase64Encoded: false,
      requestContext: { http: { method: method, path: path } }
    };
    const res = await env.handler(event, { requestId: 'test' });
    let json = null;
    try { json = JSON.parse(res.body || 'null'); } catch (e) { json = null; }
    return { status: res.statusCode, json: json };
  };
  env.advance = function (ms) { env.ms += ms; };
  return env;
}

const TRADE_ISO = '2026-10-29T10:15:30+08:00';
let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL ' + name + ' -> ' + e.message);
  }
}

(async function main() {
  const clientSignin = await import('../../../packages/coin/src/signin.ts');
  const clientAchievements = await import('../../../packages/coin/src/achievements.ts');

  /* 1. 首次 state：自动建号 */
  const env1 = makeEnv(TRADE_ISO);
  const s1 = await env1.call('GET', '/api/state', { query: { user: '梦源' } });
  check('state 200 且自动建号', () => {
    assert.equal(s1.status, 200);
    assert.equal(s1.json.user.name, '梦源');
    assert.equal(s1.json.user.htc, 1000);
    assert.equal(s1.json.user.usdt, 100000);
    assert.equal(s1.json.market.status, 'trading');
    assert.equal(s1.json.market.netBuy, 0);
    assert.ok(s1.json.leaderboard.length >= 1);
    // B7：连签 / 成就字段随 state 下发
    assert.deepEqual(s1.json.user.achievements, []);
    assert.equal(s1.json.user.achievementStats.signins, 0);
    assert.equal(s1.json.user.bankruptCount, 0);
    assert.equal(s1.json.user.signin.daysToBonus, 7);
    assert.equal(s1.json.user.signin.broken, false);
  });

  const basePrice = s1.json.market.price;

  /* 2. 买入：扣 USDT、加 HTC、推价格 */
  const b1 = await env1.call('POST', '/api/trade', {
    body: { user: '梦源', side: 'buy', amount: 1000 }
  });
  check('买入成功且扣费/持仓正确', () => {
    assert.equal(b1.status, 200);
    assert.equal(b1.json.trade.side, 'buy');
    assert.equal(b1.json.trade.amount, 1000);
    assert.equal(b1.json.user.htc, 2000);
    const expectedUsdt = 100000 - 1000 * s1.json.market.basePrice * 1.003;
    assert.ok(Math.abs(b1.json.user.usdt - Math.round(expectedUsdt * 100) / 100) < 3,
      'usdt=' + b1.json.user.usdt + ' expected≈' + expectedUsdt);
    assert.equal(b1.json.market.netBuy, 1000);
    assert.ok(b1.json.trade.impactPct > 0, '买入后应有正冲击');
    assert.ok(b1.json.trade.priceAfter > b1.json.trade.price, '价格应被买入推高');
  });

  /* 3. 5 秒冷却 */
  const c1 = await env1.call('POST', '/api/trade', {
    body: { user: '梦源', side: 'sell', amount: 500 }
  });
  check('5 秒内重复下单被拒', () => {
    assert.equal(c1.status, 429);
    assert.equal(c1.json.error, 'cooldown');
  });

  /* 4. 冷却结束后卖出 */
  env1.advance(6000);
  const s2 = await env1.call('POST', '/api/trade', {
    body: { user: '梦源', side: 'sell', amount: 500 }
  });
  check('卖出成功且净买入回落', () => {
    assert.equal(s2.status, 200);
    assert.equal(s2.json.user.htc, 1500);
    assert.equal(s2.json.market.netBuy, 500);
    assert.ok(s2.json.trade.impactPct < b1.json.trade.impactPct, '卖出后冲击应回落');
  });

  const s2state = await env1.call('GET', '/api/state', { query: { user: '梦源' } });
  check('买卖都走 applyLedger（来源打标）并解锁首批成就', () => {
    const u = s2state.json.user;
    assert.ok(u.achievements.includes('first_trade'));
    assert.ok(u.achievements.includes('first_buy'));
    assert.ok(u.achievements.includes('first_sell'));
    assert.equal(u.achievementStats.trades, 2);
    assert.equal(u.achievementStats.volume, 1500);
    assert.ok(u.achievementStats.fees > 0);
  });

  /* 5. 单笔上限 */
  const over = await env1.call('POST', '/api/trade', {
    body: { user: '梦源', side: 'buy', amount: 10001 }
  });
  check('单笔超过 10000 被拒', () => {
    assert.equal(over.status, 400);
    assert.equal(over.json.error, 'amount_too_large');
  });

  /* 6. 信用点不足 */
  env1.advance(6000);
  const broke = await env1.call('POST', '/api/trade', {
    body: { user: '梦源', side: 'buy', amount: 10000 }
  });
  check('信用点不足被拒（界面文案不再出现 USDT）', () => {
    assert.equal(broke.status, 400);
    assert.equal(broke.json.error, 'insufficient_usdt');
    assert.ok(broke.json.message.includes('信用点'));
    assert.ok(!broke.json.message.includes('USDT'));
  });

  /* 7. 非法昵称 */
  const bad = await env1.call('GET', '/api/state', { query: { user: 'a b' } });
  const bad2 = await env1.call('GET', '/api/state', { query: {} });
  check('非法/空昵称被拒', () => {
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_name');
    assert.equal(bad2.status, 400);
  });

  /* 8. 休市不能交易 */
  const env2 = makeEnv('2026-10-29T08:00:00+08:00');
  const closed = await env2.call('POST', '/api/trade', {
    body: { user: '小明', side: 'buy', amount: 100 }
  });
  check('盘前休市拒绝交易', () => {
    assert.equal(closed.status, 400);
    assert.equal(closed.json.error, 'market_closed');
  });

  /* 9. 每日买卖次数上限 */
  const env3 = makeEnv('2026-10-29T10:00:00+08:00');
  const env3s = await env3.call('GET', '/api/state', { query: { user: '买买买' } });
  assert.equal(env3s.status, 200);
  let buyOk = 0;
  for (let i = 0; i < 6; i++) {
    env3.advance(5100);
    const r = await env3.call('POST', '/api/trade', {
      body: { user: '买买买', side: 'buy', amount: 10 }
    });
    if (r.status === 200) buyOk++;
    else {
      check('第 6 次买入被拒', () => {
        assert.equal(r.status, 429);
        assert.equal(r.json.error, 'buy_limit');
      });
      break;
    }
  }
  check('每天只能买 5 次', () => assert.equal(buyOk, 5));

  /* 10. 换场后次数与净买入归零 */
  env3.ms = Date.parse('2026-10-30T10:00:00+08:00');
  const nextDay = await env3.call('GET', '/api/state', { query: { user: '买买买' } });
  check('换场后净买入/次数归零，余额保留', () => {
    assert.equal(nextDay.status, 200);
    assert.equal(nextDay.json.market.sessionDate, '2026-10-30');
    assert.equal(nextDay.json.market.netBuy, 0);
    assert.equal(nextDay.json.user.todayBuy, 0);
    assert.equal(nextDay.json.user.htc, 1050);
  });

  /* 11. 排行榜 */
  const s3 = await env3.call('GET', '/api/state', { query: { user: '新手' } });
  const board = await env3.call('GET', '/api/leaderboard');
  check('排行榜按持仓市值排序', () => {
    assert.equal(s3.status, 200);
    assert.equal(board.status, 200);
    assert.ok(board.json.leaderboard.length >= 2);
    assert.ok(board.json.leaderboard[0].value >= board.json.leaderboard[1].value);
  });

  /* 12. 方法/路径错误 */
  const m1 = await env3.call('GET', '/api/trade');
  const m2 = await env3.call('GET', '/api/nope');
  check('错误方法与未知路径', () => {
    assert.equal(m1.status, 405);
    assert.equal(m2.status, 404);
  });

  /* 13. 本地钱包合并（一次性） */
  const env4 = makeEnv('2026-10-29T10:00:00+08:00');
  const cl0 = await env4.call('GET', '/api/state', { query: { user: '合并测试' } });
  const cl1 = await env4.call('POST', '/api/claim', { body: { user: '合并测试', amount: 500 } });
  const cl2 = await env4.call('POST', '/api/claim', { body: { user: '合并测试', amount: 500 } });
  check('本地钱包只能合并一次', () => {
    assert.equal(cl0.status, 200);
    assert.equal(cl1.status, 200);
    assert.equal(cl1.json.mergedHtc, 500);
    assert.equal(cl1.json.user.htc, 1500);
    assert.equal(cl1.json.user.merged, true);
    assert.ok(cl1.json.user.achievements.includes('merged'));
    assert.ok(cl1.json.user.achievementStats.trades === 0);
    assert.equal(cl2.status, 400);
    assert.equal(cl2.json.error, 'already_merged');
  });

  /* 14. 服务端签到曲线 */
  const env5 = makeEnv('2026-10-29T10:00:00+08:00');
  await env5.call('GET', '/api/state', { query: { user: '签到测试' } });
  const sg1 = await env5.call('POST', '/api/signin', { body: { user: '签到测试' } });
  const sg2 = await env5.call('POST', '/api/signin', { body: { user: '签到测试' } });
  env5.ms = Date.parse('2026-10-30T10:00:00+08:00');
  const sg3 = await env5.call('POST', '/api/signin', { body: { user: '签到测试' } });
  env5.ms = Date.parse('2026-11-03T10:00:00+08:00');
  const sg4 = await env5.call('POST', '/api/signin', { body: { user: '签到测试' } });
  check('签到首日 10 / 次日 20 / 同日拒绝 / 断签重置', () => {
    assert.equal(sg1.status, 200);
    assert.equal(sg1.json.reward, 10);
    assert.equal(sg1.json.user.htc, 1010);
    assert.equal(sg2.status, 400);
    assert.equal(sg2.json.error, 'already_signed');
    assert.equal(sg3.status, 200);
    assert.equal(sg3.json.reward, 20);
    assert.equal(sg3.json.streak, 2);
    assert.equal(sg4.status, 200);
    assert.equal(sg4.json.reward, 10);
    assert.equal(sg4.json.streak, 1);
  });

  /* 14b. 连签第 7 天 +5%：奖励曲线、state 字段、断签归零 */
  const env7 = makeEnv('2026-10-29T10:00:00+08:00');
  const signDays = [
    '2026-10-29', // 周四，第 1 天
    '2026-10-30', // 周五，第 2 天
    '2026-11-02', // 周一，第 3 天
    '2026-11-03', // 周二，第 4 天
    '2026-11-04', // 周三，第 5 天
    '2026-11-05', // 周四，第 6 天
    '2026-11-06'  // 周五，第 7 天（+5%）
  ];
  const rewards = [];
  let seventh;
  for (let i = 0; i < signDays.length; i++) {
    env7.ms = Date.parse(signDays[i] + 'T10:00:00+08:00');
    if (i === 6) {
      env7.ms = Date.parse('2026-11-06T09:00:00+08:00');
      const before7 = await env7.call('GET', '/api/state', { query: { user: '七日签到' } });
      check('连签第 6 天后：还差 1 天，下次奖励 47.25', () => {
        assert.equal(before7.json.user.signin.streak, 6);
        assert.equal(before7.json.user.signin.daysToBonus, 1);
        assert.equal(before7.json.user.signin.nextRewardBase, 45);
        assert.equal(before7.json.user.signin.nextReward, 47.25);
        assert.equal(before7.json.user.signin.bonusPct, 5);
      });
      env7.ms = Date.parse(signDays[i] + 'T10:00:00+08:00');
    }
    seventh = await env7.call('POST', '/api/signin', { body: { user: '七日签到' } });
    rewards.push(seventh.json.reward);
  }
  const st7 = await env7.call('GET', '/api/state', { query: { user: '七日签到' } });
  check('连签 7 天：第 7 天 +5%（47.25），state 能看到连签与成就', () => {
    assert.deepEqual(rewards, [10, 20, 25, 30, 35, 40, 47.25]);
    assert.equal(st7.json.user.signin.streak, 7);
    assert.equal(st7.json.user.signin.daysToBonus, 0);
    assert.equal(st7.json.user.signin.bonusPct, 5);
    assert.equal(st7.json.user.htc, 1207.25);
    assert.ok(st7.json.user.achievements.includes('streak_7'));
    assert.equal(st7.json.user.achievementStats.signins, 7);
    assert.equal(st7.json.user.achievementStats.maxStreak, 7);
    assert.equal(st7.json.user.achievementStats.totalReward, 207.25);
  });

  env7.ms = Date.parse('2026-11-10T10:00:00+08:00'); // 跳过周一
  const brokenState = await env7.call('GET', '/api/state', { query: { user: '七日签到' } });
  const resetSign = await env7.call('POST', '/api/signin', { body: { user: '七日签到' } });
  check('断签后连续天数归零，界面字段说清楚', () => {
    assert.equal(brokenState.json.user.signin.streak, 0);
    assert.equal(brokenState.json.user.signin.broken, true);
    assert.equal(brokenState.json.user.signin.daysToBonus, 7);
    assert.equal(resetSign.status, 200);
    assert.equal(resetSign.json.streak, 1);
    assert.equal(resetSign.json.reward, 10);
  });

  /* 15. 开盘前 / 周末不能签到 */
  const env6 = makeEnv('2026-10-29T08:00:00+08:00');
  const pre = await env6.call('POST', '/api/signin', { body: { user: '早起的人' } });
  env6.ms = Date.parse('2026-10-31T12:00:00+08:00');
  const wk = await env6.call('POST', '/api/signin', { body: { user: '早起的人' } });
  check('开盘前与周末签到被拒', () => {
    assert.equal(pre.status, 400);
    assert.equal(pre.json.error, 'not_open');
    assert.equal(wk.status, 400);
    assert.equal(wk.json.error, 'market_closed');
  });

  /* 16. 快讯随 /api/daily 下发（服务端用 news-pool，不在客户端重算） */
  const envN = makeEnv('2026-10-29T10:15:30+08:00');
  const daily = await envN.call('GET', '/api/daily');
  check('快讯随行情下发、按分钟倒序、不泄漏未来', () => {
    assert.equal(daily.status, 200);
    const feed = daily.json.news;
    assert.ok(feed && feed.total >= 10, 'news.total=' + (feed && feed.total));
    assert.ok(feed.items.length >= 1);
    assert.ok(feed.items.length <= feed.total);
    assert.ok(feed.items.every((i) => i.bar >= 0 && i.bar <= daily.json.market.revealed));
    assert.ok(feed.items.every((i) => ['up', 'down', 'flat'].includes(i.dir)));
    assert.ok(feed.items.every((i) => i.strength >= 1 && i.strength <= 3));
    assert.ok(feed.items.every((i) => i.time.length === 5 && i.text.length > 0));
    assert.ok(feed.items.every((i) => !i.text.includes('{') && !/%[a-z]%/.test(i.text)));
    for (let i = 1; i < feed.items.length; i++) assert.ok(feed.items[i - 1].bar >= feed.items[i].bar);
  });

  /* 17. 客户端 / 服务端口径一致 + applyLedger 来源打标 */
  check('本地与服务端签到 / 成就目录一致', () => {
    const market = require('../market-v2.js');
    for (let n = 1; n <= 12; n++) assert.equal(market.signinReward(n), clientSignin.signinReward(n));
    assert.deepEqual(
      market.ACHIEVEMENTS.map((a) => a.id),
      clientAchievements.ACHIEVEMENTS.map((a) => a.id)
    );
    assert.deepEqual(
      market.ACHIEVEMENTS.map((a) => a.target),
      clientAchievements.ACHIEVEMENTS.map((a) => a.target)
    );
  });

  check('applyLedger 来源打标：本地与服务端同形', () => {
    const market = require('../market-v2.js');
    const serverUser = {
      name: '审计',
      htc: 1000,
      usdt: 1000,
      achievements: [],
      stats: market.ACHIEVEMENTS && {
        signins: 0, maxStreak: 0, totalReward: 0,
        trades: 0, buys: 0, sells: 0, volume: 0, fees: 0
      },
      ledger: []
    };
    market.applyLedger(serverUser, { htc: 10 }, 'signin', { nowIso: '2026-01-01T00:00:00.000Z', streak: 1 });
    market.applyLedger(serverUser, { htc: 100, usdt: -900 }, 'trade:buy', {
      nowIso: '2026-01-01T00:01:00.000Z', amount: 100, fee: 2.7
    });
    assert.deepEqual(serverUser.ledger.map((e) => e.source), ['signin', 'trade:buy']);
    assert.equal(serverUser.ledger[0].htc, 10);
    assert.equal(serverUser.ledger[1].usdt, -900);
    assert.equal(serverUser.stats.trades, 1);

    const wallet = {
      version: 1, holdings: 1000, costPrice: 1, initialAt: '2026-01-01T00:00:00.000Z',
      lastSign: null, history: [], achievements: [], updatedAt: '2026-01-01T00:00:00.000Z'
    };
    const after = clientApplyLedger(wallet, { htc: 10 }, 'signin', { nowISO: '2026-01-01T00:00:00.000Z', streak: 1 });
    assert.equal(after.ledger.at(-1).source, 'signin');
    assert.equal(after.holdings, 1010);
  });

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('测试崩溃：', e);
  process.exit(1);
});
