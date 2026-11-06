/*
 * 手机端 core（packages/coin/src/core）↔ 服务端 fc/coin-api/coin-core.js 逐位对账
 *
 * 判定口径（docs/价格密钥-设计-2026-11-07.md §3 + docs/coin-实现契约.md §2.4）：
 *   - 字符串 / 整数 / 布尔 / Date / null：严格相等（整数由「两边都是整数」判定）；
 *   - 浮点：|a-b| <= 1e-9 * max(1, |b|)；
 *   - 对象比全部键（两边都查，缺字段/多字段都算错），数组比长度与每一根。
 *
 * 覆盖：
 *   1. 旧向量：fc/coin-api/test/vectors.json 的 6 个时刻（全部 < CUTOVER），新旧实现逐位一致；
 *   2. 时段：周末 / 盘前 / 午休 / 收盘（都用 < CUTOVER 的场次，绕开密钥）；
 *   3. 旧派生模式（不传 getSecret）在 CUTOVER 之后的 2 个时刻也逐位一致
 *      —— 证明移植本身没改算法，只是种子串多了一段；
 *   4. 密钥模式（传 getSecret）在 CUTOVER 之后的 2 个时刻与服务端逐位一致
 *      —— 服务端 coin-core.js 还没接 getSecret 时自动跳过（并打印提示），接上后自动生效；
 *   5. 种子串规则（含 CUTOVER 当天）；
 *   6. getSecret 调用纪律：< CUTOVER 一律不问；>= CUTOVER 缺密钥就抛（不降级）；
 *   7. news-pool 与服务端逐条同序；makeRng / fingerprint 与服务端同流。
 *
 * 用法：cd herta-mobile && node packages/coin/test/core-parity.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

import * as client from "../src/core/index.ts";
import { NEWS_POOL } from "../src/core/news-pool.ts";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const FC_DIR = join(HERE, "..", "..", "..", "fc", "coin-api");
const server = require(join(FC_DIR, "coin-core.js"));
const SERVER_NEWS_POOL = require(join(FC_DIR, "news-pool.js")).NEWS_POOL;

const CUTOVER = client.COIN_CUTOVER;
assert.equal(CUTOVER, "2026-11-07", "CUTOVER 必须是设计文档里的 2026-11-07");

const TOL = 1e-9;
const SECRET_A = "0123456789abcdef0123456789abcdef";
const SECRET_B = "fedcba9876543210fedcba9876543210";

/* ---------------------------------------------------------------- 假密钥 */
// 服务端可能对任何日期都问一次（实现不同），所以这里对任何日期都给合法 hex；
// 旧日期用不用得上由各自的 seed 分支决定。
function secretHex(date) {
  return createHash("sha256").update("core-parity|" + date).digest("hex").slice(0, 32);
}
function makeSecretFn() {
  const calls = [];
  const fn = (date) => { calls.push(date); return secretHex(date); };
  fn.calls = calls;
  return fn;
}
// 客户端专用：旧日期一旦被问就直接炸（设计文档允许旧日期不实现 getSecret）
function makeStrictSecretFn() {
  const calls = [];
  const fn = (date) => {
    calls.push(date);
    if (date < CUTOVER) throw new Error("不该问旧日期的密钥：" + date);
    return secretHex(date);
  };
  fn.calls = calls;
  return fn;
}

