/*
 * 黑塔币 · 每日密钥（/api/seeds）测试
 *
 * 覆盖 docs/价格密钥-设计-2026-11-07.md 的服务端部分：
 *   1. 切换日之前的日期一根价格都不许变，而且不会去问密钥（旧向量逐位一致）；
 *   2. 切换日起没有密钥就开不了盘（抛 missing_secret，不拿日期派生备用钥匙）；
 *   3. GET /api/seeds?from= 只发 [max(from, CUTOVER), 今天] 的交易日密钥，
 *      周末不发、切换日之前不发、from 早于 CUTOVER 就按 CUTOVER 回；
 *   4. 同一日期只生成一次：重复调用不换密钥、旧状态（没有 seeds）不清库；
 *   5. /api/daily、/api/state、/api/trade 都改吃 seeds，行情由盘上的密钥决定，
 *      响应形状不变（不把 seeds 漏给客户端）。
 *
 * 运行：node fc/coin-api/test/seeds.test.mjs
 */
'use strict';

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHandler } = require('../index.js');
const core = require('../coin-core.js');
const seedsLib = require('../seeds.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(HERE, 'vectors.json'), 'utf8')).vectors;

const CUTOVER = core.CUTOVER;
const SEED_RE = /^[0-9a-f]{32}$/;
const TOL = 1e-9;

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL ' + name + ' -> ' + (e && e.message));
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL ' + name + ' -> ' + (e && e.message));
  }
}

function close(a, b, label) {
  assert.ok(Math.abs(a - b) <= TOL * Math.max(1, Math.abs(b)),
    (label || '数值') + ' 不一致：' + a + ' vs ' + b);
}

function createMemoryStore(initial) {
  let state = initial ? JSON.parse(JSON.stringify(initial)) : null;
  return {
    async read() { return state ? JSON.parse(JSON.stringify(state)) : null; },
    async write(next) { state = JSON.parse(JSON.stringify(next)); },
    async withLock(fn) { return fn(); }
  };
}

function makeEnv(nowIso, store) {
  const env = { ms: Date.parse(nowIso), store: store || createMemoryStore() };
  env.handler = createHandler({ now: () => env.ms, storeFactory: () => env.store });
  env.call = async function (method, path, query) {
    const event = {
      httpMethod: method,
      path: path,
      rawPath: path,
      queryParameters: query || {},
      queryStringParameters: query || {},
      body: '',
      isBase64Encoded: false,
      requestContext: { http: { method: method, path: path } }
    };
    const res = await env.handler(event, { requestId: 'seeds-test' });
    let json = null;
    try { json = JSON.parse(res.body || 'null'); } catch (e) { json = null; }
    return { status: res.statusCode, json: json, text: res.body || '' };
  };
  env.post = async function (path, body) {
    const event = {
      httpMethod: 'POST',
      path: path,
      rawPath: path,
      queryParameters: {},
      queryStringParameters: {},
      body: JSON.stringify(body || {}),
      isBase64Encoded: false,
      requestContext: { http: { method: 'POST', path: path } }
    };
    const res = await env.handler(event, { requestId: 'seeds-test' });
    let json = null;
    try { json = JSON.parse(res.body || 'null'); } catch (e) { json = null; }
    return { status: res.statusCode, json: json, text: res.body || '' };
  };
  return env;
}

/* 2026-11-07 是周六，2026-11-09 是周一（切换日之后的第一个交易日）。 */
const SAT_CUTOVER = '2026-11-07T12:00:00+08:00';
const MON_OPEN = '2026-11-09T10:15:30+08:00';
const TUE = '2026-11-10T10:15:30+08:00';

function legacyState(extra) {
  return Object.assign({
    version: 2,
    day: '2026-11-10',
    market: { netBuy: 0, buyVol: 0, sellVol: 0, updatedAt: 0 },
    orders: [],
    lastSettleDay: '2026-11-10',
    users: {}
  }, extra || {});
}

