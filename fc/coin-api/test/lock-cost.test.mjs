/*
 * 黑塔币 · 存储往返次数 & 可选鉴权测试
 *
 * 目标：
 *   1. 冷实例（memo 空）时，密钥已在盘上 → /api/daily 只允许 1 次 GET，不许抢锁；
 *   2. 同实例第二次请求（memo 热）→ /api/daily 一次 OSS 都不碰；
 *   3. /api/leaderboard 只读一次账本（不再「算行情读一次 + 取状态又读一次」）；
 *   4. 真的缺密钥时才进锁（保证价格历史不漂）；
 *   5. API_TOKEN 设了才校验，不设行为和以前一致。
 *
 * 运行：node test/lock-cost.test.mjs
 */
'use strict';

import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHandler } = require('../index.js');
const seedsLib = require('../seeds.js');
const { createState } = require('../market-v2.js');

let pass = 0, fail = 0;

async function check(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' -> ' + (e && e.message)); }
}

const SEED_A = 'a'.repeat(32);

function countingStore(initial) {
  let state = initial ? JSON.parse(JSON.stringify(initial)) : null;
  const ops = { read: 0, write: 0, lock: 0 };
  return {
    ops,
    async read() { ops.read++; return state ? JSON.parse(JSON.stringify(state)) : null; },
    async write(next) { ops.write++; state = JSON.parse(JSON.stringify(next)); },
    async withLock(fn) { ops.lock++; return fn(); },
    snapshot() { return state ? JSON.parse(JSON.stringify(state)) : null; }
  };
}

function makeEnv(nowIso, store) {
  const env = { ms: Date.parse(nowIso), store };
  env.handler = createHandler({ now: () => env.ms, storeFactory: () => env.store });
  env.call = async function (method, path, query, bodyObj) {
    const event = {
      httpMethod: method, path: path, rawPath: path,
      queryParameters: query || {}, queryStringParameters: query || {},
      headers: {},
      body: bodyObj === undefined ? '' : JSON.stringify(bodyObj),
      isBase64Encoded: false,
      requestContext: { http: { method: method, path: path } }
    };
    const res = await env.handler(event, { requestId: 'lock-cost-test' });
    let json = null;
    try { json = JSON.parse(res.body || 'null'); } catch (e) { json = null; }
    return { status: res.statusCode, headers: res.headers, json: json };
  };
  return env;
}

function stateWithSeed(sessionDate) {
  const st = createState(sessionDate);
  st.seeds = {};
  st.seeds[sessionDate] = SEED_A;
  return st;
}

const NOW = '2026-11-09T10:15:30+08:00';   // 周一，交易日
const SESSION = '2026-11-09';

await check('冷实例 /api/daily：密钥在盘上 → 1 次读、0 次抢锁', async () => {
  seedsLib._resetMemoForTest();
  const store = countingStore(stateWithSeed(SESSION));
  const env = makeEnv(NOW, store);
  const r = await env.call('GET', '/api/daily');
  assert.equal(r.status, 200, 'HTTP 状态');
  assert.ok(r.json && r.json.market, '返回行情');
  assert.equal(store.ops.lock, 0, '不应抢锁，实际 ' + store.ops.lock);
  assert.equal(store.ops.read, 1, '应只读 1 次，实际 ' + store.ops.read);
  assert.equal(store.ops.write, 0, '不应写盘，实际 ' + store.ops.write);
});

await check('memo 热了以后 /api/daily：0 次存储往返', async () => {
  const store = countingStore(stateWithSeed(SESSION));
  const env = makeEnv(NOW, store);   // memo 已在上一条里被填热
  const r = await env.call('GET', '/api/daily');
  assert.equal(r.status, 200);
  assert.equal(store.ops.read + store.ops.write + store.ops.lock, 0,
    '应零往返，实际 read=' + store.ops.read + ' write=' + store.ops.write + ' lock=' + store.ops.lock);
});

await check('/api/leaderboard：只读一次账本，不抢锁', async () => {
  seedsLib._resetMemoForTest();
  const store = countingStore(stateWithSeed(SESSION));
  const env = makeEnv(NOW, store);
  const r = await env.call('GET', '/api/leaderboard');
  assert.equal(r.status, 200);
  assert.equal(store.ops.lock, 0, '不应抢锁');
  assert.equal(store.ops.read, 1, '应只读 1 次，实际 ' + store.ops.read);
});

await check('/api/state（已建号用户）：只读一次账本，不抢锁', async () => {
  seedsLib._resetMemoForTest();
  const store = countingStore(stateWithSeed(SESSION));
  const env = makeEnv(NOW, store);
  // 先正常建号（会走写路径）
  const first = await env.call('POST', '/api/signin', undefined, { user: '测试' });
  assert.equal(first.status, 200, '建号应成功：' + JSON.stringify(first.json).slice(0, 120));
  // 先读一次把「成就解锁」等 dirty 项结算掉（新号第一次必 dirty，属预期）
  const warm = await env.call('GET', '/api/state', { user: '测试' });
  assert.equal(warm.status, 200);
  // 归零计数 + 清 memo，模拟「换了个冷实例再请求」
  store.ops.read = 0; store.ops.write = 0; store.ops.lock = 0;
  seedsLib._resetMemoForTest();
  const r = await env.call('GET', '/api/state', { user: '测试' });
  assert.equal(r.status, 200);
  assert.equal(store.ops.lock, 0, '快路径不应抢锁，实际 ' + store.ops.lock);
  assert.equal(store.ops.read, 1, '应只读 1 次，实际 ' + store.ops.read);
});