/* ---------------------------------------------------------------- 逐字段比对 */
function kindOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Date) return "date";
  return typeof v;
}
function closeEnough(a, b) {
  return Math.abs(a - b) <= TOL * Math.max(1, Math.abs(b));
}
function fmt(v) {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toPrecision(17);
  return JSON.stringify(v);
}
function walk(serverVal, clientVal, path, out) {
  out.count++;
  const ks = kindOf(serverVal);
  const kc = kindOf(clientVal);
  if (ks !== kc) {
    out.fails.push(path + "：类型不同 服务端=" + ks + " 手机端=" + kc);
    return;
  }
  if (ks === "number") {
    if (Number.isFinite(serverVal) && Number.isFinite(clientVal)) {
      if (Number.isInteger(serverVal) && Number.isInteger(clientVal)) {
        if (serverVal !== clientVal) out.fails.push(path + "：整数不同 服务端=" + serverVal + " 手机端=" + clientVal);
      } else if (!closeEnough(serverVal, clientVal)) {
        out.fails.push(path + "：浮点超差 服务端=" + fmt(serverVal) + " 手机端=" + fmt(clientVal) +
          "（差 " + Math.abs(serverVal - clientVal).toExponential(3) + "）");
      }
    } else if (!Object.is(serverVal, clientVal)) {
      out.fails.push(path + "：非有限数不同 服务端=" + String(serverVal) + " 手机端=" + String(clientVal));
    }
    return;
  }
  if (ks === "string" || ks === "boolean" || ks === "null" || ks === "undefined") {
    if (serverVal !== clientVal) out.fails.push(path + "：不同 服务端=" + fmt(serverVal) + " 手机端=" + fmt(clientVal));
    return;
  }
  if (ks === "date") {
    if (serverVal.getTime() !== clientVal.getTime()) {
      out.fails.push(path + "：时间不同 服务端=" + serverVal.toISOString() + " 手机端=" + clientVal.toISOString());
    }
    return;
  }
  if (ks === "array") {
    if (serverVal.length !== clientVal.length) {
      out.fails.push(path + "：长度不同 服务端=" + serverVal.length + " 手机端=" + clientVal.length);
      return;
    }
    for (let i = 0; i < serverVal.length; i++) walk(serverVal[i], clientVal[i], path + "[" + i + "]", out);
    return;
  }
  // plain object
  const keys = new Set(Object.keys(serverVal).concat(Object.keys(clientVal)));
  for (const k of keys) {
    const hasS = Object.prototype.hasOwnProperty.call(serverVal, k);
    const hasC = Object.prototype.hasOwnProperty.call(clientVal, k);
    if (!hasC) { out.fails.push(path + "." + k + "：手机端缺字段"); continue; }
    if (!hasS) { out.fails.push(path + "." + k + "：手机端多字段"); continue; }
    walk(serverVal[k], clientVal[k], path + "." + k, out);
  }
}

function newCheck(label) {
  const out = { label: label, count: 0, fails: [] };
  return out;
}
function assertClean(out) {
  assert.equal(out.fails.length, 0, "【" + out.label + "】" + out.fails.length + " 项不符：\n  - " +
    out.fails.slice(0, 12).join("\n  - "));
}

async function maybePromise(v) {
  // 服务端将来若改成 async handler 也不用改测试
  return (v && typeof v.then === "function") ? await v : v;
}

function dayOf(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : d;
}
/** 服务端 getSession 的 sessionDate 是 Date，手机端给字符串；归一化后再比。 */
function normSession(s) {
  const copy = {};
  for (const k of Object.keys(s)) copy[k] = s[k];
  copy.sessionDate = dayOf(s.sessionDate);
  return copy;
}

/* 一个时刻：日报逐字段 + 场次信息逐字段 */
async function parityAt(label, nowISO, serverSecret, clientSecret) {
  const nowMs = Date.parse(nowISO);
  assert.ok(Number.isFinite(nowMs), "时间解析失败：" + nowISO);

  const out = newCheck(label);
  const sRes = await maybePromise(server.buildDailyResponse(nowMs, serverSecret));
  const cRes = await maybePromise(client.buildDailyResponse(nowMs, clientSecret));
  walk(sRes, cRes, "daily", out);
  walk(normSession(server.getSession(nowMs)), client.getSession(nowMs), "session", out);
  assertClean(out);
  return { serverRes: sRes, clientRes: cRes, checks: out.count };
}

/* ---------------------------------------------------------------- 数据 */
const RAW = JSON.parse(readFileSync(join(FC_DIR, "test", "vectors.json"), "utf8"));
const VECTORS = Array.isArray(RAW) ? RAW : RAW.vectors;
assert.ok(Array.isArray(VECTORS) && VECTORS.length === 6, "vectors.json 应该有 6 个时刻");

