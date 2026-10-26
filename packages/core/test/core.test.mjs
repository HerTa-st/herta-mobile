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
import { importSessionId, parseImportBundle, planImport, sessionFromImport } from "../src/import.ts";
import { parseSharedConversation, shareIdFromInput } from "../src/share.ts";
import { repairFeian } from "../src/feian.ts";
import { VOICE_HEADING, VOICE_MAX_CHARS, buildVoiceRevisionPrompt, cleanVoiceText } from "../src/voice.ts";
import { EMPTY_STATE } from "../src/memory.ts";
import { distillSession, segmentBlocks } from "../src/distill.ts";

/** 桌面版原文抽出来的 196 个函数：复核提示词与分隔符从它注入，不在 core 里重写。 */
import * as H from "../../../runtime/prompts-code.zh.mjs";

const ASSETS = fileURLToPath(new URL("../../../assets/", import.meta.url));
const src = new NodeAssetSource(ASSETS, "zh");

/* ------------------------------------------------------------------ 素材 */

test("素材齐：《自传、设定、话术、41 条原声、4 篇记忆》", async () => {
  const a = await src.promptAssets();
  assert.ok(a.hertaBio.length > 5000, "自传太短，多半读错了文件");
  assert.ok(a.envSet.length > 0);
  assert.ok(Object.keys(a.hints).length >= 10);

  const v = await src.voice();
  assert.equal(Object.keys(v.openings).length, 36);
  assert.equal(v.veto.length, 4);

  // 13 篇种子里的「远程办公的一百种无聊方式」那 9 篇按用户要求删掉了
  assert.equal((await src.seedFiles()).length, 4);
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
  // 桌面版的建造函数返回两条消息，不是一段字符串——测试也照这个形状来。
  const prompts = {
    buildEpisodeDigest: (blocks) => blocks.map((b) => b.text).join("\n"),
    buildWorthinessPrompt: () => ({ systemPrompt: "WORTH-SYS", userPayload: "WORTH-USER" }),
    buildGenerationPrompt: () => ({ systemPrompt: "GEN-SYS", userPayload: "GEN-USER" }),
    buildCritiquePrompt: () => ({ systemPrompt: "CRITIQUE-SYS", userPayload: "CRITIQUE-USER" }),
    buildRefinePrompt: (_draft, errors) => ({ systemPrompt: "REFINE-SYS", userPayload: "REFINE:" + errors.join("|") }),
    validateFeian: (text) =>
      text.includes("（我 说）") && text.includes("---") ? { ok: true } : { ok: false, errors: ["missing --- separator"] },
  };
  const deps = {
    store,
    prompts,
    scene: { env: "办公室", guide: "指南", lang: "zh" },
    chat: async ({ system, user }) => {
      calls.push(system + "\n" + user);
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
  // 故意缺「说」那一轨——这是机械修不了的，必须走"改一遍"
  const BAD = "### 废案_10：只有背景\n\n那天什么事都没发生。\n\n---";
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
  assert.ok(h.calls.length >= 4, "没走到改一遍：调用次数 " + h.calls.length);
});

test("做梦：改完还是不合格 → 记失败，游标照样前进", async () => {
  const h = dreamHarness({
    replies: [
      '{"worthy": true}',
      JSON.stringify({ feian: "### 废案_10：坏的\n\n---\n\n只有背景没有台词" }),
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

test("做梦：建造函数返回的两条消息要分别落到 system 与 user 上", async () => {
  const h = dreamHarness({
    replies: ['{"worthy": false}',],
  });
  await runDreamPass(h.deps, { sessionId: "s1", blocks: SIX_BLOCKS });
  assert.equal(h.calls.length, 1);
  // 第一版把整个返回对象当 content 发出去，请求体里 content 成了对象，服务端回 422。
  assert.ok(h.calls[0].startsWith("WORTH-SYS"), "system 段丢了：" + h.calls[0].slice(0, 40));
  assert.ok(h.calls[0].includes("WORTH-USER"), "user 段丢了");
});

test("做梦：建造函数只给字符串时也能发（兼容两种返回形状）", async () => {
  const h = dreamHarness({ replies: ['{"worthy": false}'] });
  h.deps.prompts.buildWorthinessPrompt = () => "只有一段";
  await runDreamPass(h.deps, { sessionId: "s1", blocks: SIX_BLOCKS });
  assert.equal(h.calls[0], "\n只有一段");
});

test("做梦：真实建造函数的返回形状是两条消息（422 那次的根因）", async () => {
  const a = await src.promptAssets();
  const worth = H.buildWorthinessPrompt("开拓者：在吗\n我：在。", [{ title: "旧记忆", tag: "日常" }], a.envSet, "zh");
  assert.equal(typeof worth, "object", "建造函数改了返回形状");
  assert.equal(typeof worth.systemPrompt, "string");
  assert.equal(typeof worth.userPayload, "string");
  assert.ok(worth.systemPrompt.length > 1000, "系统段太短");
  assert.ok(worth.userPayload.includes("在吗"), "用户段没带上对话摘录");

  const gen = H.buildGenerationPrompt("摘要", [], [], "", a.envSet, "zh");
  assert.equal(typeof gen.systemPrompt, "string");
  assert.equal(typeof gen.userPayload, "string");

  const critique = H.buildCritiquePrompt("### 废案_01：x\n\n---\n\n（我 说）\n在。\n（/我 说）", "", "zh");
  assert.equal(typeof critique.systemPrompt, "string");

  const refine = H.buildRefinePrompt("草稿", ["缺分隔线"], "", "zh");
  assert.equal(typeof refine.systemPrompt, "string");
});

test("做梦：首稿只是格式不对 → 机械修好，照样记住（不再白丢一段记忆）", async () => {
  const BAD_HEADER = "那天他嫌我慢。\n\n---\n\n（我 说）\n慢是你没算过这堆数据的体量。\n（/我 说）";
  const h = dreamHarness({
    replies: [
      '{"worthy": true}',
      JSON.stringify({ feian: BAD_HEADER, situationTag: "被嫌慢" }),
      '{"voice": 0.9, "faithfulness": 0.9, "fixes": []}',
    ],
  });
  // 这条测试要真的按规矩查首行，不能用宽松的假校验
  h.deps.prompts.validateFeian = (text) => {
    if (!/^### 废案_\d+：\S/.test(text.trimStart().split("\n")[0])) return { ok: false, errors: ["bad header"] };
    if (!/^\s*---\s*$/m.test(text)) return { ok: false, errors: ["missing --- separator"] };
    if (!text.includes("（我 说）")) return { ok: false, errors: ["missing speech"] };
    return { ok: true };
  };

  const out = await runDreamPass(h.deps, { sessionId: "s1", blocks: SIX_BLOCKS });
  assert.equal(out.kind, "made");
  assert.equal(h.calls.length, 3, "格式问题不该触发第四次调用：实际 " + h.calls.length);
  const list = await h.store.list();
  assert.ok(list.some((r) => r.sessionId === "s1"));
  assert.ok((await h.store.state()).lastNote.includes("格式我修了一下"));
});
test("做梦：模型把 JSON 包在代码块里也认得出来", () => {
  assert.deepEqual(extractJson("```json\n{\"worthy\": true}\n```"), { worthy: true });
  assert.deepEqual(extractJson("前言\n{\"a\":1}\n后记"), { a: 1 });
  assert.equal(extractJson("没有 JSON"), null);
});

/* ---------------------------------------------------------------- 导入 */

function bundleJson(overrides = {}) {
  return JSON.stringify({
    format: "herta-import",
    version: 1,
    source: "deepseek-web",
    exportedAt: "2026-10-20T10:00:00.000Z",
    collector: { name: "herta-export", version: "0.1.0" },
    sessions: [
      {
        id: "site-1",
        title: "关于模拟宇宙",
        startedAt: "2026-10-19T08:00:00.000Z",
        messages: [
          { role: "user", text: "模拟宇宙到底是什么", at: "2026-10-19T08:00:00.000Z" },
          { role: "assistant", text: "一个被我自己推翻过很多次的东西。", at: "2026-10-19T08:00:05.000Z" },
        ],
      },
    ],
    ...overrides,
  });
}

test("导入：正常包能解析，空会话被丢掉", () => {
  const r = parseImportBundle(bundleJson());
  assert.equal(r.ok, true);
  assert.equal(r.bundle.sessions.length, 1);
  assert.equal(r.bundle.sessions[0].messages.length, 2);
});

test("导入：格式/版本/结构不对时明确拒绝，并说清哪里不对", () => {
  assert.match(parseImportBundle("不是 json").error, /JSON/);
  assert.match(parseImportBundle(bundleJson({ format: "other" })).error, /格式/);
  assert.match(parseImportBundle(bundleJson({ version: 9 })).error, /版本/);
  assert.match(parseImportBundle(bundleJson({ sessions: [] })).error, /一个会话都没有/);
  assert.match(parseImportBundle(bundleJson({ sessions: [{ title: "没有 id", messages: [] }] })).error, /没有 id/);
});

test("导入：只有空白的会话不算会话", () => {
  const r = parseImportBundle(
    bundleJson({ sessions: [{ id: "x", title: "空的", messages: [{ role: "user", text: "   " }] }] })
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /空的/);
});

test("导入：转成会话时只保留「说」，别人那边的思维链不冒充她的内心", () => {
  const r = parseImportBundle(bundleJson());
  const s = sessionFromImport("deepseek-web", r.bundle.sessions[0], r.bundle.exportedAt);
  assert.equal(s.origin, "import");
  assert.equal(s.blocks.length, 2);
  assert.equal(s.blocks[0].kind, "user");
  assert.equal(s.blocks[1].kind, "herta");
  assert.equal(s.blocks[1].surface, "speech");
  assert.equal(s.id, importSessionId("deepseek-web", "site-1"));
  assert.equal(s.title, "关于模拟宇宙");
});

test("导入：重复导入按稳定 id 跳过，不会长出第二份", () => {
  const r = parseImportBundle(bundleJson());
  const first = planImport(r.bundle, new Set());
  assert.equal(first.toWrite.length, 1);
  assert.equal(first.skipped, 0);

  const again = planImport(r.bundle, new Set(first.toWrite.map((s) => s.id)));
  assert.equal(again.toWrite.length, 0);
  assert.equal(again.skipped, 1);
});

test("导入：同一份包里重复的会话也只写一次", () => {
  const one = JSON.parse(bundleJson());
  one.sessions.push(one.sessions[0]);
  const r = parseImportBundle(JSON.stringify(one));
  const plan = planImport(r.bundle, new Set());
  assert.equal(plan.toWrite.length, 1);
  assert.equal(plan.skipped, 1);
});

/* ---------------------------------------------------------------- 分享导入 */

function shareJson(messages) {
  return JSON.stringify({ code: 0, msg: "", data: { biz_code: 0, biz_data: { title: "Shared Conversation", messages } } });
}

test("分享：认出链接 / 裸 id / 带参数的链接", () => {
  assert.equal(shareIdFromInput("https://chat.deepseek.com/share/olr62jhemwjox72hm9"), "olr62jhemwjox72hm9");
  assert.equal(shareIdFromInput("https://chat.deepseek.com/share/olr62jhemwjox72hm9?from=x"), "olr62jhemwjox72hm9");
  assert.equal(shareIdFromInput("olr62jhemwjox72hm9"), "olr62jhemwjox72hm9");
  assert.equal(shareIdFromInput("随便一段话"), null);
});

test("分享：只认 REQUEST/RESPONSE，思维链不进台词", () => {
  const json = shareJson([
    { message_id: 1, parent_id: null, role: "USER", inserted_at: 1791132360, fragments: [{ type: "REQUEST", content: "在吗" }] },
    {
      message_id: 2,
      parent_id: 1,
      role: "ASSISTANT",
      inserted_at: 1791132362,
      fragments: [
        { type: "THINK", content: "我需要回答用户，先想想" },
        { type: "RESPONSE", content: "在。" },
        { type: "TOOL_SEARCH", content: "搜索了什么" },
      ],
    },
  ]);
  const r = parseSharedConversation(json);
  assert.equal(r.ok, true);
  assert.equal(r.session.messages.length, 2);
  assert.equal(r.session.messages[0].text, "在吗");
  assert.equal(r.session.messages[1].text, "在。");
  assert.ok(!JSON.stringify(r.session).includes("我需要回答用户"));
  assert.ok(r.session.messages[1].at?.startsWith("2026-"));
});

test("分享：按 parent_id 走主链，被改写的分支不会混进来", () => {
  const json = shareJson([
    { message_id: 1, parent_id: null, role: "USER", fragments: [{ type: "REQUEST", content: "一" }] },
    { message_id: 2, parent_id: 1, role: "ASSISTANT", fragments: [{ type: "RESPONSE", content: "旧回答" }] },
    { message_id: 3, parent_id: 1, role: "ASSISTANT", fragments: [{ type: "RESPONSE", content: "新回答" }] },
    { message_id: 4, parent_id: 3, role: "USER", fragments: [{ type: "REQUEST", content: "二" }] },
  ]);
  const r = parseSharedConversation(json);
  assert.equal(r.ok, true);
  const texts = r.session.messages.map((m) => m.text);
  assert.deepEqual(texts, ["一", "新回答", "二"], "分支没走对：" + JSON.stringify(texts));
});

test("分享：连续同角色合并成一条", () => {
  const json = shareJson([
    { message_id: 1, parent_id: null, role: "USER", fragments: [{ type: "REQUEST", content: "上半" }] },
    { message_id: 2, parent_id: 1, role: "USER", fragments: [{ type: "REQUEST", content: "下半" }] },
    { message_id: 3, parent_id: 2, role: "ASSISTANT", fragments: [{ type: "RESPONSE", content: "答" }] },
  ]);
  const r = parseSharedConversation(json);
  assert.equal(r.session.messages.length, 2);
  assert.equal(r.session.messages[0].text, "上半\n\n下半");
});

test("分享：空壳/坏链接要明确拒绝", () => {
  assert.match(parseSharedConversation("不是 json").error, /JSON/);
  assert.match(parseSharedConversation(shareJson([])).error, /没有对话/);
  const empty = shareJson([{ message_id: 1, parent_id: null, role: "USER", fragments: [] }]);
  assert.equal(parseSharedConversation(empty).ok, false);
});

/* ------------------------------------------------------------ 废案格式修复 */

test("修格式：没有首行就补一个，正文一字不动", () => {
  const r = repairFeian("那天他嫌我慢。\n\n---\n\n（我 说）\n慢是你没算过。\n（/我 说）", 7, "慢与体量");
  assert.equal(r.changed, true);
  assert.ok(r.text.startsWith("### 废案_07：慢与体量"));
  assert.ok(r.text.includes("（我 说）\n慢是你没算过。"));
});

test("修格式：首行写法不对就按规矩重写，标题从原行里抽", () => {
  const bad = "## 废案 12 凉掉的茶\n\n正文\n\n---\n\n（我 说）\n在。\n（/我 说）";
  const r = repairFeian(bad, 12, "兜底");
  assert.equal(r.changed, true);
  assert.ok(r.text.split("\n")[0].startsWith("### 废案_12："), "首行：" + r.text.split("\n")[0]);
});

test("修格式：少了分隔线就补在首段之后", () => {
  const noSep = "### 废案_03：无题\n\n那天的对话。\n\n（我 说）\n在。\n（/我 说）";
  const r = repairFeian(noSep, 3, "无题");
  assert.equal(r.changed, true);
  assert.ok(r.text.includes("那天的对话。\n\n---"), "分隔线没落在首段之后：\n" + r.text);
});

test("修格式：本来合规就一个字都不改", () => {
  const good = "### 废案_04：旧事\n\n正文。\n\n---\n\n（我 说）\n在。\n（/我 说）";
  const r = repairFeian(good, 4, "旧事");
  assert.equal(r.changed, false);
  assert.equal(r.text, good);
});

/* ---------------------------------------------------------------- 语气笔记 */

test("语气笔记：清掉标题/列表符号/引号，长句截在句号上", () => {
  const raw = "# 我说话的方式\n- 句子短。\n- 不耐烦就直接说。\n";
  const t = cleanVoiceText(raw);
  assert.ok(!t.includes("#"), "标题没清掉");
  assert.ok(!t.includes("- "), "列表符号没清掉");
  assert.ok(t.includes("句子短。"));

  const long = "啊".repeat(300) + "。" + "呀".repeat(300) + "。";
  const cut = cleanVoiceText(long);
  assert.ok(cut.length <= VOICE_MAX_CHARS, "没截到上限：" + cut.length);
  assert.ok(cut.endsWith("。"), "截在了半句上");
});

test("语气修订提示词：带上记忆样本与上一版笔记，且不许它输出结构标记", () => {
  const mem = [{ name: "### 废案_01：凉茶.txt", body: "正文一", createdAt: "" }];
  const p = buildVoiceRevisionPrompt(mem, "以前写的");
  assert.ok(p.user.includes("正文一"));
  assert.ok(p.user.includes("以前写的"));
  assert.ok(p.system.includes("第一人称"));
  assert.ok(p.system.includes("不要标题"));
  const empty = buildVoiceRevisionPrompt(mem, null);
  assert.ok(empty.user.includes("还没有写过"));
});

test("人格装配：语气笔记插在设定之后、处境之前", async () => {
  const a = await src.promptAssets();
  const prefix = buildStaticPrefix({ assets: a, seeds: [], voiceText: "我说话很短。" });
  const iVoice = prefix.indexOf(VOICE_HEADING);
  assert.ok(iVoice > 0, "语气段没插进去");
  assert.ok(iVoice > prefix.indexOf(a.envSet), "不该排在设定前面");
  assert.ok(iVoice < prefix.indexOf(MOBILE_NOTE), "不该排在处境后面");
  assert.ok(prefix.includes("我说话很短。"));

  const without = buildStaticPrefix({ assets: a, seeds: [] });
  assert.ok(!without.includes(VOICE_HEADING), "没笔记时不该留空标题");
});

test("做梦：攒够三篇才让她重写语气，写出来的进 state.voice", async () => {
  let asked = 0;
  const h = dreamHarness({
    replies: [
      '{"worthy": true}',
      JSON.stringify({ feian: GOOD, situationTag: "t" }),
      '{"voice": 0.9, "faithfulness": 0.9, "fixes": []}',
    ],
  });
  h.deps.reviseVoice = async (records, prev) => {
    asked += 1;
    assert.ok(records.length >= 1);
    assert.equal(prev, null);
    return "我说话很短。";
  };
  await h.store.saveState({ ...EMPTY_STATE, cursors: {}, made: 2, voice: null });

  const out = await runDreamPass(h.deps, { sessionId: "s1", blocks: SIX_BLOCKS });
  assert.equal(out.kind, "made");
  assert.equal(asked, 1, "第三篇时没触发语气重写");
  const st = await h.store.state();
  assert.equal(st.voice?.text, "我说话很短。");
  assert.equal(st.made, 3);
  assert.ok(st.lastNote.includes("改了自己说话的方式"));
});
/* ---------------------------------------------------------------- 消化 */

test("消化：按用户发言切段，每段都以开拓者开口开头", () => {
  const blocks = [];
  for (let i = 0; i < 6; i += 1) {
    blocks.push({ kind: "user", text: "u" + i, at: "" });
    blocks.push({ kind: "herta", surface: "speech", text: "a" + i, at: "" });
  }
  const g = segmentBlocks(blocks, 3, 2);
  assert.equal(g.length, 3);
  for (const seg of g) assert.equal(seg[0].kind, "user", "切在了她的半句话上");
  assert.equal(g.flat().length, blocks.length, "丢块了");
});

test("消化：段数不会超过实际轮数，短尾并进上一段", () => {
  const one = [{ kind: "user", text: "只有一句", at: "" }];
  assert.equal(segmentBlocks(one, 8, 2).length, 1);
  assert.equal(segmentBlocks([], 8).length, 0);
});

test("消化：每段落一则记忆，末尾只重写一次语气", async () => {
  const GOOD2 = "### 废案_11：第二篇\n\n那天又聊了一次。\n\n---\n\n（我 说）\n又来。\n（/我 说）";
  const h = dreamHarness({
    replies: [
      JSON.stringify({ feian: GOOD, situationTag: "被嫌慢" }),
      JSON.stringify({ feian: GOOD2, situationTag: "又来一次" }),
    ],
  });
  let voiceCalls = 0;
  h.deps.reviseVoice = async () => {
    voiceCalls += 1;
    return "我说话很短。";
  };
  const progress = [];
  const out = await distillSession(h.deps, {
    sessionId: "s1",
    blocks: SIX_BLOCKS,
    config: { chunks: 2, minBlocksPerChunk: 1 },
  }, (done, total, note) => progress.push([done, total, note]));

  assert.equal(out.made.length, 2);
  assert.equal(out.failed, 0);
  assert.equal(voiceCalls, 1, "语气应当只重写一次，实际 " + voiceCalls);
  const list = await h.store.list();
  assert.equal(list.length, 2);
  assert.ok(list.every((r) => r.sessionId === "s1"));
  assert.ok((await h.store.state()).voice?.text.includes("我说话很短"));
  assert.ok(progress.length >= 2);
});

test("消化：某段写歪了就跳过它，不拖累别的段", async () => {
  const h = dreamHarness({
    replies: [
      JSON.stringify({ feian: "现在不想写", situationTag: "坏的" }),
      JSON.stringify({ feian: GOOD, situationTag: "好的" }),
    ],
  });
  const out = await distillSession(h.deps, {
    sessionId: "s1",
    blocks: SIX_BLOCKS,
    config: { chunks: 2, minBlocksPerChunk: 1 },
  });
  assert.equal(out.made.length, 1);
  assert.equal(out.failed, 1);
  assert.equal((await h.store.list()).length, 1);
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
