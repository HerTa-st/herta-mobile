import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  CREDITS_URL,
  EMPTY_CREDITS,
  UNKNOWN_MONTH,
  formatMonth,
  groupSponsorsByMonth,
  loadCredits,
  parseCredits,
  sortIssues,
  splitCredits,
} from "../src/credits.ts";

/* ------------------------------------------------------------------ 契约 */

const FULL = {
  updatedAt: "2026-11-06",
  sponsors: [
    { name: "甲的赞助", month: "2026-10", tier: "一点点" },
    { name: "乙的赞助", month: "2026-10" },
    { name: "丙的赞助", month: "2026-09" },
  ],
  devs: [{ name: "梦源", role: "作者 · 手机端" }],
  credits: [
    { kind: "work", name: "上游 Herta", author: "米哈游" },
    { kind: "idea", name: "给过点子的人" },
  ],
  donate: { wechat: "https://example.com/qr-w.png", alipay: "https://example.com/qr-a.png", qqGroup: "123456789" },
  issues: [
    { title: "没修的那条", detail: "原因", status: "open" },
    { title: "修好的那条", detail: "原因", status: "fixed" },
  ],
};

test("parseCredits：完整契约原样收下", () => {
  const doc = parseCredits(FULL);
  assert.equal(doc.updatedAt, "2026-11-06");
  assert.equal(doc.sponsors.length, 3);
  assert.equal(doc.sponsors[0].tier, "一点点");
  assert.equal(doc.sponsors[1].tier, undefined, "没写档位的不该补一个空串");
  assert.deepEqual(doc.devs, [{ name: "梦源", role: "作者 · 手机端" }]);
  assert.equal(doc.donate.qqGroup, "123456789");
  assert.equal(doc.issues.length, 2);
});

test("parseCredits：坏字段丢掉，不整份报废", () => {
  const doc = parseCredits({
    sponsors: [{ name: "好的", month: "2026-10" }, { name: "", month: "2026-10" }, { month: "2026-10" }, "不是对象"],
    devs: [{ name: "好的", role: "作者" }, { role: "没有名字" }],
    credits: [
      { kind: "work", name: "作品", author: "作者" },
      { kind: "idea", name: "点子" },
      { kind: "点赞", name: "拼错的 kind" },
      { kind: "work", name: "" },
    ],
    donate: null,
    issues: [{ title: "有标题" }, { detail: "没标题" }],
  });
  assert.equal(doc.sponsors.length, 1);
  assert.equal(doc.devs.length, 1);
  assert.equal(doc.credits.length, 2, "kind 只认 work/idea，拼错的丢掉");
  assert.deepEqual(doc.donate, {});
  assert.equal(doc.issues.length, 1);
  assert.equal(doc.issues[0].status, "open", "没写状态的按还没修算");
});

test("parseCredits：null / 数组 / 字符串都不抛异常", () => {
  for (const bad of [null, undefined, [], "名单", 42, true]) {
    const doc = parseCredits(bad);
    assert.deepEqual(doc.sponsors, []);
    assert.deepEqual(doc.devs, []);
    assert.deepEqual(doc.credits, []);
    assert.deepEqual(doc.issues, []);
  }
  assert.deepEqual(EMPTY_CREDITS.credits, []);
});

/* ------------------------------------------------------------ 灵感与帮助 */

test("splitCredits：取材自 / 点子来自 分两段，互不混排", () => {
  const { works, ideas } = splitCredits(parseCredits(FULL).credits);
  assert.deepEqual(
    works.map((item) => item.name),
    ["上游 Herta"]
  );
  assert.deepEqual(
    ideas.map((item) => item.name),
    ["给过点子的人"]
  );
  assert.equal(works[0].author, "米哈游");
  assert.equal(ideas[0].author, undefined, "点子来自只记名字，不冒充作者");
});

test("splitCredits：两类都不进 devs", () => {
  const doc = parseCredits(FULL);
  const { works, ideas } = splitCredits(doc.credits);
  const devNames = doc.devs.map((dev) => dev.name);
  for (const name of [...works, ...ideas].map((item) => item.name)) {
    assert.equal(devNames.includes(name), false, name + " 不该出现在开发名单里");
  }
});

/* ---------------------------------------------------------------- 按月 */

test("groupSponsorsByMonth：最近的月份排最前，组内保序", () => {
  const groups = groupSponsorsByMonth(parseCredits(FULL).sponsors);
  assert.deepEqual(
    groups.map((group) => group.month),
    ["2026-10", "2026-09"]
  );
  assert.deepEqual(
    groups[0].rows.map((row) => row.name),
    ["甲的赞助", "乙的赞助"]
  );
  assert.equal(groups[0].label, "2026 / 10");
});

test("groupSponsorsByMonth：月份格式不对的收在最后一组，不丢人", () => {
  const groups = groupSponsorsByMonth([
    { name: "旧格式", month: "2026/10" },
    { name: "正常的", month: "2026-11" },
    { name: "没写月份", month: "" },
  ]);
  assert.deepEqual(
    groups.map((group) => group.month),
    ["2026-11", UNKNOWN_MONTH]
  );
  assert.equal(groups[1].rows.length, 2);
});

test("formatMonth：只认 YYYY-MM", () => {
  assert.equal(formatMonth("2026-01"), "2026 / 01");
  assert.equal(formatMonth("2026/01"), "2026/01");
  assert.equal(formatMonth(""), UNKNOWN_MONTH);
});

