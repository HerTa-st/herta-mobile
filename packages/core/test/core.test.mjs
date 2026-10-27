import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { NodeAssetSource } from "../src/assets-node.ts";
import { buildStaticPrefix, moodStyleNote, pickSeeds, MOBILE_NOTE, FORMAT_CONTRACT } from "../src/persona.ts";
import { extractTagged, parseTagged, isPlaceholder, serializeRecord, parseSupervisorVerdict } from "../src/tags.ts";
import { parseNarrative, stripStageDirections } from "../src/narrative.ts";
import { buildReviewMessages, decideReview, vetoHints } from "../src/supervisor.ts";
import { EMPTY_TITLE, appendBlocks, createSession, deriveTitle, retractLastTurn, trimForContext } from "../src/session.ts";
import { isUserTurn } from "../src/sticker.ts";
import { MemoryInMemory, memoryFileName, memoryTitle, nextMemoryIndex } from "../src/memory.ts";
import { extractJson, runDreamPass } from "../src/dream.ts";
import { importSessionId, parseImportBundle, planImport, sessionFromImport } from "../src/import.ts";
import { parseSharedConversation, shareIdFromInput } from "../src/share.ts";
import { repairFeian } from "../src/feian.ts";
import { VOICE_HEADING, VOICE_MAX_CHARS, buildVoiceRevisionPrompt, cleanVoiceText } from "../src/voice.ts";
import { EMPTY_STATE } from "../src/memory.ts";
import { distillSession, segmentBlocks } from "../src/distill.ts";
import {
  effectiveWeight,
  reinforce,
  shouldConsolidate,
  shouldForget,
  pickForgettable,
} from "../src/weights.ts";
import { applyConsolidatePlan, buildConsolidatePrompt, consolidateMemories, forgetMemories, parseConsolidatePlan } from "../src/consolidate.ts";
import { searchMemories, searchSessions, snippetOf } from "../src/search.ts";
import { runToolLoop, toProviderMessages, toProviderTools } from "../src/tools.ts";
import { MOOD_TTL_MS, buildMoodPrompt, decideMood, parseMoodVerdict } from "../src/mood.ts";
import { humanizeError, splitApiError } from "../src/errors.ts";
import { buildPresenceNote, presenceAt, timePhrase } from "../src/presence.ts";
import { planImageSlices } from "../src/image.ts";
import { addUsage, emptyUsage, formatTokens, usageTotal } from "../src/usage.ts";
import { budgetFor } from "../src/budget.ts";

/** 桌面版原文抽出来的 196 个函数：复核提示词与分隔符从它注入，不在 core 里重写。 */
import * as H from "../../../runtime/prompts-code.zh.mjs";

const ASSETS = fileURLToPath(new URL("../../../assets/", import.meta.url));
const src = new NodeAssetSource(ASSETS, "zh");

/* ------------------------------------------------------------------ 素材 */

