import test from "node:test";
import assert from "node:assert/strict";

import {
  BROADCAST_MAX_ITEMS,
  broadcastTitle,
  buildBroadcastIssue,
  buildSearchQueries,
  countLabel,
  dateLabel,
  isBlockedSource,
  localDateId,
  mergeCandidates,
  nextIssueNo,
  normalizeUrl,
  parseArticleDigest,
  parseIssueDraft,
  htmlToArticleText,
  stripJsonFence,
} from "../src/broadcast.ts";

const BT = String.fromCharCode(96).repeat(3);

function real(i, over = {}) {
  return {
    source: "网易",
    title: "标题 " + i,
    summary: "摘要 " + i,
    url: "https://example.com/news/" + i,
    comment: "评 " + i,
    tag: "游戏",
    ...over,
  };
}

function egg(over = {}) {
  return {
    source: "星际和平公司",
    title: "公司宣布把月亮租给黑塔",
    summary: "据本台消息，公司已把月亮的使用权租给空间站。",
    comment: "租金我砍了一半。",
    url: "",
    egg: true,
    ...over,
  };
}

function wrap(items) {
  return JSON.stringify({ items });
}

test("parseIssueDraft：3–7 条真新闻可以过", () => {
  const got = parseIssueDraft(wrap([real(1), real(2), real(3)]));
  assert.equal(got.ok, true);
  assert.equal(got.items.length, 3);
  assert.equal(got.items[0].source, "网易");
  assert.equal(got.items[0].domain, "example.com");
});

test("parseIssueDraft：不足 3 条就失败，不硬凑", () => {
  const got = parseIssueDraft(wrap([real(1), real(2)]));
  assert.equal(got.ok, false);
  assert.match(got.error, /不到 3 条/);
});

test("parseIssueDraft：超过 7 条就失败", () => {
  const items = Array.from({ length: BROADCAST_MAX_ITEMS + 1 }, (_, i) => real(i + 1));
  const got = parseIssueDraft(wrap(items));
  assert.equal(got.ok, false);
  assert.match(got.error, /超过 7 条/);
});

test("parseIssueDraft：彩蛋额外附赠、放最后，不计入条数", () => {
  const got = parseIssueDraft(wrap([real(1), real(2), real(3), real(4), real(5), egg()]));
  assert.equal(got.ok, true);
  assert.equal(got.items.length, 6);
  assert.equal(got.items.at(-1).egg, true);
  assert.equal(countLabel(got.items), "5条 · 1彩蛋");
});

test("parseIssueDraft：彩蛋不在最后一条就失败", () => {
  const got = parseIssueDraft(wrap([real(1), egg(), real(2), real(3)]));
  assert.equal(got.ok, false);
  assert.match(got.error, /最后一条/);
});

test("parseIssueDraft：彩蛋最多一条", () => {
  const got = parseIssueDraft(wrap([real(1), real(2), real(3), egg(), egg()]));
  assert.equal(got.ok, false);
  assert.match(got.error, /最多一条/);
});

test("parseIssueDraft：链接必须在候选里（不许编原文）", () => {
  const allowed = ["https://example.com/news/1", "https://example.com/news/2", "https://example.com/news/3"];
  const got = parseIssueDraft(
    wrap([real(1), real(2), real(3), real(4, { url: "https://made-up.example/fake" })]),
    { allowedUrls: allowed }
  );
  assert.equal(got.ok, true);
  assert.equal(got.items.length, 3);

  const tooFew = parseIssueDraft(wrap([real(1), real(2, { url: "https://made-up.example/fake" }), real(3)]), {
    allowedUrls: allowed,
  });
  assert.equal(tooFew.ok, false);
});

test("parseIssueDraft：剥掉围栏和前后废话", () => {
  const fenced = "好的，这是今天的：" + BT + "json\n" + wrap([real(1), real(2), real(3)]) + "\n" + BT;
  const got = parseIssueDraft(fenced);
  assert.equal(got.ok, true);
  assert.equal(got.items.length, 3);
  assert.equal(stripJsonFence(fenced).startsWith("{"), true);
});

test("parseIssueDraft：不是 JSON 就失败", () => {
  const got = parseIssueDraft("今天没什么新闻。");
  assert.equal(got.ok, false);
  assert.match(got.error, /JSON/);
});

test("mergeCandidates：按 URL 去重、滤内容农场、丢半截", () => {
  const got = mergeCandidates([
    { title: "A", url: "https://example.com/a?utm=1", summary: "s" },
    { title: "A again", url: "https://example.com/a?utm=2", summary: "s" },
    { title: "B", url: "https://example.com/b", summary: "s" },
    { title: "C", url: "https://baijiahao.baidu.com/s?id=1", summary: "s" },
    { title: "", url: "https://example.com/d", summary: "s" },
    { title: "E", url: "not-a-url", summary: "s" },
  ]);
  assert.equal(got.length, 2);
  assert.deepEqual(
    got.map((x) => x.title),
    ["A", "B"]
  );
});

