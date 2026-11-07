import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MOOD_SECTION_LABELS,
  MOOD_SECTION_LIMITS,
  buildMoodPrompt,
  composeMoodSystem,
  validateMoodSections,
} from "../src/mood.ts";

const PACK_URL = new URL("../../../assets/mood-prompt.zh.json", import.meta.url);
const PACK = JSON.parse(readFileSync(PACK_URL, "utf8"));
const freshPack = () => structuredClone(PACK);

/* ------------------------------------------------------------ 素材形状 */

test("素材：version 2，system 原样保留，scaffold 与三段齐全", () => {
  assert.equal(PACK.version, 2);
  assert.equal(typeof PACK.system, "string");
  assert.equal(typeof PACK.scaffold.head, "string");
  assert.equal(typeof PACK.scaffold.tail, "string");
  assert.deepEqual(Object.keys(PACK.sections).sort(), ["boundaries", "priority", "triggers"]);
  assert.ok(PACK.scaffold.head.endsWith("八种状态："), "head 应停在「八种状态：」");
  assert.ok(PACK.scaffold.tail.startsWith("注意："), "tail 应从「注意：」开始");
});

/* ---------------------------------------------------------------- 组装 */

test("组装：无覆盖层时与打包 system 逐字节相等", () => {
  assert.equal(composeMoodSystem(PACK), PACK.system);
  assert.equal(composeMoodSystem(PACK, null), PACK.system);
  assert.equal(composeMoodSystem(PACK, {}), PACK.system);
});

test("组装：只覆盖触发描述，其余两段仍是原样", () => {
  const next = "触发描述已改写：只认认真求解，不认催促。";
  const system = composeMoodSystem(PACK, { triggers: next });

  assert.ok(system.includes(next), "新触发描述没进 system");
  assert.ok(!system.includes(PACK.sections.triggers), "旧触发描述还在");
  assert.ok(system.includes(PACK.sections.boundaries), "判定边界被动了");
  assert.ok(system.includes(PACK.sections.priority), "优先级被动了");
  assert.equal(
    system,
    [
      PACK.scaffold.head,
      next,
      PACK.sections.boundaries,
      PACK.sections.priority,
      PACK.scaffold.tail,
    ].join("\n\n")
  );
});

test("组装：三段全覆盖时按 头/触发/边界/优先级/尾 的顺序拼接", () => {
  const override = {
    triggers: "【新触发】只认求解。",
    boundaries: "【新边界】先看是不是在求解。",
    priority: "【新优先级】默认 > 倾听版。",
  };
  const system = composeMoodSystem(PACK, override);

  assert.ok(system.startsWith(PACK.scaffold.head), "head 不在最前");
  assert.ok(system.endsWith(PACK.scaffold.tail), "tail 不在最后");

  const atTriggers = system.indexOf(override.triggers);
  const atBoundaries = system.indexOf(override.boundaries);
  const atPriority = system.indexOf(override.priority);
  assert.ok(atTriggers > 0, "新触发描述丢了");
  assert.ok(atTriggers < atBoundaries, "触发描述应排在判定边界之前");
  assert.ok(atBoundaries < atPriority, "判定边界应排在优先级之前");
  assert.equal(
    system,
    [
      PACK.scaffold.head,
      override.triggers,
      override.boundaries,
      override.priority,
      PACK.scaffold.tail,
    ].join("\n\n")
  );
});

test("旧包兼容：没有 scaffold/sections 时回落 pack.system，给了 override 也不乱拼", () => {
  const old = freshPack();
  delete old.sections;
  delete old.scaffold;

  assert.equal(
    composeMoodSystem(old, { triggers: "全新触发", boundaries: "全新边界", priority: "全新优先级" }),
    old.system
  );
  assert.equal(buildMoodPrompt(old, "他：在吗", null, { triggers: "全新触发" }).system, old.system);
});

/* ---------------------------------------------------------------- 校验 */

test("校验：合法三段 ok:true，errors 为空", () => {
  assert.deepEqual(validateMoodSections(PACK, { ...PACK.sections }), { ok: true, errors: [] });
});

test("校验：某段为空就拒绝，错误里点名是哪一段", () => {
  const r = validateMoodSections(PACK, { triggers: "   " });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  assert.ok(
    r.errors.some((error) => error.includes(MOOD_SECTION_LABELS.triggers)),
    "错误没说清是哪一段：" + r.errors.join(" / ")
  );
});

test("校验：组装后少了某个状态名就拒绝", () => {
  const bare = {
    version: 2,
    system: "旧兜底",
    userInstruction: "只回状态名|触发。",
    moods: [...PACK.moods],
    scaffold: { head: "从下面这些状态里挑一个：", tail: "只回「状态名|触发」。" },
    sections: {
      triggers: PACK.moods
        .filter((m) => m !== "倾听版")
        .map((m) => m + " — 描述")
        .join("\n"),
      boundaries: "判定边界：按上面的描述判断。",
      priority: "优先级：默认优先。",
    },
  };

  const r = validateMoodSections(bare, {});
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((error) => error.includes("倾听版")),
    "没点出缺的是倾听版：" + r.errors.join(" / ")
  );
});

test("校验：超过分段字数上限就拒绝（用上限 +1 构造）", () => {
  const tooLong = "长".repeat(MOOD_SECTION_LIMITS.triggers + 1);
  const r = validateMoodSections(PACK, { triggers: tooLong });

  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1, "只该报超字数这一条：" + r.errors.join(" / "));
  assert.ok(r.errors[0].includes(MOOD_SECTION_LABELS.triggers));
  assert.ok(r.errors[0].includes(String(MOOD_SECTION_LIMITS.triggers)));
});

/* ------------------------------------------------------------ 判定提示词 */

test("buildMoodPrompt：用覆盖层时 system 变了，user 仍带对话与情绪惯性", () => {
  const override = { triggers: "新的触发描述：只认求解。" };
  const p = buildMoodPrompt(PACK, "他：在吗\n我：在。", "被烦版", override);

  assert.ok(p.system.includes(override.triggers), "覆盖层没进 system");
  assert.ok(!p.system.includes(PACK.sections.triggers), "旧触发描述还在 system 里");
  assert.ok(p.system.endsWith(PACK.scaffold.tail));

  assert.ok(p.user.includes("他：在吗"), "对话没进 user 段");
  assert.ok(p.user.includes("被烦版"), "上一轮状态没进 user 段");
  assert.ok(p.user.includes("情绪惯性"), "情绪惯性那段丢了");
  assert.ok(p.user.includes("状态名|触发"), "触发位约定丢了");
  assert.ok(p.user.includes(PACK.userInstruction));
});