test("素材齐：《自传、话术、4 条 veto 原声、4 篇记忆》（开局与设定已删）", async () => {
  const a = await src.promptAssets();
  assert.ok(a.hertaBio.length > 5000, "自传太短，多半读错了文件");
  // 办公室设定与语气指南都删了：她不再永远坐在同一个房间，语气也不是别人写死的
  assert.equal("envSet" in a, false, "办公室设定又被打进包了");
  assert.equal("hertaGuide" in a, false, "语气指南又被打进包了");
  assert.ok(Object.keys(a.hints).length >= 10);

  const v = await src.voice();
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

test("人格：输出契约要求「说」里带一点动作，但不许写成舞台说明", async () => {
  const a = await src.promptAssets();
  const prefix = buildStaticPrefix({ assets: a, seeds: [] });
  assert.ok(FORMAT_CONTRACT.includes("「说」里带一点动作"));
  assert.ok(prefix.includes("（转了下椅子）"), "要给出可仿照的样子");
  assert.ok(prefix.includes("「想」里没有身体"), "动作只写在说里");
});

test("念白：动作标注不念出来，f(x) 这种不能误伤", () => {
  assert.equal(stripStageDirections("（转了下椅子）行吧，说重点。"), "行吧，说重点。");
  assert.equal(stripStageDirections("手停了一下。\n（把凉茶推远）"), "手停了一下。");
  assert.equal(stripStageDirections("函数 f(x) 的返回值是 0。"), "函数 f(x) 的返回值是 0。");
  assert.equal(stripStageDirections("（笑）"), "", "只有动作就没有可念的");
  assert.equal(stripStageDirections("(笑了笑)走吧"), "走吧");
});

test("静态前缀：顺序是 自传 → 种子 → 此刻在哪 → 处境 → 契约", async () => {
  const a = await src.promptAssets();
  const presence = buildPresenceNote(presenceAt(new Date(2026, 9, 27, 14, 0)), "现在是下午2点");
  const prefix = buildStaticPrefix({ assets: a, seeds: ["### 废案_01：测试\n正文"], presence });
  const iSeed = prefix.indexOf("### 废案_01：测试");
  const iPresence = prefix.indexOf("### 你此刻在哪");
  assert.ok(iSeed > prefix.indexOf(a.hertaBio.slice(0, 200)), "种子跑到了自传前面");
  assert.ok(iPresence > iSeed, "行踪跑到了种子前面");
  assert.ok(iPresence < prefix.indexOf(MOBILE_NOTE), "行踪应排在处境之前");
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

/* ---------------------------------------------------------------- 会话 */

test("标题：从第一条用户消息取，句末断行，超长加省略号", () => {
  const b = (text) => [{ kind: "user", text, at: "2026-10-26T00:00:00Z" }];
  assert.equal(deriveTitle([]), EMPTY_TITLE);
  assert.equal(deriveTitle(b("在干嘛呀")), "在干嘛呀");
  assert.equal(deriveTitle(b("你今天怎么这么慢？我等了半天了")), "你今天怎么这么慢？");
  assert.ok(deriveTitle(b("这是一段特别特别长的没有标点的话说了很多很多字")).endsWith("…"));
});

test("标题：只发图那条一个字都没有，也不能退回「新的对话」", () => {
  const pics = [
    {
      kind: "user",
      text: "",
      at: "2026-10-26T00:00:00Z",
      attachments: [{ mediaType: "image/jpeg", data: "data:image/jpeg;base64,AA", name: "a.jpg" }],
    },
  ];
  assert.equal(deriveTitle(pics), "（一张图）");
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
  const env = "### 你此刻在哪\n\n现在是下午2点。你在实验室。";
  const worth = H.buildWorthinessPrompt("开拓者：在吗\n我：在。", [{ title: "旧记忆", tag: "日常" }], env, "zh");
  assert.equal(typeof worth, "object", "建造函数改了返回形状");
  assert.equal(typeof worth.systemPrompt, "string");
  assert.equal(typeof worth.userPayload, "string");
  assert.ok(worth.systemPrompt.length > 1000, "系统段太短");
  assert.ok(worth.userPayload.includes("在吗"), "用户段没带上对话摘录");

  const gen = H.buildGenerationPrompt("摘要", [], [], "", env, "zh");
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

/* ---------------------------------------------------------------- 权重 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-27T00:00:00Z");
function mem(name, extra = {}) {
  return { name, body: "正文", createdAt: "2026-10-27T00:00:00.000Z", ...extra };
}

test("权重：不动会衰减，90 天掉一半", () => {
  const r = mem("### 废案_10：a.txt", { weight: 0.8, createdAt: "2026-07-29T00:00:00Z" });
  const w = effectiveWeight(r, NOW);
  assert.ok(Math.abs(w - 0.4) < 0.02, "实际 " + w);
  const fresh = mem("### 废案_10：b.txt", { weight: 0.8 });
  assert.ok(effectiveWeight(fresh, NOW) > 0.79);
});

test("权重：被想起一次就变重、刷新时间", () => {
  const old = mem("### 废案_10：a.txt", { weight: 0.4, lastRecallAt: "2026-01-01T00:00:00Z", recalls: 2 });
  const after = reinforce(old, NOW);
  assert.ok(after.weight > old.weight);
  assert.equal(after.recalls, 3);
  assert.equal(after.lastRecallAt, new Date(NOW).toISOString());
  assert.ok(effectiveWeight(after, NOW) > effectiveWeight(old, NOW));
});

test("阈值：20 条整理一次，50 条遗忘一次", () => {
  assert.equal(shouldConsolidate(19, null), false);
  assert.equal(shouldConsolidate(20, null), true);
  assert.equal(shouldConsolidate(25, 20), false);
  assert.equal(shouldConsolidate(40, 20), true);
  assert.equal(shouldForget(49), false);
  assert.equal(shouldForget(50), true);
});

test("遗忘：挑权重最低的，但护住语气锚点与高权重", () => {
  const records = [
    mem("### 废案_00：锚点.txt", { weight: 0.1 }),
    mem("### 废案_10：轻.txt", { weight: 0.12 }),
    mem("### 废案_11：更轻.txt", { weight: 0.05 }),
    mem("### 废案_12：重.txt", { weight: 0.9 }),
    mem("### 废案_13：已忘.txt", { weight: 0.01, forgotten: true }),
  ];
  const picked = pickForgettable(records, NOW, 10).map((r) => r.name);
  assert.deepEqual(picked, ["### 废案_11：更轻.txt", "### 废案_10：轻.txt"], "挑错了：" + picked.join(","));
  assert.ok(!picked.includes("### 废案_00：锚点.txt"), "语气锚点被挑走了");
  assert.ok(!picked.includes("### 废案_12：重.txt"), "高权重的被挑走了");
});

/* ---------------------------------------------------------------- 整理 */

test("整理：提示词带文件名与权重，解析时丢掉编造的名字", () => {
  const records = [mem("### 废案_10：a.txt", { weight: 0.9 }), mem("### 废案_11：b.txt", { weight: 0.2 })];
  const p = buildConsolidatePrompt(records, NOW);
  assert.ok(p.user.includes("### 废案_10：a.txt"));
  assert.ok(p.user.includes("0.90"));

  const plan = parseConsolidatePlan(
    {
      links: [["### 废案_10：a.txt", "### 废案_11：b.txt"], ["### 废案_10：a.txt", "编的.txt"], ["### 废案_10：a.txt", "### 废案_10：a.txt"]],
      simplify: [{ name: "### 废案_11：b.txt", gist: "他嫌我慢" }, { name: "编的", gist: "x" }],
      deepen: [{ name: "### 废案_10：a.txt", note: "补上那天的天气" }],
    },
    new Set(records.map((r) => r.name))
  );
  assert.equal(plan.links.length, 1, "编造的或自连的没被丢掉");
  assert.equal(plan.simplify.length, 1);
  assert.equal(plan.deepen.length, 1);
});

test("整理：关联是双向的，简化写要点，加深抬权重", () => {
  const a = mem("### 废案_10：a.txt", { weight: 0.9 });
  const b = mem("### 废案_11：b.txt", { weight: 0.2 });
  const { next, touched } = applyConsolidatePlan(
    [a, b],
    {
      links: [["### 废案_10：a.txt", "### 废案_11：b.txt"]],
      simplify: [{ name: "### 废案_11：b.txt", gist: "他嫌我慢" }],
      deepen: [{ name: "### 废案_10：a.txt", note: "补天气" }],
    },
    NOW
  );
  const na = next.find((r) => r.name === "### 废案_10：a.txt");
  const nb = next.find((r) => r.name === "### 废案_11：b.txt");
  assert.deepEqual(na.links, ["### 废案_11：b.txt"]);
  assert.deepEqual(nb.links, ["### 废案_10：a.txt"]);
  assert.equal(nb.gist, "他嫌我慢");
  assert.ok(na.weight > 0.9 - 0.001);
  assert.equal(na.deepenNote, "补天气");
  assert.equal(touched, 2);
});

test("整理：端到端跑一次，落库的是改过的记录", async () => {
  const store = new MemoryInMemory([
    mem("### 废案_10：a.txt", { weight: 0.9 }),
    mem("### 废案_11：b.txt", { weight: 0.2 }),
  ]);
  const out = await consolidateMemories(
    {
      store,
      chat: async () =>
        JSON.stringify({
          links: [["### 废案_10：a.txt", "### 废案_11：b.txt"]],
          simplify: [{ name: "### 废案_11：b.txt", gist: "一句要点" }],
          deepen: [],
        }),
      now: () => NOW,
    },
    extractJson
  );
  assert.equal(out.touched, 2);
  const list = await store.list();
  assert.equal(list.find((r) => r.name === "### 废案_11：b.txt").gist, "一句要点");
});

test("遗忘：标记而不是删除，还能翻出来", async () => {
  const store = new MemoryInMemory([
    mem("### 废案_10：轻.txt", { weight: 0.05 }),
    mem("### 废案_11：重.txt", { weight: 0.95 }),
  ]);
  const victims = await forgetMemories(store, NOW, 10);
  assert.equal(victims.length, 1);
  assert.equal(victims[0].name, "### 废案_10：轻.txt");
  const list = await store.list();
  assert.equal(list.length, 2, "记录被删掉了，应该只是标记");
  assert.equal(list.find((r) => r.name === "### 废案_10：轻.txt").forgotten, true);
});

/* ---------------------------------------------------------------- 检索 */

function sess(id, title, blocks) {
  return { id, title, origin: "phone", createdAt: "", updatedAt: "", blocks };
}

test("检索：命中会话里的消息，给出块号与上下文", () => {
  const s = sess("s1", "关于模拟宇宙", [
    { kind: "user", text: "模拟宇宙到底是什么", at: "" },
    { kind: "herta", surface: "speech", text: "一个被我推翻过很多次的东西。", at: "" },
    { kind: "user", text: "那你在里面测什么", at: "" },
  ]);
  const got = searchSessions([s], "模拟宇宙");
  assert.equal(got.length, 1);
  assert.equal(got[0].sessionId, "s1");
  assert.equal(got[0].hits.length, 1);
  assert.equal(got[0].hits[0].index, 0);
  assert.ok(got[0].hits[0].snippet.includes("模拟宇宙"));
});

test("检索：标题命中但正文没命中，也要列出来", () => {
  const s = sess("s2", "关于模拟宇宙", [{ kind: "user", text: "在吗", at: "" }]);
  const got = searchSessions([s], "模拟宇宙");
  assert.equal(got.length, 1);
  assert.equal(got[0].hits.length, 0);
  assert.equal(got[0].score, 2);
});

test("检索：英文不分大小写，中文按子串", () => {
  const s = sess("s3", "t", [{ kind: "user", text: "用 DeepSeek API 跑一下", at: "" }]);
  assert.equal(searchSessions([s], "deepseek").length, 1);
  assert.equal(searchSessions([s], "DEEPSEEK").length, 1);
  assert.equal(searchSessions([s], "跑一下").length, 1);
  assert.equal(searchSessions([s], "没出现").length, 0);
});

test("检索：单个会话最多给三条命中，空查询直接返回空", () => {
  const blocks = Array.from({ length: 8 }, (_, i) => ({ kind: "user", text: "重复词 " + i, at: "" }));
  const s = sess("s4", "t", blocks);
  assert.equal(searchSessions([s], "重复词")[0].hits.length, 3);
  assert.equal(searchSessions([s], "   ").length, 0);
});

test("检索：记忆按标题/正文命中，已遗忘的搜不到", () => {
  // 真实记录的正文首行就是标题行，memoryTitle 是从那里取的
  const records = [
    { name: "### 废案_10：凉茶.txt", body: "### 废案_10：凉茶\n\n第三杯茶凉了。", createdAt: "" },
    { name: "### 废案_11：旧事.txt", body: "### 废案_11：旧事\n\n他又提起凉茶。", createdAt: "" },
    { name: "### 废案_12：忘的.txt", body: "### 废案_12：忘的\n\n凉茶凉茶凉茶。", createdAt: "", forgotten: true },
  ];
  const got = searchMemories(records, "凉茶");
  assert.equal(got.length, 2, "已遗忘的应当被跳过");
  assert.ok(got[0].score >= got[1].score);
  assert.ok(got.some((h) => h.title === "凉茶"));
});

test("检索：片段围绕命中处截取，两端加省略号", () => {
  const long = "前".repeat(80) + "目标词" + "后".repeat(80);
  const s = snippetOf(long, "目标词", 10);
  assert.ok(s.startsWith("…"));
  assert.ok(s.endsWith("…"));
  assert.ok(s.includes("目标词"));
  assert.ok(s.length < 40);
});

/* ---------------------------------------------------------------- 用量 */

test("用量：缩写只占一行，且不会出现 1000k", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(856), "856");
  assert.equal(formatTokens(1000), "1k");
  assert.equal(formatTokens(1234), "1.2k");
  assert.equal(formatTokens(12_345), "12.3k");
  assert.equal(formatTokens(123_456), "123k");
  assert.equal(formatTokens(999_600), "1M", "999.6k 要进位成 1M，不能写 1000k");
  assert.equal(formatTokens(4_100_000), "4.1M");
  assert.equal(formatTokens(Number.NaN), "0", "接口给了脏数据也不能把 NaN 写上屏");
});

test("用量：累加时 cached 与 calls 不能丢", () => {
  const a = addUsage(emptyUsage(), { prompt: 100, completion: 10, cached: 40, calls: 1 });
  const b = addUsage(a, { prompt: 300, completion: 20, cached: 200, calls: 2 });
  assert.equal(usageTotal(b), 430);
  assert.equal(b.cached, 240);
  assert.equal(b.calls, 3);
  assert.equal(usageTotal(addUsage(b, null)), 430, "接口没给 usage 就当没发生");
});

/* ---------------------------------------------------------------- 预算 */

test("预算：正常档照旧；省 token 档砍掉心情与复核、压小上下文", () => {
  const full = budgetFor({ cheap: false, moodEnabled: true, reviewEnabled: true, contextBlocks: 24, memorySeeds: 3 });
  assert.equal(full.mood, true);
  assert.equal(full.review, true);
  assert.equal(full.contextBlocks, 24);
  assert.equal(full.memorySeeds, 3);
  // 能力变多之后读类放到八轮；写类另有"一轮三次"的门（见 core/tools.ts）
  assert.equal(full.toolRounds, 8);
  assert.equal(full.imagePieces, 12);

  const cheap = budgetFor({ cheap: true, moodEnabled: true, reviewEnabled: true, contextBlocks: 24, memorySeeds: 3 });
  assert.equal(cheap.mood, false, "判心情是整次请求，省 token 档必须关");
  assert.equal(cheap.review, false);
  assert.equal(cheap.contextBlocks, 8);
  assert.equal(cheap.memorySeeds, 1);
  assert.equal(cheap.toolRounds, 2);
  assert.equal(cheap.imagePieces, 4);
});

test("预算：你自己已经调得更省时，开关不该把数值调大", () => {
  const b = budgetFor({ cheap: true, moodEnabled: false, reviewEnabled: true, contextBlocks: 4, memorySeeds: 0 });
  assert.equal(b.contextBlocks, 4);
  assert.equal(b.memorySeeds, 0);
  assert.equal(b.mood, false);
  assert.equal(b.review, false);
});

/* ---------------------------------------------------------------- 工具 */

function toolStream(script) {
  // script: 每轮的增量数组
  let round = 0;
  return async function* () {
    const deltas = script[round] ?? [{ type: "text", text: "没了" }, { type: "done", finishReason: "stop" }];
    round += 1;
    for (const d of deltas) yield d;
  };
}

function fakeTool(name, fn) {
  return { spec: { name, description: "", parameters: { type: "object", properties: {} } }, run: fn };
}

test("工具循环：不调工具，就是一次普通回答", async () => {
  const gen = toolStream([[{ type: "text", text: "在。" }, { type: "done", finishReason: "stop" }]]);
  const out = await runToolLoop({ tools: [], stream: () => gen() }, [{ role: "user", content: "在吗" }]);
  assert.equal(out.text, "在。");
  assert.equal(out.rounds, 1);
  assert.equal(out.results.length, 0);
});

test("工具循环：调一次工具，结果回灌后再回答", async () => {
  const seen = [];
  const gen = toolStream([
    [
      { type: "tool_call", index: 0, id: "c1", name: "now", arguments: "{}" },
      { type: "done", finishReason: "tool_calls" },
    ],
    [{ type: "text", text: "现在下午三点。" }, { type: "done", finishReason: "stop" }],
  ]);
  const out = await runToolLoop(
    {
      tools: [fakeTool("now", async () => "15:00")],
      stream: (r) => {
        seen.push(r.messages.length);
        return gen();
      },
    },
    [{ role: "user", content: "几点了" }]
  );
  assert.equal(out.text, "现在下午三点。");
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].content, "15:00");
  assert.equal(seen[1], 3, "第二轮应带上 assistant(工具调用) 与 tool 结果：" + seen.join(","));
});

test("工具循环：参数分几段到也能拼起来", async () => {
  let got = null;
  const gen = toolStream([
    [
      { type: "tool_call", index: 0, id: "c1", name: "calc", arguments: '{"co' },
      { type: "tool_call", index: 0, name: "calc", arguments: 'de":"1+1"}' },
      { type: "done", finishReason: "tool_calls" },
    ],
    [{ type: "text", text: "算完了" }, { type: "done", finishReason: "stop" }],
  ]);
  await runToolLoop(
    { tools: [fakeTool("calc", async (args) => { got = args; return String(args.code); })], stream: () => gen() },
    [{ role: "user", content: "算一下" }]
  );
  assert.deepEqual(got, { code: "1+1" });
});

test("工具循环：工具抛错与工具不存在都记成失败，不中断这一轮", async () => {
  const gen = toolStream([
    [
      { type: "tool_call", index: 0, id: "c1", name: "boom", arguments: "{}" },
      { type: "tool_call", index: 1, id: "c2", name: "nope", arguments: "{}" },
      { type: "done", finishReason: "tool_calls" },
    ],
    [{ type: "text", text: "都没成。" }, { type: "done", finishReason: "stop" }],
  ]);
  const out = await runToolLoop(
    {
      tools: [fakeTool("boom", async () => { throw new Error("炸了"); })],
      stream: () => gen(),
    },
    [{ role: "user", content: "试试" }]
  );
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].ok, false);
  assert.ok(out.results[0].content.includes("炸了"));
  assert.equal(out.results[1].ok, false);
  assert.ok(out.results[1].content.includes("没有这个工具"));
  assert.equal(out.text, "都没成。");
});

