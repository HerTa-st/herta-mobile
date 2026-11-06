import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLocalQuote,
  hasSessionSeed,
  secretLookup,
  sessionDateFor,
  syncSeeds,
} from "../src/coin/local-quote.ts";

const MONDAY = Date.parse("2026-11-09T10:15:30+08:00"); // 场次 11-09（切换后）
const SATURDAY = Date.parse("2026-11-07T10:15:30+08:00"); // 场次回落到 11-06（切换前）
const NEXT_SATURDAY = Date.parse("2026-11-14T10:15:30+08:00"); // 场次回落到 11-13（切换后）
const SEED = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

function fakeStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

test("场次日期：交易日是自己，周末回落到上一个交易日", () => {
  assert.equal(sessionDateFor(MONDAY), "2026-11-09");
  assert.equal(sessionDateFor(SATURDAY), "2026-11-06");
  assert.equal(sessionDateFor(NEXT_SATURDAY), "2026-11-13");
});

test("切换前的场次不需要密钥：周六照样能画上周五的线", () => {
  assert.equal(hasSessionSeed(SATURDAY, {}), true);
  const quote = buildLocalQuote(SATURDAY, {});
  assert.notEqual(quote, null);
  assert.equal(quote.market.sessionDate, "2026-11-06");
  assert.equal(quote.market.status, "weekend");
});

test("切换后的场次没密钥就不画，也不拿日期派生顶替", () => {
  assert.equal(hasSessionSeed(MONDAY, {}), false);
  assert.equal(buildLocalQuote(MONDAY, {}), null);
  assert.equal(hasSessionSeed(NEXT_SATURDAY, {}), false);
  assert.equal(buildLocalQuote(NEXT_SATURDAY, {}), null);
});

test("有了场次密钥：本地算出 11-09 的行情，sessionDate / bars 都对", () => {
  const seeds = { "2026-11-09": SEED };
  assert.equal(hasSessionSeed(MONDAY, seeds), true);
  const quote = buildLocalQuote(MONDAY, seeds);
  assert.notEqual(quote, null);
  assert.equal(quote.market.sessionDate, "2026-11-09");
  assert.equal(quote.market.status, "trading");
  assert.ok(quote.market.bars.length > 0);
  // 快讯也得跟着本地排出来（以前是 /api/daily 带下来的）
  assert.ok(quote.news, "本地行情应带 news");
  assert.ok(quote.news.total > 0, "总数应大于 0");
  assert.equal(quote.news.items.length > 0, true, "上午应已解锁至少一条");
  const item = quote.news.items[0];
  assert.match(item.time, /^\d{2}:\d{2}$/);
  assert.ok(["up", "down", "flat"].includes(item.dir));
});

test("切换日之前不查表", () => {
  assert.equal(secretLookup({})("2026-11-06"), null);
  assert.equal(secretLookup({ "2026-11-06": SEED })("2026-11-06"), null);
});

test("syncSeeds：拿到就落缓存，同一天的旧值被覆盖", async () => {
  const store = fakeStore();
  store.setItem("herta.coin.seeds.v1", JSON.stringify({ "2026-11-09": "f".repeat(32) }));
  const calls = [];
  const getText = async (url) => {
    calls.push(url);
    return JSON.stringify({ version: 1, cutover: "2026-11-07", seeds: { "2026-11-09": SEED } });
  };
  const out = await syncSeeds("http://127.0.0.1:8787/", getText, store);
  assert.equal(calls[0], "http://127.0.0.1:8787/api/seeds?from=2026-11-07");
  assert.equal(out.fromCache, false);
  assert.equal(out.seeds["2026-11-09"], SEED);
  assert.equal(JSON.parse(store.getItem("herta.coin.seeds.v1"))["2026-11-09"], SEED);
});

test("syncSeeds：拉不到就用缓存顶上，标 fromCache", async () => {
  const store = fakeStore();
  store.setItem("herta.coin.seeds.v1", JSON.stringify({ "2026-11-08": "b".repeat(32) }));
  const out = await syncSeeds("http://127.0.0.1:8787", async () => { throw new Error("offline"); }, store);
  assert.equal(out.fromCache, true);
  assert.equal(out.seeds["2026-11-08"], "b".repeat(32));
});
