/*
 * 黑塔币 · 用户密钥（AUTH_MODE）测试
 *
 * 覆盖：
 *   1. off（默认）：行为和以前一模一样，/api/bind 明确告诉你没开；
 *   2. lenient：没绑定的号放行（迁移期），绑定后必须带钥匙；
 *   3. strict：没绑定直接 403，不再自动放行；
 *   4. 钥匙只能开自己那把锁：拿 A 的钥匙动 B 一律 401；
 *   5. 账本里只存哈希，明文只在绑定响应里出现一次；
 *   6. 换发要 ADMIN_KEY。
 *
 * 运行：node test/auth.test.mjs
 */
'use strict';

import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHandler } = require('../index.js');
const seedsLib = require('../seeds.js');
const auth = require('../auth.js');
const { createState } = require('../market-v2.js');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' -> ' + (e && e.message)); }
}

const SEED_A = 'a'.repeat(32);
const NOW = '2026-11-09T10:15:30+08:00';
const SESSION = '2026-11-09';

function countingStore(initial) {
  let state = initial ? JSON.parse(JSON.stringify(initial)) : null;
  return {
    async read() { return state ? JSON.parse(JSON.stringify(state)) : null; },
    async write(next) { state = JSON.parse(JSON.stringify(next)); },
    async withLock(fn) { return fn(); },
    snapshot() { return state ? JSON.parse(JSON.stringify(state)) : null; }
  };
}

function stateWithSeed(sessionDate) {
  const st = createState(sessionDate);
  st.seeds = {};
  st.seeds[sessionDate] = SEED_A;
  return st;
}

function makeEnv(nowIso, store) {
  const env = { ms: Date.parse(nowIso), store };
  env.handler = createHandler({ now: () => env.ms, storeFactory: () => env.store });
  env.call = async function (method, path, query, bodyObj, headers) {
    const event = {
      httpMethod: method, path: path, rawPath: path,
      queryParameters: query || {}, queryStringParameters: query || {},
      headers: headers || {},
      body: bodyObj === undefined ? '' : JSON.stringify(bodyObj),
      isBase64Encoded: false,
      requestContext: { http: { method: method, path: path } }
    };
    const res = await env.handler(event, { requestId: 'auth-test' });
    let json = null;
    try { json = JSON.parse(res.body || 'null'); } catch (e) { json = null; }
    return { status: res.statusCode, json: json };
  };
  return env;
}

function freshEnv() {
  seedsLib._resetMemoForTest();
  const store = countingStore(stateWithSeed(SESSION));
  return { store, env: makeEnv(NOW, store) };
}

function withMode(mode, fn) {
  return async () => {
    const prev = process.env.AUTH_MODE;
    process.env.AUTH_MODE = mode;
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = prev;
    }
  };
}

/* ------------------------------------------------------------ off 模式 */

await check('off：老行为不变，任何人不带钥匙都能读', withMode('off', async () => {
  const { env } = freshEnv();
  const a = await env.call('GET', '/api/state', { user: '甲' });
  assert.equal(a.status, 200, '建号应成功');
  const b = await env.call('GET', '/api/state', { user: '甲' });
  assert.equal(b.status, 200, '不带钥匙也应 200（off 模式）');
}));