test("工具循环：轮数封顶，不让一个想不清楚的模型烧光额度", async () => {
  const one = [{ type: "tool_call", index: 0, id: "c", name: "now", arguments: "{}" }, { type: "done", finishReason: "tool_calls" }];
  const gen = toolStream([one, one, one, one, one]);
  const out = await runToolLoop(
    { tools: [fakeTool("now", async () => "x")], stream: () => gen(), maxRounds: 3 },
    [{ role: "user", content: "循环" }]
  );
  assert.equal(out.rounds, 3);
  assert.equal(out.results.length, 3);
});

test("工具循环：写类一轮最多三次，第四次起不执行、也不算报错", async () => {
  let ran = 0;
  const writeTool = {
    spec: { name: "remind", description: "", parameters: { type: "object", properties: {} }, kind: "write" },
    run: async () => {
      ran += 1;
      return "排好了";
    },
  };
  // 一轮里连要五次写：轮次拦不住它（八轮才封顶），写的那道门要拦
  const calls = [0, 1, 2, 3, 4].map((i) => ({
    type: "tool_call",
    index: i,
    id: "c" + i,
    name: "remind",
    arguments: "{}",
  }));
  const gen = toolStream([
    [...calls, { type: "done", finishReason: "tool_calls" }],
    [{ type: "text", text: "都办好了。" }, { type: "done", finishReason: "stop" }],
  ]);
  const out = await runToolLoop({ tools: [writeTool], stream: () => gen() }, [{ role: "user", content: "排五条" }]);
  assert.equal(ran, 3, "写类应当只执行三次");
  assert.equal(out.results.filter((r) => r.ok).length, 3);
  assert.ok(out.results[3].content.includes("已经动了 3 次"), "第四次应当被拦下并说清原因");
});