// 服务端是否已经吃 getSecret（task-1 落地与否）——用「传不传密钥结果一样吗」来探测
const SERVER_HAS_SECRET = (() => {
  const nowMs = Date.parse("2026-11-09T10:15:00+08:00");
  let without;
  try {
    without = JSON.stringify(server.buildDailyResponse(nowMs));
  } catch (err) {
    return true; // 不传就开不了盘：说明已经改成密钥驱动
  }
  try {
    const withSecret = JSON.stringify(server.buildDailyResponse(nowMs, makeSecretFn()));
    return withSecret !== without;
  } catch (err) {
    return true;
  }
})();

if (!SERVER_HAS_SECRET) {
  console.warn("");
  console.warn("⚠ 服务端 fc/coin-api/coin-core.js 还没接 getSecret（task-1 未落地）：");
  console.warn("  CUTOVER 之后的「密钥模式」逐位对账先跳过，接上后本文件自动开跑；");
  console.warn("  这一侧的密钥派生规则由下面的种子串 / 缺密钥抛错 / 密钥模式自检顶着。");
  console.warn("");
}

/* ================================================================ 1. 旧向量 */
for (const vec of VECTORS) {
  test("旧向量 " + vec.now + "（" + vec.status + "）与手机端逐位一致", async () => {
    assert.ok(vec.sessionDate < CUTOVER, "旧向量必须落在 CUTOVER 之前：" + vec.sessionDate);
    const { clientRes, checks } = await parityAt(vec.now, vec.now, makeSecretFn(), makeStrictSecretFn());
    // 这一场确实是我们想比的那一场
    assert.equal(clientRes.market.sessionDate, vec.sessionDate);
    assert.equal(clientRes.market.status, vec.status);
    assert.equal(clientRes.market.statusLabel, vec.statusLabel);
    assert.equal(clientRes.market.bars.length, vec.bars.length);
    console.log("PASS 旧向量 " + vec.now + "  " + checks + " 项");
  });
}

/* ================================================================ 2. 时段覆盖 */
const STATUS_CASES = [
  { label: "周末", now: "2026-11-07T12:00:00+08:00", status: "weekend", sessionDate: "2026-11-06" },
  { label: "盘前", now: "2026-11-06T09:00:00+08:00", status: "preopen", sessionDate: "2026-11-05" },
  { label: "上午交易中", now: "2026-11-06T10:20:30+08:00", status: "trading", sessionDate: "2026-11-06" },
  { label: "午休", now: "2026-11-06T12:00:00+08:00", status: "lunch", sessionDate: "2026-11-06" },
  { label: "下午交易中", now: "2026-11-06T14:05:15+08:00", status: "trading", sessionDate: "2026-11-06" },
  { label: "收盘", now: "2026-11-06T15:30:00+08:00", status: "closed", sessionDate: "2026-11-06" }
];
for (const c of STATUS_CASES) {
  test("时段覆盖 · " + c.label + "（" + c.now + "）逐位一致", async () => {
    const { clientRes, checks } = await parityAt(c.label + " " + c.now, c.now, makeSecretFn(), makeStrictSecretFn());
    const sess = client.getSession(Date.parse(c.now));
    assert.equal(sess.status, c.status);
    assert.equal(sess.sessionDate, c.sessionDate);
    assert.equal(clientRes.market.sessionDate, c.sessionDate);
    assert.ok(c.sessionDate < CUTOVER, "这一组故意选 < CUTOVER 的场次");
    console.log("PASS 时段 " + c.label.padEnd(6) + " " + c.now + "  " + checks + " 项");
  });
}

/* ================================================================ 2b. 边界时刻 */
// 创世日 / 收盘、午休、下午开盘的整点 / 跨年 / CUTOVER 之后的周末：
// 这些点会踩到 prev = series[last-1] || today、revealed=0、partial=0 之类的边界。
const EDGE_MOMENTS = [
  "2026-01-05T09:00:00+08:00",
  "2026-01-05T09:30:00+08:00",
  "2026-11-06T11:30:00+08:00",
  "2026-11-06T13:00:00+08:00",
  "2026-11-06T15:00:00+08:00",
  "2026-11-15T20:00:00+08:00",
  "2027-01-04T10:00:00+08:00"
];
for (const nowISO of EDGE_MOMENTS) {
  test("边界时刻 " + nowISO + " 逐位一致", async () => {
    const { clientRes, checks } = await parityAt("边界 " + nowISO, nowISO, makeSecretFn(), makeSecretFn());
    const sess = client.getSession(Date.parse(nowISO));
    if (sess.status === "trading") {
      assert.equal(clientRes.market.revealed, Math.min(client.TOTAL_BARS, Math.floor(sess.revealed + sess.partial)));
    }
    console.log("PASS 边界 " + nowISO + "  " + sess.status + "  " + checks + " 项");
  });
}

