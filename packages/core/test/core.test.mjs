import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { NodeAssetSource } from "../src/assets-node.ts";
import { buildStaticPrefix, pickSeeds, MOBILE_NOTE, FORMAT_CONTRACT } from "../src/persona.ts";
import { extractTagged, parseTagged, isPlaceholder, serializeRecord, parseSupervisorVerdict } from "../src/tags.ts";
import { parseNarrative } from "../src/narrative.ts";
import { buildReviewMessages, decideReview, vetoHints } from "../src/supervisor.ts";
import { listOpenings, pickOpening } from "../src/openings.ts";
import { EMPTY_TITLE, appendBlocks, createSession, deriveTitle, retractLastTurn, trimForContext } from "../src/session.ts";
import { MemoryInMemory, memoryFileName, memoryTitle, nextMemoryIndex } from "../src/memory.ts";
import { extractJson, runDreamPass } from "../src/dream.ts";

/** 桌面版原文抽出来的 196 个函数：复核提示词与分隔符从它注入，不在 core 里重写。 */
import * as H from "../../../runtime/prompts-code.zh.mjs";

const ASSETS = fileURLToPath(new URL("../../../assets/", import.meta.url));
const src = new NodeAssetSource(ASSETS, "zh");

/* ------------------------------------------------------------------ 素材 */

test("素材齐：《自传、设定、话术、41 条原声、13 篇记忆》", async () => {
  const a = await src.promptAssets();
  assert.ok(a.hertaBio.length > 5000, "自传太短，多半读错了文件");
  assert.ok(a.envSet.length > 0);
  assert.ok(Object.keys(a.hints).length >= 10);

  const v = await src.voice();
  assert.equal(Object.keys(v.openings).length, 36);
  assert.equal(v.veto.length, 4);

  assert.equal((await src.seedFiles()).length, 13);
});

/* ------------------------------------------------------------ 人格装配 */

test("静态前缀：自传在最前，输出契约在最后", async () => {
  const a = await src.promptAssets();
  const prefix = buildStaticPrefix({ assets: a, seeds: [] });

  assert.ok(prefix.startsWith(a.hertaBio.slice(0, 200)));
  assert.ok(prefix.includes(MOBILE_NOTE));
  assert.ok(prefix.endsWith(FORMAT_CONTRACT));
  assert.ok(prefix.indexOf(MOBILE_NOTE) < prefix.indexOf(FORMAT_CONTRACT));
});

test("静态前缀：插了种子后顺序不变，设定仍在处境之前", async () => {
  const a = await src.promptAssets();
  const prefix = buildStaticPrefix({ assets: a, seeds: ["### 废案_01：测试\n正文"] });
  assert.ok(prefix.indexOf("### 废案_01：测试") > prefix.indexOf(a.hertaBio.slice(0, 200)));
  assert.ok(prefix.indexOf(a.envSet) > prefix.indexOf("### 废案_01：测试"));
});

