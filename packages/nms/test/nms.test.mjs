import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, similarity, effectiveWeight, rankCandidates } from "../src/model.ts";
import { LEGACY_MIGRATED_KEY, LEGACY_VOICE_KEY, migrateLegacyMemories, readFrozenVoice } from "../src/migrate.ts";
import { createPendingWriter } from "../src/pending.ts";
import {
  applyVoiceGeneration,
  applyVoiceParams,
  cleanVoiceProfile,
  clampVoiceParams,
  defaultVoiceParams,
  normalizeVoiceSchema,
  parseVoiceReply,
  readVoiceState,
  renderVoiceParamsLine,
  rollbackVoiceState,
  VOICE_SNAPSHOT_LIMIT,
  writeVoiceState,
} from "../src/voice.ts";

const NOW = Date.parse("2026-11-02T00:00:00.000Z");

class FakeStore {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.meta = new Map();
    this.pending = [];
    this.nextId = 1;
    this.nextPending = 1;
  }
  async listNodes(filter = {}) {
    let list = [...this.nodes.values()];
    if (filter.tier !== undefined) list = list.filter((n) => (Array.isArray(filter.tier) ? filter.tier.includes(n.tier) : n.tier === filter.tier));
    if (filter.includeArchived !== true) list = list.filter((n) => !n.archived);
    if (filter.includeForgotten !== true) list = list.filter((n) => !n.forgotten);
    return list.sort((a, b) => a.id - b.id);
  }
  async getNode(id) { return this.nodes.get(id) ?? null; }
  async insertNode(input) {
    const node = {
      id: this.nextId++,
      tier: input.tier ?? "ep",
      persona: input.persona ?? "herta",
      workspace: input.workspace ?? null,
      title: input.title,
      gist: input.gist ?? "",
      body: input.body ?? input.gist ?? "",
      weight: input.weight ?? 0.5,
      recalls: input.recalls ?? 0,
      createdAt: input.createdAt ?? new Date(input.now ?? NOW).toISOString(),
      lastRecallAt: input.lastRecallAt ?? null,
      forgotten: false,
      archived: false,
      mergedInto: null,
      consolidatedCount: 0,
      lastConsolidatedAt: null,
      semanticizedAt: null,
      history: [],
    };
    this.nodes.set(node.id, node);
    return node;
  }
  async updateNode(id, patch) {
    const node = this.nodes.get(id);
    if (!node) return null;
    Object.assign(node, patch);
    return node;
  }
  async appendNodeHistory(id, entry) {
    const node = this.nodes.get(id);
    if (node) node.history.push(entry);
  }
  async mergeNodeInto() { return { moved: 0, dropped: 0 }; }
  async countMerged() { return 0; }
  async insertEdge(from, to, options = {}) {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    const edge = { a, b, strength: options.strength ?? 0.2, kind: options.kind ?? "assoc" };
    this.edges.set(a + ":" + b, edge);
    return edge;
  }
  async allEdges() { return [...this.edges.values()]; }
  async neighbors() { return []; }
  async recall(ids) {
    const updated = [];
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (!node) continue;
      node.recalls += 1;
      node.lastRecallAt = new Date(NOW).toISOString();
      updated.push(node);
    }
    return updated;
  }
  async reinforce() { return []; }
  async applyDecay() { return { decayed: 0, halfLifeDays: 90, floor: 0.05 }; }
  async dedupeByTitle() { return { archived: 0, archivedIds: [] }; }
  async pruneEdges() { return { pruned: 0, minStrength: 0.12 }; }
  async dreamLight() { return {}; }
  async insertPendingTurn(input) {
    if (input.turn !== null && input.turn !== undefined) {
      const existing = this.pending.find((row) => row.sessionId === input.sessionId && row.turn === input.turn);
      if (existing) return existing.id;
    }
    const row = {
      id: this.nextPending++,
      sessionId: input.sessionId,
      persona: input.persona ?? "herta",
      workspace: input.workspace ?? null,
      userText: input.userText ?? "",
      assistantText: input.assistantText ?? "",
      turn: input.turn ?? null,
      createdAt: new Date(input.now ?? NOW).toISOString(),
      consumedAt: null,
    };
    this.pending.push(row);
    return row.id;
  }
  async listPendingTurns() { return this.pending.filter((row) => row.consumedAt === null); }
  async consumePendingTurns(ids) { let n = 0; for (const row of this.pending) if (ids.includes(row.id) && row.consumedAt === null) { row.consumedAt = new Date(NOW).toISOString(); n += 1; } return n; }
  async pendingTurnStats() { return { total: this.pending.length, unconsumed: this.pending.filter((r) => r.consumedAt === null).length, sessions: new Set(this.pending.map((r) => r.sessionId)).size }; }
  async recordDreamRun() { return 1; }
  async lastDreamRun() { return null; }
  async dreamRuns() { return []; }
  async getMeta(key) { return this.meta.get(key) ?? null; }
  async setMeta(key, value) { this.meta.set(key, value); }
  async stats() { return { nodes: { total: this.nodes.size, active: this.nodes.size, archived: 0, forgotten: 0, merged: 0, byTier: { ep: 0, sem: 0, note: 0 }, byWorkspace: {} }, edges: { total: this.edges.size, avgStrength: 0 }, pending: await this.pendingTurnStats(), dreams: { count: 0, lastAt: null, lastKind: null }, halfLifeDays: 90, generatedAt: new Date(NOW).toISOString() }; }
  async snapshot() { return { schemaVersion: 1, generatedAt: new Date(NOW).toISOString(), stats: await this.stats(), nodes: [], edges: [] }; }
  async countNodes() { return this.nodes.size; }
  async sizeBytes() { return 0; }
}

