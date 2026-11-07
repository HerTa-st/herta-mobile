/*
 * 黑塔币 · 限流测试
 *
 * 运行：node test/ratelimit.test.mjs
 */
'use strict';

import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHandler } = require('../index.js');
const seedsLib = require('../seeds.js');
const ratelimit = require('../ratelimit.js');
const { createState } = require('../market-v2.js');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' -> ' + (e && e.message)); }
}

const SEED_A = 'a'.repeat(32);
const NOW = '2026-11-09T10:15:30+08:00';
const SESSION = '2026-11-09';

function makeEnv(ip) {
  seedsLib._resetMemoForTest();
  ratelimit._resetForTest();
  const st = createState(SESSION);
  st.seeds = {}; st.seeds[SESSION] = SEED_A;
  let state = JSON.parse(JSON.stringify(st));
  const store = {
    async read() { return JSON.parse(JSON.stringify(state)); },
    async write(n) { state = JSON.parse(JSON.stringify(n)); },
    async withLock(fn) { return fn(); }
  };
  const ms = Date.parse(NOW);
  const handler = createHandler({ now: () => ms, storeFactory: () => store });
  return async function call(path, query) {
    const res = await handler({
      httpMethod: 'GET', path: path, rawPath: path,
      queryParameters: query || {}, queryStringParameters: query || {},
      headers: {}, body: '', isBase64Encoded: false,
      requestContext: { http: { method: 'GET', path: path, sourceIp: ip || '1.1.1.1' } }
    }, { requestId: 'rl-test' });
    return res;
  };
}

function withEnv(vars, fn) {
  return async () => {
    const prev = {};
    for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = String(vars[k]); }
    try { await fn(); } finally {
      for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    }
  };
}

await check('RATE_LIMIT=off 时完全不限', withEnv({ RATE_LIMIT: 'off' }, async () => {
  const call = makeEnv();
  for (let i = 0; i < 30; i++) {
    const r = await call('/api/daily');
    assert.equal(r.statusCode, 200, '不应被限流');
  }
}));

await check('单 IP：超过配额回 429，带 Retry-After', withEnv({ RATE_IP_PER_MIN: 3 }, async () => {
  const call = makeEnv('2.2.2.2');
  for (let i = 0; i < 3; i++) assert.equal((await call('/api/daily')).statusCode, 200, '前 3 次应放行');
  const r = await call('/api/daily');
  assert.equal(r.statusCode, 429, '第 4 次应 429，实际 ' + r.statusCode);
  const body = JSON.parse(r.body);
  assert.equal(body.error, 'rate_limited');
  assert.equal(body.scope, 'ip');
  assert.ok(Number(r.headers['Retry-After']) >= 1, '应有 Retry-After');
}));

await check('换一个 IP 不受别人影响', withEnv({ RATE_IP_PER_MIN: 2 }, async () => {
  const a = makeEnv('3.3.3.3');
  for (let i = 0; i < 2; i++) await a('/api/daily');
  assert.equal((await a('/api/daily')).statusCode, 429, 'A 应被限');
  const b = await a('/api/daily');   // 同实例同 IP，仍被限
  assert.equal(b.statusCode, 429);
  // 同实例换 IP：重建 handler 会清计数器，所以这里直接验证单 IP 计数是分键的
  assert.equal(ratelimit.check({ ip: '3.3.3.3' }, Date.now()).ok, false, 'A 的桶应已满');
  assert.equal(ratelimit.check({ ip: '4.4.4.4' }, Date.now()).ok, true, 'B 的桶应是空的');
}));

await check('单用户：同一个昵称被单独计数', withEnv({ RATE_IP_PER_MIN: 999, RATE_USER_PER_MIN: 2 }, async () => {
  const call = makeEnv('5.5.5.5');
  for (let i = 0; i < 2; i++) assert.equal((await call('/api/state', { user: '甲' })).statusCode, 200);
  const r = await call('/api/state', { user: '甲' });
  assert.equal(r.statusCode, 429, '同一个人第 3 次应 429，实际 ' + r.statusCode);
  assert.equal(JSON.parse(r.body).scope, 'user');
}));

await check('全局：总量超了连新 IP 一起挡（钱包闸门）', withEnv({ RATE_GLOBAL_PER_MIN: 3, RATE_IP_PER_MIN: 999, RATE_USER_PER_MIN: 999 }, async () => {
  const call = makeEnv('6.6.6.6');
  for (let i = 0; i < 3; i++) assert.equal((await call('/api/daily')).statusCode, 200);
  const r = await call('/api/daily');
  assert.equal(r.statusCode, 429, '全局超限应 429');
  assert.equal(JSON.parse(r.body).scope, 'global');
}));

await check('客户端 IP 从 requestContext.http.sourceIp 取，退化时看 x-forwarded-for', async () => {
  assert.equal(ratelimit.clientIp({ requestContext: { http: { sourceIp: '9.9.9.9' } } }), '9.9.9.9');
  assert.equal(ratelimit.clientIp({ headers: { 'X-Forwarded-For': '8.8.8.8, 10.0.0.1' } }), '8.8.8.8');
  assert.equal(ratelimit.clientIp({}), '');
});

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