test("工具循环：每一轮的 usage 都累加，数得出调用了几次", async () => {
  const gen = toolStream([
    [
      { type: "tool_call", index: 0, id: "c1", name: "now", arguments: "{}" },
      { type: "usage", usage: { prompt: 1200, completion: 30, cached: 1000 } },
      { type: "done", finishReason: "tool_calls" },
    ],
    [
      { type: "text", text: "三点。" },
      { type: "usage", usage: { prompt: 1400, completion: 20, cached: 1300 } },
      { type: "done", finishReason: "stop" },
    ],
  ]);
  const out = await runToolLoop(
    { tools: [fakeTool("now", async () => "15:00")], stream: () => gen() },
    [{ role: "user", content: "几点" }]
  );
  assert.equal(out.usage.prompt, 2600);
  assert.equal(out.usage.completion, 50);
  assert.equal(out.usage.cached, 2300);
  assert.equal(out.usage.calls, 2, "两轮 = 两次请求");
});

test("工具格式：必须带 type=function 与内层 function（422 missing field type 的根因）", () => {
  const [t] = toProviderTools([{ name: "now", description: "查时间", parameters: { type: "object", properties: {} } }]);
  assert.equal(t.type, "function");
  assert.equal(t.function.name, "now");
  assert.equal(t.function.description, "查时间");
  assert.deepEqual(t.function.parameters, { type: "object", properties: {} });
});