await check('off：/api/bind 明确拒绝，不会悄悄给钥匙', withMode('off', async () => {
  const { env } = freshEnv();
  const r = await env.call('POST', '/api/bind', undefined, { user: '甲' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'auth_disabled');
}));

/* -------------------------------------------------------- lenient 模式 */

await check('lenient：没绑定的号先放行，绑完之后必须带钥匙', withMode('lenient', async () => {
  const { env, store } = freshEnv();
  const before = await env.call('GET', '/api/state', { user: '甲' });
  assert.equal(before.status, 200, '迁移期未绑定应放行');

  const bound = await env.call('POST', '/api/bind', undefined, { user: '甲' });
  assert.equal(bound.status, 200, '绑定应成功：' + JSON.stringify(bound.json).slice(0, 120));
  const secret = bound.json.secret;
  assert.ok(auth.isSecret(secret), '应返回 48 位 hex 密钥');

  const noKey = await env.call('GET', '/api/state', { user: '甲' });
  assert.equal(noKey.status, 401, '绑定后不带钥匙应 401，实际 ' + noKey.status);

  const wrong = await env.call('GET', '/api/state', { user: '甲' }, undefined, { 'x-herta-key': 'f'.repeat(48) });
  assert.equal(wrong.status, 401, '错钥匙应 401');

  const ok = await env.call('GET', '/api/state', { user: '甲' }, undefined, { 'x-herta-key': secret });
  assert.equal(ok.status, 200, '对钥匙应 200，实际 ' + ok.status);

  // 账本里只能是哈希
  const snap = store.snapshot();
  const stored = snap.users['甲'].auth;
  assert.ok(stored && stored.hash && stored.salt, '账本里应有 salt + hash');
  assert.notEqual(stored.hash, secret, '账本不能存明文');
  assert.equal(JSON.stringify(snap).indexOf(secret) >= 0, false, '整份账本里都不许出现明文钥匙');
}));

await check('lenient：钥匙只能开自己的号，拿甲的钥匙动乙 401', withMode('lenient', async () => {
  const { env } = freshEnv();
  await env.call('GET', '/api/state', { user: '甲' });
  await env.call('GET', '/api/state', { user: '乙' });
  const a = await env.call('POST', '/api/bind', undefined, { user: '甲' });
  const b = await env.call('POST', '/api/bind', undefined, { user: '乙' });
  const cross = await env.call('GET', '/api/state', { user: '乙' }, undefined, { 'x-herta-key': a.json.secret });
  assert.equal(cross.status, 401, '串号用钥匙应 401，实际 ' + cross.status);
  const right = await env.call('GET', '/api/state', { user: '乙' }, undefined, { 'x-herta-key': b.json.secret });
  assert.equal(right.status, 200, '自己的钥匙应 200');
}));

await check('lenient：交易接口也要带钥匙', withMode('lenient', async () => {
  const { env } = freshEnv();
  await env.call('GET', '/api/state', { user: '甲' });
  const bound = await env.call('POST', '/api/bind', undefined, { user: '甲' });
  const secret = bound.json.secret;
  const noKey = await env.call('POST', '/api/trade', undefined, { user: '甲', side: 'buy', amount: 10 });
  assert.equal(noKey.status, 401, '没钥匙不能下单，实际 ' + noKey.status);
  assert.equal(noKey.json.error, 'bad_key');
  const withKey = await env.call('POST', '/api/trade', undefined, { user: '甲', side: 'buy', amount: 10 }, { 'x-herta-key': secret });
  assert.notEqual(withKey.status, 401, '带钥匙不该被鉴权挡住');
}));

/* --------------------------------------------------------- strict 模式 */

await check('strict：没绑定的号直接 403，不再放行', withMode('strict', async () => {
  const { env } = freshEnv();
  const r = await env.call('GET', '/api/state', { user: '丙' });
  assert.equal(r.status, 403, '未绑定应 403，实际 ' + r.status);
  assert.equal(r.json.error, 'not_bound');
}));

await check('strict：绑定后正常，换发后旧钥匙立即失效', withMode('strict', async () => {
  process.env.ADMIN_KEY = 'admin-secret-9';
  try {
    const { env } = freshEnv();
    const bound = await env.call('POST', '/api/bind', undefined, { user: '丁' });
    assert.equal(bound.status, 200, 'strict 下也要能绑定：' + JSON.stringify(bound.json).slice(0, 120));
    const oldKey = bound.json.secret;
    const ok = await env.call('GET', '/api/state', { user: '丁' }, undefined, { 'x-herta-key': oldKey });
    assert.equal(ok.status, 200, '新钥匙应可用');

    const reset = await env.call('POST', '/api/bind/reset', undefined, { user: '丁', adminKey: 'admin-secret-9' });
    assert.equal(reset.status, 200, '换发应成功：' + JSON.stringify(reset.json).slice(0, 120));
    const newKey = reset.json.secret;
    assert.ok(auth.isSecret(newKey) && newKey !== oldKey, '应换了一把新钥匙');

    const stale = await env.call('GET', '/api/state', { user: '丁' }, undefined, { 'x-herta-key': oldKey });
    assert.equal(stale.status, 401, '旧钥匙换发后必须失效，实际 ' + stale.status);
    const fresh = await env.call('GET', '/api/state', { user: '丁' }, undefined, { 'x-herta-key': newKey });
    assert.equal(fresh.status, 200, '新钥匙应可用');
  } finally {
    delete process.env.ADMIN_KEY;
  }
}));

await check('换发密钥：没有 ADMIN_KEY 一律 403', withMode('strict', async () => {
  delete process.env.ADMIN_KEY;
  const { env } = freshEnv();
  const r = await env.call('POST', '/api/bind/reset', undefined, { user: '戊', adminKey: '乱写' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden');
}));

/* ------------------------------------------------------------ 小细节 */

await check('已绑定的号再 /api/bind：没钥匙 409，有钥匙重取返回 secret=null', withMode('lenient', async () => {
  const { env } = freshEnv();
  await env.call('GET', '/api/state', { user: '己' });
  const first = await env.call('POST', '/api/bind', undefined, { user: '己' });
  const secret = first.json.secret;
  const again = await env.call('POST', '/api/bind', undefined, { user: '己' });
  assert.equal(again.status, 409, '没钥匙重绑应 409');
  assert.equal(again.json.error, 'already_bound');
  const mine = await env.call('POST', '/api/bind', undefined, { user: '己' }, { 'x-herta-key': secret });
  assert.equal(mine.status, 200, '自己的钥匙应能重取');
  assert.equal(mine.json.secret, null, '重取不再返回明文');
}));

await check('钥匙可以从 ?key= 传（改不了原生层的客户端兜底）', withMode('lenient', async () => {
  const { env } = freshEnv();
  await env.call('GET', '/api/state', { user: '庚' });
  const bound = await env.call('POST', '/api/bind', undefined, { user: '庚' });
  const r = await env.call('GET', '/api/state', { user: '庚', key: bound.json.secret });
  assert.equal(r.status, 200, '?key= 应可用，实际 ' + r.status);
}));

await check('Authorization: Bearer 也认', withMode('lenient', async () => {
  const { env } = freshEnv();
  await env.call('GET', '/api/state', { user: '辛' });
  const bound = await env.call('POST', '/api/bind', undefined, { user: '辛' });
  const r = await env.call('GET', '/api/state', { user: '辛' }, undefined,
    { Authorization: 'Bearer ' + bound.json.secret });
  assert.equal(r.status, 200, 'Bearer 应可用，实际 ' + r.status);
}));

await check('公开接口不受影响：daily / leaderboard / seeds 不需要钥匙', withMode('strict', async () => {
  const { env } = freshEnv();
  assert.equal((await env.call('GET', '/api/daily')).status, 200, 'daily 应公开');
  assert.equal((await env.call('GET', '/api/leaderboard')).status, 200, '排行应公开');
  assert.equal((await env.call('GET', '/api/seeds')).status, 200, '密钥表应公开');
}));

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