(async function main() {
  console.log('黑塔币 · 每日密钥（CUTOVER=' + CUTOVER + '）');
  console.log('');

  /* ============ 一、切换日之前：一个字节都不许变 ============ */
  check('派生字符串：切换日前后按设计文档分叉', () => {
    assert.equal(core.daySeed('2026-11-06', 'xyz'), 'HTC|daily|2026-11-06');
    assert.equal(core.daySeed('2026-11-07', 'xyz'), 'HTC|daily|2026-11-07|xyz');
    assert.equal(core.daySeed('2026-11-09', 'xyz'), 'HTC|daily|2026-11-09|xyz');
    assert.equal(core.planSeed('2026-11-06', 'xyz'), 'HTC|intraday|2026-11-06');
    assert.equal(core.planSeed('2026-11-07', 'xyz'), 'HTC|intraday|2026-11-07|xyz');
  });

  check('旧日期：getSecret 一次都不会被调用，价格与向量逐位一致', () => {
    const boom = function () { throw new Error('切换日之前的日期不该问密钥'); };
    for (const vector of VECTORS) {
      const res = core.buildDailyResponse(Date.parse(vector.now), boom);
      assert.equal(res.market.sessionDate, vector.sessionDate);
      close(res.market.close, vector.close, vector.now + ' close');
      assert.equal(res.market.bars.length, vector.bars.length);
      for (let i = 0; i < vector.bars.length; i++) {
        close(res.market.bars[i].c, vector.bars[i].c, vector.now + ' bars[' + i + '].c');
      }
    }
  });

  check('旧日期的 /api/daily：不碰存储也能出图（周末/盘前/盘中都试一遍）', async () => {
    for (const iso of ['2026-10-29T10:15:30+08:00', '2026-10-31T12:00:00+08:00', '2026-11-06T16:00:00+08:00']) {
      seedsLib._resetMemoForTest();
      const env = makeEnv(iso);
      const res = await env.call('GET', '/api/daily');
      assert.equal(res.status, 200, iso + ' 应 200');
      assert.ok(Array.isArray(res.json.market.bars) && res.json.market.bars.length > 0, iso + ' 应有 bars');
      assert.equal(await env.store.read(), null, iso + ' 不该建账本');
    }
  });

  /* ============ 二、切换日起：没有密钥就开不了盘 ============ */
  check('切换日起没有密钥 -> missing_secret（503），不派生备用钥匙', () => {
    let err = null;
    try {
      core.buildDailyResponse(Date.parse(MON_OPEN));
    } catch (e) {
      err = e;
    }
    assert.ok(err, '应该抛错');
    assert.equal(err.code, 'missing_secret');
    assert.equal(err.status, 503);
    assert.ok(/密钥/.test(err.message), '错误信息要说人话：' + err.message);
  });

  check('同一把密钥 -> 同一条行情；换一把 -> 另一条线（缓存也按密钥分开）', () => {
    const at = Date.parse(MON_OPEN);
    const s1 = 'a'.repeat(32);
    const s2 = 'b'.repeat(32);
    const one = core.buildDailyResponse(at, (d) => (d === '2026-11-09' ? s1 : null));
    const again = core.buildDailyResponse(at, (d) => (d === '2026-11-09' ? s1 : null));
    const other = core.buildDailyResponse(at, (d) => (d === '2026-11-09' ? s2 : null));
    close(again.market.close, one.market.close, '同一密钥');
    assert.deepEqual(again.market.bars, one.market.bars);
    assert.equal(one.market.status, 'trading');
    assert.notEqual(other.market.close, one.market.close, '换密钥后价格应该变');
  });

  /* ============ 三、/api/seeds 的窗口 ============ */
  await checkAsync('切换日当天（周六）：只有周末，不发密钥、不落库', async () => {
    seedsLib._resetMemoForTest();
    const env = makeEnv(SAT_CUTOVER);
    const res = await env.call('GET', '/api/seeds', { from: CUTOVER });
    assert.equal(res.status, 200);
    assert.equal(res.json.version, 1);
    assert.equal(res.json.cutover, CUTOVER);
    assert.deepEqual(res.json.seeds, {});
    assert.equal(await env.store.read(), null, '不该为空窗口建账本');
  });

  await checkAsync('from 早于切换日 -> 按切换日回，不生成切换日之前的密钥', async () => {
    seedsLib._resetMemoForTest();
    const env = makeEnv(MON_OPEN);
    const res = await env.call('GET', '/api/seeds', { from: '2026-01-05' });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json.seeds), ['2026-11-09']);
    for (const date of Object.keys(res.json.seeds)) {
      assert.ok(date >= CUTOVER, '不该出现切换日之前的日期：' + date);
      assert.ok(SEED_RE.test(res.json.seeds[date]), '密钥要 32 位小写 hex：' + res.json.seeds[date]);
    }
    const state = await env.store.read();
    assert.deepEqual(Object.keys(state.seeds), ['2026-11-09'], '账本里也只有切换日之后的密钥');
  });

  await checkAsync('周末不发：周一只发周一，11-07 / 11-08 都不出现', async () => {
    seedsLib._resetMemoForTest();
    const env = makeEnv(MON_OPEN);
    const res = await env.call('GET', '/api/seeds', { from: CUTOVER });
    assert.deepEqual(Object.keys(res.json.seeds), ['2026-11-09']);
    assert.equal(res.json.seeds['2026-11-07'], undefined);
    assert.equal(res.json.seeds['2026-11-08'], undefined);
  });

  await checkAsync('from 晚于今天 -> 空表，且不动账本', async () => {
    seedsLib._resetMemoForTest();
    const env = makeEnv(MON_OPEN);
    const res = await env.call('GET', '/api/seeds', { from: '2026-12-01' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.seeds, {});
    assert.equal(await env.store.read(), null);
  });

  await checkAsync('只发交易日：周二发 11-09 + 11-10 两把，互不相同', async () => {
    seedsLib._resetMemoForTest();
    const env = makeEnv(TUE);
    const res = await env.call('GET', '/api/seeds', { from: CUTOVER });
    assert.deepEqual(Object.keys(res.json.seeds), ['2026-11-09', '2026-11-10']);
    const values = Object.values(res.json.seeds);
    assert.equal(new Set(values).size, values.length, '每天的密钥应该不一样');
    for (const seed of values) assert.ok(SEED_RE.test(seed), '密钥格式：' + seed);
  });

  /* ============ 四、同一日期只生成一次 ============ */
  await checkAsync('重复调用不换密钥：两次一样，账本里也只留一把', async () => {
    seedsLib._resetMemoForTest();
    const env = makeEnv(MON_OPEN);
    const first = await env.call('GET', '/api/seeds', { from: CUTOVER });
    const seed = first.json.seeds['2026-11-09'];
    assert.ok(SEED_RE.test(seed), '密钥格式：' + seed);

    seedsLib._resetMemoForTest(); // 模拟冷启动 / 换一个实例：只能靠落盘的
    const second = await env.call('GET', '/api/seeds', { from: CUTOVER });
    assert.deepEqual(second.json.seeds, first.json.seeds, '重算了一遍却换了密钥');

    const third = await env.call('GET', '/api/seeds', { from: CUTOVER });
    assert.deepEqual(third.json.seeds, first.json.seeds);

    const state = await env.store.read();
    assert.equal(state.seeds['2026-11-09'], seed, '账本里的密钥要与下发的一致');
    assert.equal(Object.keys(state.seeds).length, 1, '账本里不该堆重复密钥');
  });

  await checkAsync('旧状态没有 seeds：按空对象处理，补上之后别的字段不动（不清库）', async () => {
    seedsLib._resetMemoForTest();
    const legacy = legacyState({
      users: { 梦源: { name: '梦源', htc: 1000, usdt: 100000, cost: 89 } }
    });
    assert.equal(legacy.seeds, undefined);
    const env = makeEnv(TUE, createMemoryStore(legacy));
    const res = await env.call('GET', '/api/seeds', { from: CUTOVER });
    assert.deepEqual(Object.keys(res.json.seeds), ['2026-11-09', '2026-11-10']);
    const state = await env.store.read();
    assert.equal(state.users['梦源'].htc, 1000, '用户数据不该被清');
    assert.equal(state.day, '2026-11-10');
    assert.deepEqual(Object.keys(state.seeds), ['2026-11-09', '2026-11-10']);
  });

  await checkAsync('账本里已有的密钥优先，不重摇（老账本升级的路径）', async () => {
    seedsLib._resetMemoForTest();
    const fixed = 'c'.repeat(32);
    const env = makeEnv(TUE, createMemoryStore(legacyState({ seeds: { '2026-11-10': fixed } })));
    const res = await env.call('GET', '/api/seeds', { from: CUTOVER });
    assert.equal(res.json.seeds['2026-11-10'], fixed, '已有的密钥被换掉了');
    assert.ok(SEED_RE.test(res.json.seeds['2026-11-09']), '缺的那天应该当场补上');
    const state = await env.store.read();
    assert.equal(state.seeds['2026-11-10'], fixed);
  });

  await checkAsync('坏密钥（格式不对）会被换成合法的', async () => {
    seedsLib._resetMemoForTest();
    const env = makeEnv(MON_OPEN, createMemoryStore(legacyState({ seeds: { '2026-11-09': '明文不合法' } })));
    const res = await env.call('GET', '/api/seeds', { from: CUTOVER });
    const seed = res.json.seeds['2026-11-09'];
    assert.ok(SEED_RE.test(seed), '应该换成 32 位 hex：' + seed);
    assert.equal((await env.store.read()).seeds['2026-11-09'], seed);
  });

  await checkAsync('参数与方法：非法 from -> 400；POST -> 405', async () => {
    seedsLib._resetMemoForTest();
    const env = makeEnv(MON_OPEN);
    const bad = await env.call('GET', '/api/seeds', { from: '11-07' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_from');
    const posted = await env.call('POST', '/api/seeds', {});
    assert.equal(posted.status, 405);
  });

  /* ============ 五、其它接口改吃 seeds，响应形状不变 ============ */
  await checkAsync('/api/daily：切换日起用盘上那把你算出来的密钥，bars 保留', async () => {
    seedsLib._resetMemoForTest();
    const env = makeEnv(MON_OPEN);
    const daily = await env.call('GET', '/api/daily');
    assert.equal(daily.status, 200, JSON.stringify(daily.json).slice(0, 200));

    const state = await env.store.read();
    const seed = state.seeds['2026-11-09'];
    assert.ok(SEED_RE.test(seed), '算行情时应该已经把密钥落库：' + seed);

    // 用同一把密钥直接算 -> 必须与 HTTP 层一模一样；换一把 -> 必须不一样
    const same = core.buildDailyResponse(Date.parse(MON_OPEN), (d) => (d === '2026-11-09' ? seed : null));
    close(daily.json.market.close, same.market.close, '/api/daily close');
    assert.deepEqual(daily.json.market.bars, same.market.bars);
    const other = core.buildDailyResponse(Date.parse(MON_OPEN), (d) => (d === '2026-11-09' ? 'd'.repeat(32) : null));
    assert.notEqual(other.market.close, daily.json.market.close, '行情不该与密钥无关');

    assert.ok(Array.isArray(daily.json.market.bars) && daily.json.market.bars.length === 46);
    assert.ok(daily.json.news && Array.isArray(daily.json.news.items), '快讯还在');

    // 再取一次 /api/seeds：必须就是盘上那一把
    const seeds = await env.call('GET', '/api/seeds', { from: CUTOVER });
    assert.equal(seeds.json.seeds['2026-11-09'], seed);
  });

  await checkAsync('/api/daily：同一天重复请求价格不漂（30s 轮询）', async () => {
    seedsLib._resetMemoForTest();
    const env = makeEnv(MON_OPEN);
    const one = await env.call('GET', '/api/daily');
    const two = await env.call('GET', '/api/daily');
    assert.deepEqual(two.json.market.bars, one.json.market.bars);
    assert.equal(two.json.market.close, one.json.market.close);
  });

  await checkAsync('/api/state 与 /api/trade：账务照旧，密钥不漏给客户端', async () => {
    seedsLib._resetMemoForTest();
    const env = makeEnv(MON_OPEN);
    const state = await env.call('GET', '/api/state', { user: '梦源' });
    assert.equal(state.status, 200);
    assert.equal(state.json.user.name, '梦源');
    assert.equal(state.json.user.htc, 1000);
    assert.equal(state.json.market.status, 'trading');
    assert.ok(state.text.indexOf('seeds') === -1, '/api/state 不该泄露 seeds');

    const seedInState = (await env.store.read()).seeds['2026-11-09'];
    assert.ok(SEED_RE.test(seedInState), '示例账本应该带上密钥');

    // 正常下单：账务照旧，密钥还在
    const traded = await env.post('/api/trade', { user: '梦源', side: 'buy', amount: 10 });
    assert.equal(traded.status, 200, JSON.stringify(traded.json).slice(0, 200));
    assert.equal(traded.json.ok, true);
    assert.equal(traded.json.user.htc, 1010);
    assert.equal(traded.json.user.usdt < 100000, true);
    const after = await env.store.read();
    assert.equal(after.seeds['2026-11-09'], seedInState, '交易写盘不许把密钥冲掉');
  });

  await checkAsync('账本被老代码抹掉 seeds 后：行情仍按备忘里的密钥算，下次写盘补回来', async () => {
    seedsLib._resetMemoForTest();
    const env = makeEnv(MON_OPEN);
    const first = await env.call('GET', '/api/daily');
    const seed = (await env.store.read()).seeds['2026-11-09'];

    // 模拟「别的实例 / 老代码」把 seeds 洗掉（行情不能因此换条线）
    const wiped = await env.store.read();
    delete wiped.seeds;
    await env.store.write(wiped);

    const again = await env.call('GET', '/api/daily');
    assert.equal(again.json.market.close, first.json.market.close, '价格不该因为丢 seeds 换条线');
    assert.equal((await env.store.read()).seeds, undefined, '/api/daily 是只读的，不该顺手写盘');

    // 任何一次写盘的接口都顺手把密钥补回去
    const traded = await env.post('/api/trade', { user: '梦源', side: 'buy', amount: 10 });
    assert.equal(traded.status, 200);
    const restored = await env.store.read();
    assert.equal(restored.seeds['2026-11-09'], seed, '写盘时应该补回同一把');
    assert.equal(restored.users['梦源'].htc, 1010);
  });

  console.log('');
  console.log('结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('测试崩溃：', e);
  process.exit(1);
});