test("工具格式：assistant 的 tool_calls 与 tool 结果也要转成接口形状", () => {
  const out = toProviderMessages([
    { role: "user", content: "几点了" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "now", arguments: "{}" }] },
    { role: "tool", tool_call_id: "c1", name: "now", content: "15:00" },
  ]);
  assert.equal(out[0].role, "user");
  assert.equal(out[1].tool_calls[0].type, "function");
  assert.equal(out[1].tool_calls[0].function.name, "now");
  assert.equal(out[1].tool_calls[0].function.arguments, "{}");
  assert.equal(out[2].role, "tool");
  assert.equal(out[2].tool_call_id, "c1");
});

test("工具格式：带图的消息内容原样放行，image_url 片段不能被拍平成字符串", () => {
  const out = toProviderMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "这张图里是什么" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA" } },
      ],
    },
  ]);
  assert.ok(Array.isArray(out[0].content));
  assert.equal(out[0].content[0].type, "text");
  assert.equal(out[0].content[1].type, "image_url");
  assert.equal(out[0].content[1].image_url.url, "data:image/jpeg;base64,AA");
});

/* ---------------------------------------------------------------- 心情 */

const MOODS = ["默认", "被烦版", "教学版", "被戳穿版", "任务部署版", "板砖代答版", "被顶嘴版", "倾听版"];