test("model：中文 bigram 切分 / 余弦 / 有效权重 / 激活排序", () => {
  const tokens = tokenize("黑塔说：今天不想解释。");
  assert.ok(tokens.includes("黑塔"));
  assert.ok(tokens.includes("解释"));
  assert.ok(similarity(tokenize("老梦今天来了"), tokenize("老梦来了")) > 0.5);
  assert.ok(similarity(tokenize("老梦来了"), tokenize("完全无关")) < 0.2);
  const eff = effectiveWeight(0.8, new Date(NOW - 90 * 86400000).toISOString(), NOW);
  assert.ok(Math.abs(eff - 0.4) < 0.01);
  const nodes = [
    { id: 1, tier: "ep", title: "评审改期", gist: "改到周一", body: "", weight: 0.8, recalls: 1, lastRecallAt: null, archived: false, forgotten: false },
    { id: 2, tier: "ep", title: "无关", gist: "午餐", body: "", weight: 0.9, recalls: 0, lastRecallAt: null, archived: false, forgotten: false },
  ];
  const ranked = rankCandidates({ nodes, edges: [], query: "评审 周一", now: NOW, limit: 2 });
  assert.equal(ranked.results[0].node.id, 1);
});

test("migrate：种子→note、自造→ep、links→边、幂等、冻结语气", async () => {
  const store = new FakeStore();
  const records = [
    { name: "### 废案_00：终端外侧的噪声.txt", body: "### 废案：终端外侧的噪声\n\n正文", createdAt: new Date(NOW - 1000).toISOString(), gist: "种子", weight: 0.55, links: ["### 废案_10：自造.txt"] },
    { name: "### 废案_10：自造.txt", body: "### 废案：自造\n\n正文", createdAt: new Date(NOW).toISOString(), sessionId: "s1", weight: 0.7, recalls: 3, lastRecallAt: new Date(NOW - 100).toISOString(), tag: "工作" },
  ];
  const dream = { voice: { text: "我说话很短。", updatedAt: new Date(NOW).toISOString(), basis: 2 }, cursors: {}, made: 1, skipped: 0, lastNote: null, lastConsolidatedCount: null, lastConsolidationAt: null, forgottenTotal: 0 };
  const first = await migrateLegacyMemories(store, records, dream, { now: NOW });
  assert.deepEqual({ migrated: first.migrated, notes: first.notes, episodes: first.episodes, edges: first.edges }, { migrated: 2, notes: 1, episodes: 1, edges: 1 });
  const nodes = await store.listNodes({});
  const seed = nodes.find((n) => n.title === "终端外侧的噪声");
  const made = nodes.find((n) => n.title === "自造");
  assert.equal(seed.tier, "note");
  assert.equal(made.tier, "ep");
  assert.equal(made.recalls, 3);
  assert.ok(made.gist.includes("废案"));
  assert.ok(made.history.some((h) => h.kind === "legacy-tag" && h.tag === "工作"));
  assert.equal((await store.allEdges()).length, 1);
  assert.equal(await store.getMeta(LEGACY_MIGRATED_KEY), "1");
  assert.equal((await readFrozenVoice(store)).text, "我说话很短。");
  const second = await migrateLegacyMemories(store, records, dream, { now: NOW + 1000 });
  assert.equal(second.migrated, 0);
  assert.equal(await store.getMeta(LEGACY_VOICE_KEY) !== null, true);
});

