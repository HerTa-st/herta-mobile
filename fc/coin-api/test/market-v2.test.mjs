/*
 * 黑塔币 v2 · 共享市场逻辑测试（不依赖网络/OSS，用内存存储 + 固定时钟）
 * 运行：node fc/coin-api/test/market-v2.test.mjs
 */
'use strict';

import assert from 'node:assert';
import { createRequire } from 'node:module';

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

  /* 5. 单笔上限 */
  const over = await env1.call('POST', '/api/trade', {
    body: { user: '梦源', side: 'buy', amount: 10001 }
  });
  check('单笔超过 10000 被拒', () => {
    assert.equal(over.status, 400);
    assert.equal(over.json.error, 'amount_too_large');
  });

  /* 6. USDT 不足 */
  env1.advance(6000);
  const broke = await env1.call('POST', '/api/trade', {
    body: { user: '梦源', side: 'buy', amount: 10000 }
  });
  check('USDT 不足被拒', () => {
    assert.equal(broke.status, 400);
    assert.equal(broke.json.error, 'insufficient_usdt');
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

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('测试崩溃：', e);
  process.exit(1);
});
