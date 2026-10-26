import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { NodeAssetSource } from "../src/assets-node.ts";
import { buildStaticPrefix, pickSeeds, MOBILE_NOTE, FORMAT_CONTRACT } from "../src/persona.ts";
import { extractTagged, parseTagged, isPlaceholder, serializeRecord, parseSupervisorVerdict } from "../src/tags.ts";
import { buildReviewMessages, decideReview, vetoHints } from "../src/supervisor.ts";

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

/* -------------------------------------------------------------- 标签语法 */

test("标签：想与说各自成对，内容原样取出", () => {
  const raw = "（我 想）\n这段话他看不见\n（/我 想）\n\n（我 说）\n这段话他听得见\n（/我 说）";
  assert.equal(extractTagged(raw, "thought"), "这段话他看不见");
  assert.equal(extractTagged(raw, "speech"), "这段话他听得见");
  assert.equal(extractTagged(raw, "speech"), extractTagged(raw, "speech"));
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