/* ================================================================ 3. 缺密钥口径 */
const POST_CUTOVER = [
  { now: "2026-11-09T10:15:00+08:00", sessionDate: "2026-11-09" },
  { now: "2026-11-10T14:20:00+08:00", sessionDate: "2026-11-10" },
  { now: "2026-11-14T12:00:00+08:00", sessionDate: "2026-11-13" } // 周末，但场次在 CUTOVER 之后
];
test("CUTOVER 之后缺密钥：服务端 503、手机端只有「不传 getSecret」才走旧派生", async () => {
  const nowMs = Date.parse("2026-11-09T10:15:00+08:00");
  // 服务端：拿不到密钥就是开不了盘（不拿日期派生备用密钥降级）
  let serverErr = null;
  try {
    await maybePromise(server.buildDailyResponse(nowMs));
  } catch (err) {
    serverErr = err;
  }
  assert.ok(serverErr, "服务端缺密钥必须抛错");
  assert.equal(serverErr.code, "missing_secret");
  assert.equal(serverErr.status, 503);
  assert.match(serverErr.message, /密钥/);

  // 手机端：getSecret 可选（lead 约定：不传 = 全部走旧派生，给历史日期和现存测试用）
  const legacy = client.buildDailyResponse(nowMs);
  assert.equal(legacy.market.sessionDate, "2026-11-09");
  assert.equal(legacy.market.status, "trading");
  // 但传了 getSecret 却缺这一天的密钥，口径必须和服务端一样：抛
  assert.throws(() => client.buildDailyResponse(nowMs, () => null), /密钥/);
});

/* ================================================================ 4. 密钥模式在 CUTOVER 之后 */
test("密钥模式 · CUTOVER 之后（含周末）与服务端逐位一致", {
  skip: SERVER_HAS_SECRET ? false : "服务端 coin-core.js 还没接 getSecret（task-1 未落地）"
}, async () => {
  const out = newCheck("密钥模式 · CUTOVER 之后");
  for (const c of POST_CUTOVER) {
    const nowMs = Date.parse(c.now);
    const sRes = await maybePromise(server.buildDailyResponse(nowMs, makeSecretFn()));
    const cRes = await maybePromise(client.buildDailyResponse(nowMs, makeSecretFn()));
    walk(sRes, cRes, "daily[" + c.sessionDate + "]", out);
    walk(normSession(server.getSession(nowMs)), client.getSession(nowMs), "session[" + c.sessionDate + "]", out);
    assert.equal(cRes.market.sessionDate, c.sessionDate);
    assert.ok(c.sessionDate >= CUTOVER);
  }
  assertClean(out);
  console.log("PASS 密钥模式 · CUTOVER 之后 " + POST_CUTOVER.length + " 个时刻  " + out.count + " 项");
});

/* ================================================================ 5. 种子串规则 */
test("种子串规则（CUTOVER 前后 + 含当天）", () => {
  const secret = () => SECRET_A;
  // 旧日期：不带密钥，历史价格一根都不许变
  assert.equal(client.daySeed("2026-11-06", secret), "HTC|daily|2026-11-06");
  assert.equal(client.planSeed("2026-11-06", secret), "HTC|intraday|2026-11-06");
  assert.equal(client.daySeed("2026-10-29", secret), "HTC|daily|2026-10-29");
  // CUTOVER 当天：含当天，要带密钥
  assert.equal(client.daySeed("2026-11-07", secret), "HTC|daily|2026-11-07|" + SECRET_A);
  assert.equal(client.planSeed("2026-11-07", secret), "HTC|intraday|2026-11-07|" + SECRET_A);
  // 之后
  assert.equal(client.daySeed("2026-11-09", secret), "HTC|daily|2026-11-09|" + SECRET_A);
  assert.equal(client.planSeed("2026-11-09", secret), "HTC|intraday|2026-11-09|" + SECRET_A);
  // 不传 getSecret = 旧派生（历史复算 / 现存测试）
  assert.equal(client.daySeed("2026-11-09"), "HTC|daily|2026-11-09");
  assert.equal(client.planSeed("2026-11-09"), "HTC|intraday|2026-11-09");
});