test("心情：从答案里拆出状态与触发位", () => {
  assert.deepEqual(parseMoodVerdict("被烦版|1", MOODS), { mood: "被烦版", triggered: true });
  assert.deepEqual(parseMoodVerdict("教学版 | 0", MOODS), { mood: "教学版", triggered: false });
  assert.deepEqual(parseMoodVerdict("被顶嘴版|是", MOODS), { mood: "被顶嘴版", triggered: true });
  assert.deepEqual(parseMoodVerdict("我觉得是倾听版吧", MOODS), { mood: "倾听版", triggered: null });
  assert.deepEqual(parseMoodVerdict("不知道", MOODS), { mood: null, triggered: null });
  assert.deepEqual(parseMoodVerdict("", MOODS), { mood: null, triggered: null });
  assert.deepEqual(parseMoodVerdict(null, MOODS), { mood: null, triggered: null });
});

const VOLATILE = ["被烦版", "被戳穿版", "被顶嘴版", "倾听版"];

test("心情：平静档之间随语境微调，不需要触发", () => {
  const t = 1_000_000;
  const prev = { mood: "默认", at: t };
  // 问原理：默认 → 教学版，是语气微调，不是心情剧变
  assert.equal(decideMood(prev, { mood: "教学版", triggered: false }, t + 60_000, { volatile: VOLATILE }).mood, "教学版");
  // 派活：教学版 → 任务部署版，同样允许
  assert.equal(
    decideMood({ mood: "教学版", at: t }, { mood: "任务部署版", triggered: false }, t + 60_000, { volatile: VOLATILE }).mood,
    "任务部署版"
  );
});

test("心情：进带情绪的档位必须真的踩到雷区/好感区", () => {
  const t = 1_000_000;
  const prev = { mood: "默认", at: t };
  assert.equal(decideMood(prev, { mood: "被顶嘴版", triggered: false }, t + 60_000, { volatile: VOLATILE }).mood, "默认");
  assert.equal(decideMood(prev, { mood: "被顶嘴版", triggered: true }, t + 60_000, { volatile: VOLATILE }).mood, "被顶嘴版");
  // 气消了回落不需要触发，也不该被按住
  assert.equal(decideMood({ mood: "被顶嘴版", at: t }, { mood: "默认", triggered: false }, t + 60_000, { volatile: VOLATILE }).mood, "默认");
});

test("心情：没标触发位时，同一个新状态连着提两次才认", () => {
  const t = 1_000_000;
  const prev = { mood: "默认", at: t };
  const once = decideMood(prev, { mood: "被烦版", triggered: null }, t + 60_000, { volatile: VOLATILE });
  assert.equal(once.mood, "默认");
  assert.equal(once.state.pending, "被烦版");
  assert.equal(decideMood(once.state, { mood: "被烦版", triggered: null }, t + 120_000, { volatile: VOLATILE }).mood, "被烦版");
});

test("心情：不认识的档位清单时按最保守的来（全都算带情绪）", () => {
  const t = 1_000_000;
  const prev = { mood: "默认", at: t };
  assert.equal(decideMood(prev, { mood: "教学版", triggered: false }, t + 60_000).mood, "默认");
  assert.equal(decideMood(prev, { mood: "教学版", triggered: true }, t + 60_000).mood, "教学版");
});

test("心情：判不出来就保持原样，不重置成默认；隔太久才翻篇", () => {
  const t = 1_000_000;
  const prev = { mood: "被顶嘴版", at: t };
  assert.equal(decideMood(prev, { mood: null, triggered: null }, t + 60_000).mood, "被顶嘴版");
  // 三小时没说话：上一轮的脾气不再作数，这一轮重新起算（平静档直接起）
  assert.equal(decideMood(prev, { mood: "教学版", triggered: false }, t + MOOD_TTL_MS + 1, { volatile: VOLATILE }).mood, "教学版");
  // 没有上一轮时：平静档直接用；带情绪的档位仍然要触发才进得去
  assert.equal(decideMood(null, { mood: "教学版", triggered: false }, t, { volatile: VOLATILE }).mood, "教学版");
  assert.equal(decideMood(null, { mood: "倾听版", triggered: false }, t, { volatile: VOLATILE }).mood, "默认");
  assert.equal(decideMood(null, { mood: "倾听版", triggered: true }, t, { volatile: VOLATILE }).mood, "倾听版");
});

