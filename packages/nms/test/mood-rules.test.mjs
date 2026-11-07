import test from "node:test";
import assert from "node:assert/strict";
import {
  MOOD_RULES_META_KEY,
  MOOD_RULES_SNAPSHOT_LIMIT,
  applyMoodRevision,
  readMoodRules,
  rollbackMoodRules,
  writeMoodRules,
} from "../src/mood-rules.ts";

const NOW = Date.parse("2026-11-02T00:00:00.000Z");

/** 只实现 mood-rules 用得到的两件事，和 nms.test.mjs 的 FakeStore 同口径。 */
class FakeStore {
  constructor() {
    this.meta = new Map();
  }
  async getMeta(key) {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key, value) {
    this.meta.set(key, value);
  }
}

function sections(tag) {
  return { triggers: tag + "-触发", boundaries: tag + "-边界", priority: tag + "-优先级" };
}

test("mood-rules：读写 roundtrip", async () => {
  const store = new FakeStore();
  const state = applyMoodRevision(null, sections("v1"), { reason: "第一次", now: NOW });
  await writeMoodRules(store, state);
  assert.equal(store.meta.size, 1);
  assert.ok(store.meta.has(MOOD_RULES_META_KEY));
  assert.deepEqual(await readMoodRules(store), state);
});

test("mood-rules：首次写入 version=1、没有历史", () => {
  const state = applyMoodRevision(null, sections("v1"), { reason: "第一次", now: NOW });
  assert.equal(state.version, 1);
  assert.deepEqual(state.history, []);
  assert.equal(state.updatedAt, new Date(NOW).toISOString());
});

test("mood-rules：再改一次 version+1，旧版进历史且新在前", () => {
  const first = applyMoodRevision(null, sections("v1"), { reason: "第一次", now: NOW });
  const second = applyMoodRevision(first, sections("v2"), { reason: "第二次", now: NOW + 1000 });
  assert.equal(second.version, 2);
  assert.equal(second.history.length, 1);
  assert.equal(second.history[0].version, 1);
  assert.deepEqual(second.history[0].sections, first.sections);
  assert.ok(!("history" in second.history[0]));
});

test("mood-rules：历史只留 5 版，新的在前", () => {
  let state = applyMoodRevision(null, sections("v1"), { reason: "第一次", now: NOW });
  for (let i = 2; i <= 7; i += 1) {
    state = applyMoodRevision(state, sections("v" + i), { reason: "第" + i + "次", now: NOW + i * 1000 });
  }
  assert.equal(state.version, 7);
  assert.equal(state.history.length, MOOD_RULES_SNAPSHOT_LIMIT);
  assert.deepEqual(state.history.map((item) => item.version), [6, 5, 4, 3, 2]);
});

test("mood-rules：rollback 用旧快照生成新版本，当前版进历史", () => {
  const first = applyMoodRevision(null, sections("v1"), { reason: "第一次", now: NOW });
  const second = applyMoodRevision(first, sections("v2"), { reason: "第二次", now: NOW + 1000 });
  const third = applyMoodRevision(second, sections("v3"), { reason: "第三次", now: NOW + 2000 });
  const back = rollbackMoodRules(third, 1);
  assert.equal(back.version, 4);
  assert.deepEqual(back.sections, first.sections);
  assert.equal(back.reason, "rollback:v1");
  assert.equal(back.history[0].version, 3);
  assert.deepEqual(back.history[0].sections, third.sections);
  assert.equal(back.history.length, 3);
});

test("mood-rules：rollback 到不存在的版本抛错", () => {
  const state = applyMoodRevision(null, sections("v1"), { reason: "第一次", now: NOW });
  assert.throws(() => rollbackMoodRules(state, 9), /没有 v9 的快照/);
});

test("mood-rules：坏 meta（字符串/缺字段/坏 JSON）读出 null", async () => {
  const store = new FakeStore();
  const bads = [
    '"hello"',
    "{}",
    '{"version":1}',
    '{"version":1,"sections":{"triggers":"a","boundaries":"b"}}',
    "{not json",
    "null",
  ];
  for (const bad of bads) {
    await store.setMeta(MOOD_RULES_META_KEY, bad);
    assert.equal(await readMoodRules(store), null, bad);
  }
});

test("mood-rules：没有 meta（深睡读不到）返回 null，不抛", async () => {
  const store = new FakeStore();
  assert.equal(await store.getMeta(MOOD_RULES_META_KEY), null);
  assert.equal(await readMoodRules(store), null);
});

test("mood-rules：evidence 可选，给了就 roundtrip 保留", async () => {
  const store = new FakeStore();
  const withEvidence = applyMoodRevision(null, sections("v1"), {
    reason: "有依据",
    evidence: "她说「我不想解释」",
    now: NOW,
  });
  assert.equal(withEvidence.evidence, "她说「我不想解释」");
  await writeMoodRules(store, withEvidence);
  const read = await readMoodRules(store);
  assert.equal(read.evidence, "她说「我不想解释」");
  const noEvidence = applyMoodRevision(null, sections("v1"), { reason: "没依据", now: NOW });
  assert.ok(!("evidence" in noEvidence));
});

test("mood-rules：历史里坏快照被丢掉，好快照保留", async () => {
  const store = new FakeStore();
  const payload = {
    version: 3,
    sections: sections("v3"),
    updatedAt: new Date(NOW).toISOString(),
    reason: "第三次",
    history: [
      { version: 2, sections: sections("v2"), updatedAt: new Date(NOW - 1000).toISOString(), reason: "第二次" },
      { version: "坏", sections: sections("坏") },
      { version: 1 },
    ],
  };
  await store.setMeta(MOOD_RULES_META_KEY, JSON.stringify(payload));
  const read = await readMoodRules(store);
  assert.equal(read.version, 3);
  assert.deepEqual(read.history.map((item) => item.version), [2]);
});