/* ------------------------------------------------------------ 已知问题 */

test("sortIssues：没修的排前面，同状态保 JSON 顺序", () => {
  const rows = sortIssues(parseCredits(FULL).issues);
  assert.deepEqual(
    rows.map((row) => row.title),
    ["没修的那条", "修好的那条"]
  );
});

/* ---------------------------------------------------------------- 读取 */

test("loadCredits：断网说人话、不抛异常", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  try {
    const result = await loadCredits();
    assert.equal(result.ok, false);
    assert.match(result.detail, /没连上网|请求发不出去/);
  } finally {
    globalThis.fetch = original;
  }
});

test("loadCredits：服务器没这份文件时带状态码，不塞默认名单", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404 });
  try {
    const result = await loadCredits();
    assert.equal(result.ok, false);
    assert.match(result.detail, /404/);
    assert.equal("doc" in result, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("loadCredits：不是合法 JSON 时说读不懂", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>oops</html>", { status: 200 });
  try {
    const result = await loadCredits();
    assert.equal(result.ok, false);
    assert.match(result.detail, /读不懂/);
  } finally {
    globalThis.fetch = original;
  }
});

test("loadCredits：取到就用它，且走的是网站那份地址", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify(FULL), { status: 200 });
  };
  try {
    const result = await loadCredits();
    assert.equal(result.ok, true);
    assert.equal(result.doc.devs.length, 1);
    assert.equal(result.mock, false);
    assert.deepEqual(seen, [CREDITS_URL]);
  } finally {
    globalThis.fetch = original;
  }
});

/* ------------------------------------------------------------ 上线那份 */

test("上线名单：已知问题九条齐全、其余留空不编", async () => {
  const raw = JSON.parse(await read("../../../docs/credits-上线名单.json"));
  const doc = parseCredits(raw);

  assert.equal(doc.issues.length, 9, "issue 数量要和 issues.html 对齐");
  assert.ok(
    doc.issues.every((issue) => issue.status === "open"),
    "还没修的一律 open"
  );
  const titles = doc.issues.map((issue) => issue.title);
  for (const expected of ["扫描件 PDF 抽不出字", "没有 iOS 版", "没填 API Key 就什么都聊不了"]) {
    assert.ok(titles.includes(expected), "少了：" + expected);
  }

  assert.equal(doc.sponsors.length, 0, "赞助名单等最后定，别先编");
  assert.equal(doc.devs.length, 0, "开发名单等最后定，别先编");
  assert.equal(doc.credits.length, 0, "取材自 / 点子来自等最后定");
  assert.deepEqual(doc.donate, {}, "收款码与群号没定之前不给空壳");
  assert.match(doc.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}$/);
});

/* -------------------------------------------------------- 页面上的硬约束 */

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

/** 只盯真正渲染的代码：注释里说「不是 <a>」不该算违规。 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("赞助页：不出现任何链接跳转，收款码只当图片用", async () => {
  const src = stripComments(await read("../src/components/SponsorsScreen.tsx"));
  assert.equal(/href\s*=/.test(src), false, "赞助页里不该有 href（没有可点的收款链接）");
  assert.equal(/<a[\s>]/.test(src), false, "赞助页里不该有 <a>");
  assert.match(src, /<img src=\{src\}/, "码要落在 img 上");
  assert.match(src, /src=\{donate\.wechat\}/);
  assert.match(src, /src=\{donate\.alipay\}/);
});

test("赞助页：默认展开最近一个月，历史可折叠", async () => {
  const src = await read("../src/components/SponsorsScreen.tsx");
  assert.match(src, /months\.length > 0 \? \[months\[0\]\.month\] : \[\]/, "首组默认展开");
  assert.match(src, /aria-expanded=\{open\}/);
});

test("开发人员页：两段措辞分开写", async () => {
  const src = await read("../src/components/DevsScreen.tsx");
  assert.match(src, /取材自/);
  assert.match(src, /点子来自/);
  assert.match(src, /splitCredits/);
});

test("设置的「关于」组：版本号不写死", async () => {
  const src = await read("../src/components/SettingsSheet.tsx");
  assert.match(src, /关于/);
  assert.match(src, /APP_VERSION/);
  assert.match(src, /onOpenFeedback/);
  assert.equal(/0\.\d+\.\d+/.test(src), false, "版本号要走 APP_VERSION，不能再写一个常量");
});

test("反馈入口：指向同一张飞书表单，而不是 App 内页", async () => {
  const { FEEDBACK_FORM_URL } = await import("../src/credits.ts");
  assert.match(FEEDBACK_FORM_URL, /^https:\/\/mar530jpjrc\.feishu\.cn\/share\/base\/form\//);
  const app = await read("../src/App.tsx");
  assert.match(app, /openLink\(url\)/, "反馈要交给外部浏览器打开");
});

test("App 把三页接进了页面栈的 switch", async () => {
  const app = await read("../src/App.tsx");
  for (const name of ["sponsors", "devs", "issues"]) {
    assert.match(app, new RegExp('case "' + name + '":'), name + " 没有 case");
  }
});

test("路由表：三页各有一条 fullscreen 路由", async () => {
  const src = await read("../src/nav/routes.ts");
  for (const name of ["sponsors", "devs", "issues"]) {
    assert.match(src, new RegExp(name + ": \\{ label:"));
  }
});