test("心情：判定提示词把最近对话、上一轮状态与惯性规则都给到", () => {
  const pack = { version: 1, system: "SYS", userInstruction: "挑一个心情名回答", moods: ["默认", "被烦版"] };
  const p = buildMoodPrompt(pack, "他：在吗\n我：在。", "被烦版");
  assert.equal(p.system, "SYS");
  assert.ok(p.user.includes("在吗"));
  assert.ok(p.user.includes("挑一个心情名回答"));
  assert.ok(p.user.includes("被烦版"), "要把她现在的状态交下去");
  assert.ok(p.user.includes("情绪惯性"));
  assert.ok(p.user.includes("状态名|触发"));
});

test("心情：素材里的输出契约与「带情绪的档位」清单都在", async () => {
  const pack = await src.mood();
  assert.ok(pack);
  assert.ok(pack.system.includes("状态名|触发"), "缺了触发位，惯性就只剩兜底");
  assert.ok(pack.userInstruction.includes("触发"));
  assert.deepEqual(pack.volatile, VOLATILE, "清单变了就要同步改判定，不然剧变会漏进来");
});

test("心情：旁注取不到就返回 null，不瞎安一个", async () => {
  const a = await src.promptAssets();
  assert.equal(moodStyleNote(a, "不存在的心情"), null);
  const anyMood = Object.keys(a.metaThink?.preThink ?? {})[0];
  if (anyMood) assert.ok((moodStyleNote(a, anyMood) ?? "").length > 0);
});

/* ---------------------------------------------------------------- 行踪 */

test("行踪：按钟点给出地点与动作", () => {
  const at = (h) => presenceAt(new Date(2026, 9, 27, h, 30));
  assert.ok(at(2).phase === "凌晨");
  assert.ok(at(9).phase === "上午");
  assert.ok(at(12).phase === "中午");
  assert.ok(at(23).phase === "夜里");
  for (const h of [0, 6, 9, 12, 15, 18, 21, 23]) {
    const p = at(h);
    assert.ok(p.place.length > 0 && p.doing.length > 0, h + " 点没有行踪");
  }
});

test("行踪：同一天同一时段是确定的，隔天才可能换", () => {
  const a1 = presenceAt(new Date(2026, 9, 27, 14, 5));
  const a2 = presenceAt(new Date(2026, 9, 27, 14, 55));
  assert.deepEqual(a1, a2, "同一天同一时段给了两种说法");
  const days = [];
  for (let d = 1; d <= 10; d += 1) days.push(presenceAt(new Date(2026, 9, d, 14, 0)).doing);
  assert.ok(new Set(days).size > 1, "十天里一次都没换过，等于静止布景");
});

test("行踪：说出来的时间像人话", () => {
  assert.ok(timePhrase(new Date(2026, 9, 27, 1, 5)).startsWith("现在是凌晨1点"));
  assert.ok(timePhrase(new Date(2026, 9, 27, 12, 30)).includes("半"));
  assert.ok(timePhrase(new Date(2026, 9, 27, 23, 50)).startsWith("现在是深夜11点"));
});

test("行踪：拼出来的段落带地点、动作与「这不是设定」这句提醒", () => {
  const p = presenceAt(new Date(2026, 9, 27, 14, 0));
  const note = buildPresenceNote(p, timePhrase(new Date(2026, 9, 27, 14, 0)));
  assert.ok(note.includes(p.place));
  assert.ok(note.includes(p.doing));
  assert.ok(note.includes("这不是设定"));
});

/* ---------------------------------------------------------------- 报错 */

test("报错：模型名填错时直接说该改哪一项", () => {
  const raw =
    '模型接口 400: {"error":{"message":"The supported API model names are deepseek-v4-pro, but you passed DeepSeek-V4.1-Flash-1017.","type":"invalid_request_error"}}';
  const human = humanizeError(raw);
  assert.ok(human.includes("模型名填错了"), human);
  assert.ok(human.includes("deepseek-v4-pro"), "没指出正确的名字：" + human);
  assert.ok(human.includes("不是 App 里看到的显示名"));
  assert.ok(!human.includes("invalid_request_error"), "把原始 JSON 也贴回来了");
  const parts = splitApiError(raw);
  assert.equal(parts.status, 400);
});

test("报错：401/402/429 各说一句话，不带 JSON", () => {
  assert.ok(humanizeError('模型接口 401: {"error":{"message":"Authentication Fails"}}').includes("Key 不对"));
  assert.ok(humanizeError("模型接口 402: {}").includes("余额不足"));
  assert.ok(humanizeError("模型接口 429: {}").includes("限流"));
});