/* ================================================================ 6. getSecret 纪律 */
test("getSecret 纪律：旧日期不问、CUTOVER 起缺密钥就抛", () => {
  // 旧日期：一次都不该问
  const strict = makeStrictSecretFn();
  client.buildDailyResponse(Date.parse("2026-11-06T10:20:30+08:00"), strict);
  assert.deepEqual(strict.calls, [], "旧日期的场次不该调 getSecret");

  // CUTOVER 之后：缺密钥 = 开不了盘（不拿日期派生备用密钥降级）
  assert.throws(
    () => client.buildDailyResponse(Date.parse("2026-11-09T10:15:00+08:00"), () => null),
    /密钥/,
    "缺密钥必须抛错"
  );
  assert.throws(
    () => client.buildDailyResponse(Date.parse("2026-11-09T10:15:00+08:00"), () => ""),
    /密钥/
  );
  // 传了 getSecret 且密钥齐全：正常出图
  const ok = client.buildDailyResponse(Date.parse("2026-11-09T10:15:00+08:00"), makeSecretFn());
  assert.equal(ok.market.sessionDate, "2026-11-09");
  assert.equal(ok.market.bars.length, client.getSession(Date.parse("2026-11-09T10:15:00+08:00")).revealed + 1);
});

/* ================================================================ 7. 密钥真的进了种子 */
test("密钥模式自检：同日期不同密钥出不同行情，结构不变", () => {
  const nowMs = Date.parse("2026-11-09T10:15:00+08:00");
  const legacy = client.buildDailyResponse(nowMs);
  const a = client.buildDailyResponse(nowMs, () => SECRET_A);
  const b = client.buildDailyResponse(nowMs, () => SECRET_B);

  assert.notEqual(a.market.close, legacy.market.close, "带密钥必须和旧派生不同");
  assert.notEqual(a.market.close, b.market.close, "不同密钥必须出不同行情");
  // 只有价格变，场次结构不变
  assert.equal(a.market.sessionDate, legacy.market.sessionDate);
  assert.equal(a.market.sessionNumber, legacy.market.sessionNumber);
  assert.equal(a.market.revealed, legacy.market.revealed);
  assert.equal(a.market.status, legacy.market.status);
  assert.equal(a.market.bars.length, legacy.market.bars.length);
  // 重复调用稳定（30s 定时器靠这个）
  assert.deepEqual(client.buildDailyResponse(nowMs, () => SECRET_A), a);
});

/* ================================================================ 8. 新闻池 / RNG / 指纹 */
test("news-pool 与服务端逐条同序", () => {
  assert.equal(NEWS_POOL.length, SERVER_NEWS_POOL.length);
  assert.equal(NEWS_POOL.length, 210);
  for (let i = 0; i < NEWS_POOL.length; i++) {
    assert.equal(NEWS_POOL[i], SERVER_NEWS_POOL[i], "第 " + i + " 条快讯不一致");
  }
});

test("makeRng / fingerprint 与服务端同流", () => {
  for (const seed of ["HTC|daily|2026-10-29", "HTC|intraday|2026-11-09|" + SECRET_A, "HTC|tick|2026-11-09|7|1762584000"]) {
    const a = server.makeRng(seed);
    const b = client.makeRng(seed);
    for (let i = 0; i < 16; i++) {
      const va = a.next();
      const vb = b.next();
      assert.ok(closeEnough(vb, va), "next() 第 " + i + " 个不一致：" + va + " vs " + vb);
    }
    assert.equal(b.int(2, 7), a.int(2, 7));
    assert.ok(closeEnough(b.range(0.5, 2.5), a.range(0.5, 2.5)));
    assert.equal(b.chance(0.37), a.chance(0.37));
    assert.ok(closeEnough(b.norm(), a.norm()));
    assert.equal(b.pick(["a", "b", "c", "d"]), a.pick(["a", "b", "c", "d"]));
  }
  for (const s of ["2026-11-09", "HTC|daily|2026-11-06", "黑塔币 HTC"]) {
    assert.equal(client.fingerprint(s), server.fingerprint(s));
  }
  // 形状：8 位大写 hex
  const fp = client.fingerprint("2026-11-09");
  assert.equal(fp.length, 8);
  assert.equal(fp, fp.toUpperCase());
});