test("normalizeUrl：去掉查询、hash 和末尾斜杠", () => {
  assert.equal(normalizeUrl("https://example.com/a/?x=1#top"), "https://example.com/a");
  assert.equal(normalizeUrl("ftp://example.com/a"), "");
});

test("isBlockedSource：网易号算内容池，网易新闻不算", () => {
  assert.equal(isBlockedSource("163.com", "/dy/article/ABC"), true);
  assert.equal(isBlockedSource("163.com", "/news/article/ABC"), false);
  assert.equal(isBlockedSource("baijiahao.baidu.com", "/s"), true);
});

test("buildSearchQueries：按标签拼、最多 4 条、空标签有兜底", () => {
  assert.deepEqual(buildSearchQueries(["人工智能", "游戏"]), ["人工智能 最新 新闻", "游戏 最新 新闻"]);
  assert.equal(buildSearchQueries(["a", "b", "c", "d", "e"]).length, 4);
  assert.deepEqual(buildSearchQueries([]), ["科技 最新 新闻"]);
});

test("nextIssueNo：按实际生成递增，错过不占号", () => {
  assert.equal(nextIssueNo([]), 1);
  assert.equal(nextIssueNo([{ no: 1 }, { no: 2 }]), 3);
  assert.equal(nextIssueNo([{ no: 3 }, { no: 1 }]), 4);
});

test("日期与标题文案", () => {
  assert.equal(localDateId(new Date(2026, 10, 2, 9, 30)), "2026-11-02");
  assert.equal(dateLabel("2026-11-02"), "11月2日");
  assert.equal(broadcastTitle(1), "《星际和平播报》 第 1 期 · 空间站「黑塔」转播");
});

test("buildBroadcastIssue：落库形状", () => {
  const issue = buildBroadcastIssue({
    date: "2026-11-02",
    no: 3,
    items: [real(1), real(2), real(3)],
    now: new Date("2026-11-02T00:00:00Z"),
  });
  assert.equal(issue.id, "2026-11-02");
  assert.equal(issue.no, 3);
  assert.equal(issue.status, "ready");
  assert.equal(issue.items.length, 3);
});


test("条目：why 有就用模型的，没有就按关注标签补「你关注X」", () => {
  const draft = JSON.stringify({
    items: [
      { ...real(1), why: "你关注芯片" },
      { ...real(2), tag: "游戏" },
      { ...real(3), tag: "" },
    ],
  });
  const parsed = parseIssueDraft(draft);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.items[0].why, "你关注芯片");
  assert.equal(parsed.items[1].why, "你关注游戏");
  assert.equal(parsed.items[2].why, undefined, "既没 why 也没标签：不硬编");
});

test("读原文：网页洗成正文——脚本/导航/页脚剔掉，优先取 article，实体解码", () => {
  const html =
    "<html><head><style>.a{color:red}</style><script>alert(1)</script></head>" +
    "<body><nav>导航条</nav>" +
    "<article><h1>标题一行</h1><p>第一段&nbsp;正文</p><p>第二段 &amp; 结尾</p></article>" +
    "<footer>页脚版权</footer></body></html>";
  const text = htmlToArticleText(html);
  assert.ok(text.includes("第一段 正文"), "nbsp 要变成空格");
  assert.ok(text.includes("第二段 & 结尾"), "实体要解码");
  assert.ok(text.includes("标题一行"));
  assert.ok(!text.includes("alert"), "脚本不能进正文");
  assert.ok(!text.includes("导航条"), "导航不能进正文");
  assert.ok(!text.includes("页脚版权"), "页脚不能进正文");
});

test("读原文：模型给的稿子能解析；坏 JSON 或缺正文判失败，要点最多 5 条", () => {
  const payload = JSON.stringify({ detail: "### 发生了什么\n正文一段", points: ["一", "二", "", "三", "四", "五", "六"] });
  const ok = parseArticleDigest(BT + "json\n" + payload + "\n" + BT);
  assert.ok(ok, "围栏里的 JSON 要能认");
  assert.equal(ok.detail, "### 发生了什么\n正文一段");
  assert.deepEqual(ok.points, ["一", "二", "三", "四", "五"]);

  assert.equal(parseArticleDigest("不是 JSON"), null);
  assert.equal(parseArticleDigest('{"points":["只有要点"]}'), null, "没有 detail 就是失败");
});