test("报错：认不出来的就原样给，但截断", () => {
  const long = "模型接口 418: " + "x".repeat(500);
  const out = humanizeError(long);
  assert.ok(out.length <= 240, "没截断：" + out.length);
  assert.ok(out.includes("418"));
  assert.equal(humanizeError(""), "");
  assert.equal(humanizeError("普通的一句话"), "普通的一句话");
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

test("序列化：带图的那句要留一行「附了一张图」，只发图时不能是空白", () => {
  const att = [{ mediaType: "image/jpeg", data: "data:image/jpeg;base64,AA", name: "a.jpg" }];
  const withText = serializeRecord([{ kind: "user", text: "能看到图吗", at: "2026-10-26T00:00:00Z", attachments: att }]);
  assert.ok(withText.includes("能看到图吗\n（附了一张图：a.jpg）"));

  const only = serializeRecord([{ kind: "user", text: "", at: "2026-10-26T00:00:00Z", attachments: att }]);
  assert.equal(only, "（开拓者 说）\n（附了一张图：a.jpg）\n（/开拓者 说）");

  // 长图切出来的几片要她说得清是「一张图切成几段」，不然会当成好几张截图
  const sliced = serializeRecord([
    { kind: "user", text: "", at: "2026-10-26T00:00:00Z", attachments: [...att, ...att, ...att] },
  ]);
  assert.ok(sliced.includes("（附了一张图：a.jpg，切成 3 段，按顺序接起来是一整张）"));
});

test("长图切片：普通竖图不切；长截图按宽度切段、首尾相接、每片不超单图预算", () => {
  const one = planImageSlices(720, 1604);
  assert.equal(one.width, 720);
  assert.equal(one.slices.length, 1);
  assert.deepEqual(one.slices[0], { top: 0, height: 1604 });

  const long = planImageSlices(1080, 12000);
  assert.equal(long.width, 960, "宽度要封顶，不然请求体太大");
  assert.ok(long.slices.length >= 6, "1:12 的长图必须切开，整张寄过去只会糊成一条");
  assert.equal(long.slices[0].top, 0);
  const last = long.slices[long.slices.length - 1];
  assert.equal(last.top + last.height, long.height, "最后一片要铺到底");
  for (let i = 0; i < long.slices.length; i += 1) {
    assert.ok(long.slices[i].height <= 960 * 1.4 + 1, "单片超过官方单图预算，缩下来字还是糊");
    if (i > 0) assert.equal(long.slices[i].top, long.slices[i - 1].top + long.slices[i - 1].height, "切片之间不能有缝");
  }
});

test("长图切片：超长图有片数上限；宽图只缩不切", () => {
  const wild = planImageSlices(1080, 40000);
  assert.equal(wild.slices.length, 12, "片数不封顶，一张图能把额度烧穿");
  const last = wild.slices[wild.slices.length - 1];
  assert.equal(last.top + last.height, wild.height);

  const wide = planImageSlices(4000, 3000);
  assert.equal(wide.width, 960);
  assert.equal(wide.height, 720);
  assert.equal(wide.slices.length, 1);

  // 9:16 的竖拍照片：960×1707 还在官方单图预算里，别没事切成两片
  const portrait = planImageSlices(1080, 1920);
  assert.equal(portrait.slices.length, 1);
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


/* -------------------------------------------------------------- 表情块 */

const stickerBlock = (from, name = "无语") => ({
  kind: "sticker",
  from,
  stickerId: "s1",
  name,
  at: "2026-10-28T00:00:00Z",
});

test("表情块：她发的记成旁白，你发的记成你这一轮说的话", () => {
  const text = serializeRecord(
    [
      { kind: "user", text: "在吗", at: "2026-10-28T00:00:00Z" },
      stickerBlock("herta", "得意"),
      stickerBlock("user", "无语"),
    ],
    { maxBlocks: 0 }
  );
  // 她那张不能写成「（我 说）」：那会教她照着写括号，而不是下一轮去调工具
  assert.ok(text.includes("〔系统〕（她发来一张表情：得意）"), "她的表情没有记成旁白");
  assert.ok(!text.includes("（我 说）\n（发来一张表情"), "她的表情被写成她的话了");
  // 你那张得是发言——她要知道这一轮你说的是这张图
  assert.ok(text.includes("（开拓者 说）\n（发来一张表情：无语）\n（/开拓者 说）"), "你的表情没有记成发言");
});

test("表情块：只发了一张表情也能起标题，不会退回「新的对话」", () => {
  assert.equal(deriveTitle([stickerBlock("user")]), "（一张表情）");
  assert.equal(deriveTitle([stickerBlock("herta")]), EMPTY_TITLE);
});

test("撤回：发完表情之后撤回，从那张表情开始切，不吞掉上一轮", () => {
  const blocks = [
    { kind: "user", text: "在吗", at: "2026-10-28T00:00:00Z" },
    { kind: "herta", surface: "speech", text: "在。", at: "2026-10-28T00:00:00Z" },
    stickerBlock("user"),
    { kind: "herta", surface: "speech", text: "干什么。", at: "2026-10-28T00:00:00Z" },
  ];
  const cut = retractLastTurn({ id: "s", title: "t", origin: "phone", createdAt: "", updatedAt: "", blocks });
  assert.equal(cut.blocks.length, 2);
  assert.equal(cut.blocks[1].text, "在。");
});

test("上下文截断：截断点落在表情这块上，不从她的话中间切", () => {
  const blocks = [
    { kind: "user", text: "一", at: "" },
    { kind: "herta", surface: "speech", text: "一答", at: "" },
    { kind: "user", text: "二", at: "" },
    { kind: "herta", surface: "speech", text: "二答", at: "" },
    stickerBlock("user"),
    { kind: "herta", surface: "speech", text: "三答", at: "" },
  ];
  const kept = trimForContext(blocks, 2);
  assert.ok(isUserTurn(kept[0]), "截断后不是从一轮的开头开始");
  assert.equal(kept.length, 2);
});