/* ------------------------------------------- 快讯排点：客户端 ↔ 服务端 /api/daily 真比对 */

const { createHandler } = require(join(FC_DIR, "index.js"));
const serverSeeds = require(join(FC_DIR, "seeds.js"));

function createMemoryStore() {
  let state = null;
  return {
    async read() { return state ? JSON.parse(JSON.stringify(state)) : null; },
    async write(next) { state = JSON.parse(JSON.stringify(next)); },
    async withLock(fn) { return fn(); },
  };
}

/** 用服务端 handler 跑一次 /api/daily（内存账本，会顺手生成当日密钥）。 */
async function serverDaily(nowMs) {
  // seeds.js 的密钥备忘是进程级的：每个用例换一份内存账本前先清掉，
  // 否则上一个用例生成的密钥会「看起来还在」，新账本里其实没有。
  serverSeeds._resetMemoForTest();
  const store = createMemoryStore();
  const handler = createHandler({ now: () => nowMs, storeFactory: () => store });
  const call = (path, query) => {
    const u = new URL(path + (query ? "?" + query : ""), "http://parity");
    return handler(
      {
        version: "v1",
        rawPath: u.pathname,
        rawQueryString: u.searchParams.toString(),
        headers: { host: "parity" },
        queryParameters: Object.fromEntries(u.searchParams),
        requestContext: { http: { method: "GET", path: u.pathname, protocol: "HTTP/1.1" } },
        body: "",
        isBase64Encoded: false,
      },
      { requestId: "parity-" + Math.random().toString(16).slice(2, 8) }
    );
  };
  // 先按客户端的方式要密钥（周末/盘前要的是上一场，历史每根也都要），再要行情
  const seedsRes = await call("/api/seeds", "from=" + CUTOVER);
  assert.equal(seedsRes.statusCode, 200, "服务端 /api/seeds 应 200，实际 " + seedsRes.statusCode + "：" + String(seedsRes.body).slice(0, 300));
  const res = await call("/api/daily");
  assert.equal(res.statusCode, 200, "服务端 /api/daily 应 200，实际 " + res.statusCode + "：" + String(res.body).slice(0, 300));
  const body = JSON.parse(res.body);
  const state = (await store.read()) || {};
  const seeds = state.seeds || {};
  const getSecret = (d) => (d >= CUTOVER ? seeds[d] || null : null);
  const local = client.buildDailyResponse(nowMs, getSecret);
  const localNews = client.buildNews(local, getSecret);
  return { body, localNews, getSecret };
}

for (const [label, iso] of [
  ["切换前的工作日", "2026-11-06T10:15:30+08:00"],
  ["切换后的上午", "2026-11-09T10:15:30+08:00"],
  ["切换后的午休", "2026-11-09T12:00:00+08:00"],
  ["切换后的周末", "2026-11-14T10:00:00+08:00"],
]) {
  test("快讯排点（" + label + "）：每一条与服务端逐字一致", async () => {
    const nowMs = Date.parse(iso);
    const { body, localNews } = await serverDaily(nowMs);
    const remote = body.news;
    assert.ok(remote, "服务端 /api/daily 应带 news");
    assert.equal(localNews.total, remote.total, "总数不一致");
    assert.equal(localNews.items.length, remote.items.length, "已解锁条数不一致");
    for (let i = 0; i < localNews.items.length; i++) {
      assert.deepEqual(localNews.items[i], remote.items[i], "第 " + i + " 条快讯不一致");
    }
  });
}
