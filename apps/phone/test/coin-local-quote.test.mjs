import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLocalQuote, hasTodaySeed, secretLookup, syncSeeds } from "../src/coin/local-quote.ts";

const DAY = Date.parse("2026-11-09T10:15:30+08:00"); // 周一，切换日之后
const SEED = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

function fakeStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

test("没有今天的密钥：不画，也不拿日期派生顶替", () => {
  assert.equal(hasTodaySeed({}, DAY), false);
  assert.equal(buildLocalQuote(DAY, {}), null);
});

test("有了密钥：本地算出 11-09 的行情，sessionDate / bars 都对", () => {
  const seeds = { "2026-11-09": SEED };
  assert.equal(hasTodaySeed(seeds, DAY), true);
  const quote = buildLocalQuote(DAY, seeds);
  assert.notEqual(quote, null);
  assert.equal(quote.market.sessionDate, "2026-11-09");
  assert.equal(quote.market.status, "trading");
  assert.ok(quote.market.bars.length > 0);
  assert.equal(quote.market.revealed, quote.market.bars.filter((b) => !b.partial).length);
});

test("切换日之前不用密钥", () => {
  const legacyDay = Date.parse("2026-11-06T10:15:30+08:00");
  assert.equal(hasTodaySeed({}, legacyDay), true);
  assert.equal(secretLookup({})("2026-11-06"), null);
  const quote = buildLocalQuote(legacyDay, {});
  assert.equal(quote.market.sessionDate, "2026-11-06");
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