await check('真的缺密钥时仍然进锁并落盘（价格历史不漂）', async () => {
  seedsLib._resetMemoForTest();
  const store = countingStore(null);            // 全空
  const env = makeEnv(NOW, store);
  const r = await env.call('GET', '/api/daily');
  assert.equal(r.status, 200);
  assert.equal(store.ops.lock, 1, '应抢锁 1 次，实际 ' + store.ops.lock);
  assert.equal(store.ops.write, 1, '应写盘 1 次，实际 ' + store.ops.write);
  const snap = store.snapshot();
  assert.ok(snap && snap.seeds && /^[0-9a-f]{32}$/.test(snap.seeds[SESSION]), '密钥应已落盘');
  // 第二次必须用盘上那把，不再重摇
  const r2 = await env.call('GET', '/api/daily');
  assert.equal(r2.status, 200);
  assert.equal(r2.json.market.close, r.json.market.close, '同一天两次价格必须一致');
});

await check('API_TOKEN 未设置时：不校验（老客户端不受影响）', async () => {
  delete process.env.API_TOKEN;
  seedsLib._resetMemoForTest();
  const store = countingStore(stateWithSeed(SESSION));
  const env = makeEnv(NOW, store);
  const r = await env.call('GET', '/api/daily');
  assert.equal(r.status, 200);
});

await check('API_TOKEN 设置后：无令牌 401，带令牌 200', async () => {
  process.env.API_TOKEN = 'secret-token-123';
  try {
    seedsLib._resetMemoForTest();
    const store = countingStore(stateWithSeed(SESSION));
    const env = makeEnv(NOW, store);
    const bad = await env.call('GET', '/api/daily');
    assert.equal(bad.status, 401, '无令牌应 401，实际 ' + bad.status);
    assert.equal(bad.json.error, 'unauthorized');
    const wrong = await env.call('GET', '/api/daily', { k: 'nope' });
    assert.equal(wrong.status, 401, '错令牌应 401');
    const good = await env.call('GET', '/api/daily', { k: 'secret-token-123' });
    assert.equal(good.status, 200, '正确令牌应 200，实际 ' + good.status);
  } finally {
    delete process.env.API_TOKEN;
  }
});

await check('公开接口带秒级缓存头，personal 响应仍 no-store', async () => {
  seedsLib._resetMemoForTest();
  const store = countingStore(stateWithSeed(SESSION));
  const env = makeEnv(NOW, store);
  const daily = await env.call('GET', '/api/daily');
  assert.match(String(daily.headers['Cache-Control']), /max-age=3/, 'daily 应可缓存 3 秒');
  const lb = await env.call('GET', '/api/leaderboard');
  assert.match(String(lb.headers['Cache-Control']), /max-age=2/, '排行榜应可缓存 2 秒');
  const st = await env.call('GET', '/api/state', { user: '测试' });
  assert.equal(st.headers['Cache-Control'], 'no-store', '带 user 的响应不许缓存');
});

await check('令牌写进路径 /t/<token>/api/… ：地址里带令牌也能过', async () => {
  process.env.API_TOKEN = 'secret-token-123';
  try {
    seedsLib._resetMemoForTest();
    const store = countingStore(stateWithSeed(SESSION));
    const env = makeEnv(NOW, store);
    const good = await env.call('GET', '/t/secret-token-123/api/daily');
    assert.equal(good.status, 200, '前缀带正确令牌应 200，实际 ' + good.status);
    assert.ok(good.json && good.json.market, '应返回行情');
    const bad = await env.call('GET', '/t/wrong/api/daily');
    assert.equal(bad.status, 401, '前缀带错令牌应 401，实际 ' + bad.status);
    const none = await env.call('GET', '/api/daily');
    assert.equal(none.status, 401, '不带令牌应 401');
    // 前缀不能把正常路由搞坏
    const lb = await env.call('GET', '/t/secret-token-123/api/leaderboard');
    assert.equal(lb.status, 200, '前缀下排行榜也应 200，实际 ' + lb.status);
  } finally {
    delete process.env.API_TOKEN;
  }
});

await check('没设 API_TOKEN 时 /t/ 前缀不影响老客户端', async () => {
  delete process.env.API_TOKEN;
  seedsLib._resetMemoForTest();
  const store = countingStore(stateWithSeed(SESSION));
  const env = makeEnv(NOW, store);
  const r = await env.call('GET', '/t/whatever/api/daily');
  assert.equal(r.status, 200, '无令牌模式下前缀应直接放行，实际 ' + r.status);
});

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