test("挑种子：确定性（rng 固定时同一输入同一结果）且不超过上限", async () => {
  const files = await src.seedFiles();
  const pool = [];
  for (const f of files) pool.push({ file: f, body: (await src.readSeed(f)) ?? "" });

  const a = pickSeeds(pool, "你今天怎么这么慢", 3, { rng: () => 0 });
  const b = pickSeeds(pool, "你今天怎么这么慢", 3, { rng: () => 0 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  assert.equal(pickSeeds([], "x", 3).length, 0);
});

/* ---------------------------------------------------------------- 开局 */

test("开局：36 篇全部带得上原声，路径去掉 assets/ 前缀", async () => {
  const a = await src.promptAssets();
  const voice = await src.voice();
  const list = listOpenings((a.openings ?? {}), voice);

  assert.equal(list.length, 36);
  assert.ok(list.every((o) => o.audio && !o.audio.startsWith("assets/")));
  assert.ok(list.every((o) => o.speech.length > 0), "有开局读不出「说」那一轨");
  assert.ok(list[0].key < list[35].key, "排序不稳定");
});

test("开局：rng 决定挑哪一篇，且不会挑空", () => {
  const list = [
    { key: "a", thought: "", speech: "甲", audio: null },
    { key: "b", thought: "", speech: "乙", audio: null },
  ];
  assert.equal(pickOpening(list, () => 0)?.key, "a");
  assert.equal(pickOpening(list, () => 0.99)?.key, "b");
  assert.equal(pickOpening([], () => 0), null);
});

/* ---------------------------------------------------------------- 会话 */

test("标题：从第一条用户消息取，句末断行，超长加省略号", () => {
  const b = (text) => [{ kind: "user", text, at: "2026-10-26T00:00:00Z" }];
  assert.equal(deriveTitle([]), EMPTY_TITLE);
  assert.equal(deriveTitle(b("在干嘛呀")), "在干嘛呀");
  assert.equal(deriveTitle(b("你今天怎么这么慢？我等了半天了")), "你今天怎么这么慢？");
  assert.ok(deriveTitle(b("这是一段特别特别长的没有标点的话说了很多很多字")).endsWith("…"));
});

test("追加：标题只补一次，时间会推进", () => {
  const s0 = createSession(new Date("2026-10-26T00:00:00Z"));
  assert.equal(s0.title, EMPTY_TITLE);

  const s1 = appendBlocks(s0, [{ kind: "user", text: "在吗", at: "2026-10-26T00:00:01Z" }], new Date("2026-10-26T00:00:01Z"));
  assert.equal(s1.title, "在吗");
  assert.notEqual(s1.updatedAt, s0.updatedAt);

  const s2 = appendBlocks(s1, [{ kind: "herta", surface: "speech", text: "在。", at: "2026-10-26T00:00:02Z" }]);
  assert.equal(s2.title, "在吗", "标题被后来的消息改掉了");
  assert.equal(s2.blocks.length, 2);
});

test("撤回：从最后一条用户消息起全丢，不留半轮", () => {
  const s = {
    id: "x",
    title: "t",
    origin: "phone",
    createdAt: "",
    updatedAt: "",
    blocks: [
      { kind: "user", text: "一", at: "" },
      { kind: "herta", surface: "speech", text: "一答", at: "" },
      { kind: "user", text: "二", at: "" },
      { kind: "herta", surface: "thought", text: "二想", at: "" },
      { kind: "herta", surface: "speech", text: "二答", at: "" },
    ],
  };
  const r = retractLastTurn(s);
  assert.equal(r.blocks.length, 2);
  assert.equal(retractLastTurn({ ...r, blocks: [] }).blocks.length, 0);
});

test("上下文截断：切在整轮边界，不会从她的话中间开始", () => {
  const blocks = [];
  for (let i = 0; i < 5; i += 1) {
    blocks.push({ kind: "user", text: "u" + i, at: "" });
    blocks.push({ kind: "herta", surface: "speech", text: "a" + i, at: "" });
    blocks.push({ kind: "herta", surface: "thought", text: "t" + i, at: "" });
  }
  const got = trimForContext(blocks, 4);
  assert.equal(got[0].kind, "user", "截断点落在了非用户消息上");
  // 往前找轮边界会多带几条——这是有意的：宁可多喂一轮，不可从她话中间开始。
  assert.ok(got.length >= 4 && got.length <= 6, "长度失控了：" + got.length);
  assert.deepEqual(got[got.length - 1], blocks[blocks.length - 1], "末尾被截掉了");
  assert.deepEqual(trimForContext(blocks, 0), blocks, "maxBlocks=0 应当原样返回");
});

/* ---------------------------------------------------------------- 记忆 */

test("记忆：标题从首行取，编号接着现有的往下排", () => {
  assert.equal(memoryTitle({ name: "x.txt", body: "### 废案_07：凉掉的第三杯茶\n\n正文", createdAt: "" }), "凉掉的第三杯茶");
  const recs = [
    { name: "### 废案_00：甲.txt", body: "", createdAt: "" },
    { name: "### 废案_13：乙.txt", body: "", createdAt: "" },
  ];
  assert.equal(nextMemoryIndex(recs), 14);
  assert.equal(nextMemoryIndex([]), 10);
  assert.ok(memoryFileName(14, "新 的/标题").startsWith("### 废案_14："));
});

/* ---------------------------------------------------------------- 做梦 */

const SIX_BLOCKS = [
  { kind: "user", text: "你今天怎么这么慢", at: "" },
  { kind: "herta", surface: "speech", text: "慢是你没算过这堆数据的体量。", at: "" },
  { kind: "user", text: "那你算出来了吗", at: "" },
  { kind: "herta", surface: "thought", text: "他连问题都没问对。", at: "" },
  { kind: "herta", surface: "speech", text: "算出来了。你要的那部分没用。", at: "" },
  { kind: "user", text: "……行吧", at: "" },
];

const GOOD = "### 废案_10：慢与体量\n\n那天他嫌我慢。\n\n---\n\n（我 说）\n慢是你没算过这堆数据的体量。\n（/我 说）";

function dreamHarness({ replies, seed = [] }) {
  const store = new MemoryInMemory(seed);
  const calls = [];
  const prompts = {
    buildEpisodeDigest: (blocks) => blocks.map((b) => b.text).join("\n"),
    buildWorthinessPrompt: () => "WORTH",
    buildGenerationPrompt: () => "GEN",
    buildCritiquePrompt: () => "CRITIQUE",
    buildRefinePrompt: (_draft, errors) => "REFINE:" + errors.join("|"),
    validateFeian: (text) =>
      text.includes("（我 说）") && text.includes("---") ? { ok: true } : { ok: false, errors: ["missing --- separator"] },
  };
  const deps = {
    store,
    prompts,
    scene: { env: "办公室", guide: "指南", lang: "zh" },
    chat: async ({ prompt }) => {
      calls.push(prompt);
      const next = replies.shift();
      if (next === undefined) throw new Error("模型调用次数超了");
      return next;
    },
    now: () => 1_800_000_000_000,
  };
  return { deps, store, calls };
}

test("做梦：材料不够就不做，游标不动", async () => {
  const h = dreamHarness({ replies: [] });
  const out = await runDreamPass(h.deps, { sessionId: "s1", blocks: SIX_BLOCKS.slice(0, 3) });
  assert.equal(out.kind, "skipped");
  assert.deepEqual((await h.store.state()).cursors, {});
  assert.equal(h.calls.length, 0, "材料不够还去调模型了");
});

test("做梦：刚做过就等一会儿", async () => {
  const h = dreamHarness({ replies: [] });
  await h.store.saveState({ cursors: {}, made: 0, skipped: 0, lastPassAt: h.deps.now() - 1000, lastNote: null });
  const out = await runDreamPass(h.deps, { sessionId: "s1", blocks: SIX_BLOCKS });
  assert.equal(out.kind, "skipped");
  assert.equal(h.calls.length, 0);
});

test("做梦：判不值得记 → 记一笔，游标前进，不会反复嚼同一段", async () => {
  const h = dreamHarness({ replies: ['{"worthy": false, "reason": "只是进度汇报"}'] });
  const out = await runDreamPass(h.deps, { sessionId: "s1", blocks: SIX_BLOCKS });
  assert.equal(out.kind, "rejected");
  const st = await h.store.state();
  assert.equal(st.cursors.s1, SIX_BLOCKS.length);
  assert.equal(st.skipped, 1);
  assert.ok(st.lastNote.includes("只是进度汇报"));
  assert.equal((await h.store.list()).length, 0);
});

test("做梦：值得记且一次过 → 落成废案，编号接着排", async () => {
  const h = dreamHarness({
    seed: [{ name: "### 废案_13：旧的.txt", body: "### 废案_13：旧的\n\n---\n\n（我 说）\n旧。\n（/我 说）", createdAt: "" }],
    replies: [
      '{"worthy": true}',
      JSON.stringify({ feian: GOOD, situationTag: "被嫌慢" }),
      '{"voice": 0.92, "format": 1, "faithfulness": 0.9, "fixes": []}',
    ],
  });
  const out = await runDreamPass(h.deps, { sessionId: "s1", blocks: SIX_BLOCKS });
  assert.equal(out.kind, "made");
  const list = await h.store.list();
  assert.equal(list.length, 2);
  const made = list.find((r) => r.sessionId === "s1");
  assert.ok(made.name.startsWith("### 废案_14："), "编号没接着 13 往下排：" + made.name);
  const st = await h.store.state();
  assert.equal(st.made, 1);
  assert.equal(st.cursors.s1, SIX_BLOCKS.length);
  assert.equal(st.lastPassAt, 1_800_000_000_000);
});

test("做梦：格式不合格 → 改一遍后过", async () => {
  const BAD = "### 废案_10：没分隔线\n\n（我 说）\n少了一根线。\n（/我 说）";
  const h = dreamHarness({
    replies: [
      '{"worthy": true}',
      JSON.stringify({ feian: BAD, situationTag: "t" }),
      '{"voice": 0.9, "faithfulness": 0.9, "fixes": []}',
      JSON.stringify({ feian: GOOD, situationTag: "t" }),
    ],
  });
  const out = await runDreamPass(h.deps, { sessionId: "s1", blocks: SIX_BLOCKS });
  assert.equal(out.kind, "made");
  assert.ok(h.calls[3].includes("missing --- separator"), "改写提示词里没带上具体问题");
});

test("做梦：改完还是不合格 → 记失败，游标照样前进", async () => {
  const h = dreamHarness({
    replies: [
      '{"worthy": true}',
      JSON.stringify({ feian: "### 废案_10：坏的\n\n（我 说）\n没线。\n（/我 说）" }),
      '{"voice": 0.9, "faithfulness": 0.9, "fixes": []}',
      JSON.stringify({ feian: "还是坏的" }),
    ],
  });
  const out = await runDreamPass(h.deps, { sessionId: "s1", blocks: SIX_BLOCKS });
  assert.equal(out.kind, "failed");
  assert.equal((await h.store.list()).length, 0);
  assert.equal((await h.store.state()).cursors.s1, SIX_BLOCKS.length);
});

test("做梦：语气分不够 → 带上评审意见去改", async () => {
  const h = dreamHarness({
    replies: [
      '{"worthy": true}',
      JSON.stringify({ feian: GOOD, situationTag: "t" }),
      '{"voice": 0.4, "faithfulness": 0.9, "fixes": ["太平了，像别人说的"]}',
      JSON.stringify({ feian: GOOD, situationTag: "t" }),
    ],
  });
  const out = await runDreamPass(h.deps, { sessionId: "s1", blocks: SIX_BLOCKS });
  assert.equal(out.kind, "made");
  assert.ok(h.calls[3].includes("太平了"), "语气问题没进改写提示词");
});

test("做梦：模型把 JSON 包在代码块里也认得出来", () => {
  assert.deepEqual(extractJson("```json\n{\"worthy\": true}\n```"), { worthy: true });
  assert.deepEqual(extractJson("前言\n{\"a\":1}\n后记"), { a: 1 });
  assert.equal(extractJson("没有 JSON"), null);
});

/* -------------------------------------------------------------- 标签语法 */
test("标签：想与说各自成对，内容原样取出", () => {
  const raw = "（我 想）\n这段话他看不见\n（/我 想）\n\n（我 说）\n这段话他听得见\n（/我 说）";
  assert.equal(extractTagged(raw, "thought"), "这段话他看不见");
  assert.equal(extractTagged(raw, "speech"), "这段话他听得见");
  assert.equal(extractTagged(raw, "speech"), extractTagged(raw, "speech"));
});

test("拆分：两对标签都在，各归各", () => {
  const n = parseNarrative("（我 想）\n他没安好心。\n（/我 想）\n\n（我 说）\n说吧。\n（/我 说）");
  assert.equal(n.thought, "他没安好心。");
  assert.equal(n.speech, "说吧。");
  assert.equal(n.tagged, true);
});

test("拆分：缺「说」的闭合标签时，绝不能把心里话当台词（截图里那个 bug）", () => {
  const n = parseNarrative("（我 想）\n我好累。\n（/我 想）\n\n（我 说）\n又来一个。");
  assert.equal(n.thought, "我好累。");
  assert.equal(n.speech, "又来一个。");
  assert.ok(!n.speech.includes("我好累"), "心里话漏进台词了");
  assert.ok(!/[（(]\/?我\s*[想说]/.test(n.speech), "台词里还留着标签");
});

test("拆分：连「想」的闭合标签都缺，边界落在下一个开标签上", () => {
  const n = parseNarrative("（我 想）\n甲\n（我 说）\n乙");
  assert.equal(n.thought, "甲");
  assert.equal(n.speech, "乙");
});

test("拆分：光有「想」不给台词——宁可空着让她重说", () => {
  const n = parseNarrative("（我 想）\n我只是想了一下。\n（/我 想）");
  assert.equal(n.thought, "我只是想了一下。");
  assert.equal(n.speech, "");
});

test("拆分：一对标签都没有时，整段当台词，且标记 tagged=false", () => {
  const n = parseNarrative("（我 说）废话\n算了直接说。");
  assert.equal(n.thought, "");
  assert.equal(n.tagged, true);
  const bare = parseNarrative("算了直接说。");
  assert.equal(bare.speech, "算了直接说。");
  assert.equal(bare.tagged, false);
});

test("标签：漏标签时剥壳兜底，不整轮作废", () => {
  assert.equal(parseTagged("（我 说）\n只有开头\n", "speech"), "只有开头");
  assert.equal(parseTagged("裸的一段话", "speech"), "裸的一段话");
  assert.equal(parseTagged("", "thought"), "");
});

test("占位：空、过短、整段括起来、'这里该说点什么' 都要被拦下", () => {
  assert.equal(isPlaceholder(""), true);
  assert.equal(isPlaceholder("嗯"), true);
  assert.equal(isPlaceholder("（这里该说点什么）"), true);
  assert.equal(isPlaceholder("我 说"), false);
  assert.equal(isPlaceholder("你倒是说说看，你今天到底在忙什么。"), false);
});

test("序列化：想的块回「想」，说的块回「说」，不混轨", () => {
  const text = serializeRecord([
    { kind: "user", text: "在吗", at: "2026-10-26T00:00:00Z" },
    { kind: "herta", surface: "thought", text: "他又来了。", at: "2026-10-26T00:00:01Z" },
    { kind: "herta", surface: "speech", text: "在。", at: "2026-10-26T00:00:02Z" },
    { kind: "system", label: "系统", body: "图片已读", at: "2026-10-26T00:00:03Z" },
  ]);
  assert.ok(text.includes("（开拓者 说）\n在吗\n（/开拓者 说）"));
  assert.ok(text.includes("（我 想）\n他又来了。\n（/我 想）"));
  assert.ok(text.includes("（我 说）\n在。\n（/我 说）"));
  assert.ok(text.includes("〔系统〕图片已读"));
});

/* ---------------------------------------------------------------- 复核 */

test("复核判定：BLOCK 取出类别与理由；没写 BLOCK 就放行", () => {
  const blocked = parseSupervisorVerdict("1. 接话 OK\n2. 声音 OK\nBLOCK：设定：她从不自称人类。");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.category, "设定");
  assert.equal(blocked.reason, "她从不自称人类。");

  assert.equal(parseSupervisorVerdict("1. 接话 OK\n2. 声音 OK\n3. 设定 OK\n4. 意图 OK\nOK").ok, true);
});

test("复核消息：用桌面版原文的 buildSupervisorPrompt，成功切成 system + user 两条", async () => {
  const a = await src.promptAssets();
  const messages = buildReviewMessages(
    {
      feianFewShots: [],
      lang: "zh",
      currentState: "默认",
      recentRecord: [{ kind: "user", text: "在吗", at: "2026-10-26T00:00:00Z" }],
      currentTurnThought: "他又来了。",
      candidateSpeech: "在。",
    },
    { buildSupervisorPrompt: H.buildSupervisorPrompt, USER_MESSAGE_SEPARATOR: H.USER_MESSAGE_SEPARATOR }
  );

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.ok(messages[0].content.length > 1000, "系统段太短，多半没读到评分标准");
  assert.ok(messages[1].content.includes("在。"), "候选台词没有进 user 段");
  assert.ok(a.hertaBio.length > 0);
});

test("复核策略：最多打回两次，之后放行免得语气散掉", () => {
  const blocked = { ok: false, category: "声音", reason: "太软", raw: "" };
  assert.equal(decideReview(blocked, 0, "在。"), "redo");
  assert.equal(decideReview(blocked, 1, "在。"), "redo");
  assert.equal(decideReview(blocked, 2, "在。"), "pass");
  assert.equal(decideReview({ ok: true, category: null, reason: null, raw: "" }, 0, "在。"), "pass");
});

test("打回话术：{{reason}} 被替换，外面那层〔〕被剥掉", async () => {
  const a = await src.promptAssets();
  const hints = vetoHints(a.hints, "把没做过的事说成做过");
  assert.ok(hints.veto.includes("把没做过的事说成做过"));
  assert.ok(!hints.veto.startsWith("〔"));
  assert.ok(!hints.veto.endsWith("〕"));
});