test("pending：队列串行写入、同轮幂等、空文本不写", async () => {
  const store = new FakeStore();
  const writer = createPendingWriter(store);
  writer.enqueue({ sessionId: "s1", turn: 1, userText: "你好", assistantText: "嗯。" });
  writer.enqueue({ sessionId: "s1", turn: 1, userText: "重复", assistantText: "重复。" });
  writer.enqueue({ sessionId: "s1", turn: 2, userText: "", assistantText: "" });
  await writer.flush();
  assert.equal(writer.pending(), 0);
  const rows = await store.listPendingTurns();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userText, "你好");
  assert.equal(rows[0].turn, 1);
});

/* ------------------------------------------------------------ 自动语气 */

test("自动语气：参数一晚一格、越界夹回、枚举只挪相邻", () => {
  const schema = normalizeVoiceSchema();
  const base = defaultVoiceParams(schema);
  assert.equal(base.speech, 70);
  const out = clampVoiceParams(schema, base, { speech: 100, address: "none" });
  assert.equal(out.params.speech, 75, "数字最多差一个步长");
  assert.equal(out.params.address, "trailblazer", "不称呼离开拓者两格，不能一步到");
  assert.ok(out.rejected.some((r) => r.includes("address")));
  const snap = clampVoiceParams(schema, base, { speech: 72 });
  assert.equal(snap.params.speech, 70, "72 落到 5 的格子上还是 70");
  const moved = clampVoiceParams(schema, base, { address: "laomeng" });
  assert.equal(moved.params.address, "laomeng");
  const unknown = clampVoiceParams(schema, base, { nope: 1, speech: 65 });
  assert.equal("nope" in unknown.params, false);
});

test("自动语气：解析模型输出；坏 JSON / 空 profile 保留旧版", () => {
  const schema = normalizeVoiceSchema();
  const base = defaultVoiceParams(schema);
  const ok = parseVoiceReply('{"profile":"我说话很直，不爱解释。","params":{"speech":72,"address":"laomeng"}}', schema, base);
  assert.ok(ok);
  assert.equal(ok.params.speech, 70);
  assert.equal(ok.params.address, "laomeng");
  assert.equal(parseVoiceReply("不是 JSON", schema, base), null);
  assert.equal(parseVoiceReply('{"profile":""}', schema, base), null);
  const raw = ["# 我说话的方式", "- 短句。", "- 不解释。"].join("\n");
  assert.equal(cleanVoiceProfile(raw), "短句。\n不解释。");
  assert.ok(cleanVoiceProfile("长".repeat(900)).length <= 420);
});

test("自动语气：生成 / 手动改 / 回滚，历史裁到 5 条", async () => {
  const store = new FakeStore();
  const schema = normalizeVoiceSchema();
  const base = defaultVoiceParams(schema);
  let state = applyVoiceGeneration(null, { profile: "短。", params: base, reason: "auto", now: NOW });
  await writeVoiceState(store, state);
  const loaded = await readVoiceState(store);
  assert.ok(loaded);
  assert.equal(loaded.profile, "短。");
  state = applyVoiceGeneration(loaded, { profile: "更短。", params: base, reason: "auto", now: NOW + 1000 });
  await writeVoiceState(store, state);
  state = applyVoiceParams(state, { ...base, speech: 75 }, { now: NOW + 2000 });
  await writeVoiceState(store, state);
  const third = await readVoiceState(store);
  assert.equal(third.version, 3);
  assert.equal(third.history.length, 2);
  const rolled = rollbackVoiceState(third, 1, NOW + 3000);
  assert.ok(rolled);
  assert.equal(rolled.profile, "短。");
  assert.equal(rolled.version, 4);
  assert.equal(rollbackVoiceState(third, 99), null);
  let many = rolled;
  for (let i = 0; i < 8; i += 1) {
    many = applyVoiceGeneration(many, { profile: "第" + i + "版。", params: base, reason: "auto", now: NOW + 4000 + i * 1000 });
  }
  assert.equal(many.history.length, VOICE_SNAPSHOT_LIMIT);
});

test("自动语气：一行性子摘要带标签", () => {
  const schema = normalizeVoiceSchema();
  const line = renderVoiceParamsLine(schema, defaultVoiceParams(schema));
  assert.ok(line.includes("说话长短 70/100"));
  assert.ok(line.includes("耐心 60/100"));
  assert.ok(line.includes("主动程度 40/100"));
  assert.ok(line.includes("称呼方式：开拓者"));
});
