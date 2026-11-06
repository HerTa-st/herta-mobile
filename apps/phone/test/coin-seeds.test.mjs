import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COIN_CUTOVER,
  fetchSeeds,
  mergeSeeds,
  parseSeeds,
  readSeedCache,
  secretForDate,
  shanghaiDate,
  writeSeedCache,
} from "../src/coin/seeds.ts";

const SEED = "0123456789abcdef0123456789abcdef";

function fakeStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

test("shanghaiDate：UTC 16:00 已经是上海第二天", () => {
  assert.equal(shanghaiDate(Date.parse("2026-11-06T16:00:00Z")), "2026-11-07");
  assert.equal(shanghaiDate(Date.parse("2026-11-06T15:59:59Z")), "2026-11-06");
});

test("parseSeeds：正常响应", () => {
  const p = parseSeeds(JSON.stringify({ version: 1, cutover: "2026-11-07", seeds: { "2026-11-09": SEED } }));
  assert.equal(p.version, 1);
  assert.equal(p.cutover, "2026-11-07");
  assert.equal(p.seeds["2026-11-09"], SEED);
});

test("parseSeeds：各种坏输入都抛人话", () => {
  assert.throws(() => parseSeeds("not json"), /不是 JSON/);
  assert.throws(() => parseSeeds(JSON.stringify({ version: 0, cutover: "2026-11-07", seeds: {} })), /version/);
  assert.throws(() => parseSeeds(JSON.stringify({ version: 1, cutover: "11/07", seeds: {} })), /cutover/);
  assert.throws(() => parseSeeds(JSON.stringify({ version: 1, cutover: "2026-11-07", seeds: [] })), /seeds/);
  assert.throws(() => parseSeeds(JSON.stringify({ version: 1, cutover: "2026-11-07", seeds: { "2026-11-09": "xyz" } })), /格式/);
  assert.throws(() => parseSeeds(JSON.stringify({ version: 1, cutover: "2026-11-07", seeds: { "11-09": SEED } })), /日期/);
});

test("缓存：写进去读得出来，坏缓存当没缓存", () => {
  const store = fakeStore();
  writeSeedCache(store, { "2026-11-09": SEED });
  assert.deepEqual(readSeedCache(store), { "2026-11-09": SEED });
  store.setItem("herta.coin.seeds.v1", "{oops");
  assert.deepEqual(readSeedCache(store), {});
  store.setItem("herta.coin.seeds.v1", JSON.stringify({ "2026-11-09": "bad", "2026-11-10": SEED }));
  assert.deepEqual(readSeedCache(store), { "2026-11-10": SEED });
});

test("合并：新密钥覆盖同一天，旧日期留着给历史 K 线", () => {
  const merged = mergeSeeds({ "2026-11-09": "a".repeat(32), "2026-11-10": "b".repeat(32) }, { "2026-11-10": SEED });
  assert.equal(merged["2026-11-09"], "a".repeat(32));
  assert.equal(merged["2026-11-10"], SEED);
});

test("取密钥：切换日之前不用密钥，之后没有就是 null", () => {
  const seeds = { "2026-11-09": SEED };
  assert.equal(secretForDate(seeds, "2026-11-06"), null);
  assert.equal(secretForDate(seeds, COIN_CUTOVER), null); // 这天还没拿到
  assert.equal(secretForDate(seeds, "2026-11-09"), SEED);
});

test("fetchSeeds：带 from 拉、解析成 map；HTTP 失败抛人话", async () => {
  const calls = [];
  const ok = async (url) => {
    calls.push(url);
    return { ok: true, text: async () => JSON.stringify({ version: 1, cutover: "2026-11-07", seeds: { "2026-11-09": SEED } }) };
  };
  const seeds = await fetchSeeds("https://x.example/", ok, "2026-11-07");
  assert.equal(calls[0], "https://x.example/api/seeds?from=2026-11-07");
  assert.equal(seeds["2026-11-09"], SEED);

  const bad = async () => ({ ok: false, status: 503, text: async () => "" });
  await assert.rejects(() => fetchSeeds("https://x.example", bad), /503/);
});
