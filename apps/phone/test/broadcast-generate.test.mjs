import test from "node:test";
import assert from "node:assert/strict";

import { generateBroadcast } from "../src/broadcast/generate.ts";

const settings = { apiKey: "test-key", baseUrl: "http://mock.local", model: "mock-model" };
const assets = { promptAssets: async () => ({ hertaBio: "我是黑塔。天才俱乐部#83。" }) };

function makeHits(n = 8) {
  return Array.from({ length: n }, (_, i) => ({
    title: "候选标题 " + i,
    url: "https://news.example.com/" + i,
    summary: "候选摘要 " + i,
  }));
}

function issueJson() {
  const real = Array.from({ length: 5 }, (_, i) => ({
    source: "示例媒体",
    title: "标题 " + i,
    summary: "摘要 " + i,
    url: "https://news.example.com/" + i,
    tag: "人工智能",
    comment: "评 " + i,
  }));
  const egg = {
    source: "星际和平公司",
    title: "公司宣布把月亮租给黑塔",
    summary: "据本台消息，公司已把月亮的使用权租给空间站。",
    comment: "租金我砍了一半。",
    url: "",
    egg: true,
  };
  return JSON.stringify({ items: [...real, egg] });
}

function mockTransport({ hits = makeHits(), raw = issueJson() } = {}) {
  const calls = [];
  return {
    name: "mock",
    calls,
    async search() {
      return hits;
    },
    stream(req) {
      calls.push(req);
      const text = typeof raw === "function" ? raw(calls.length) : raw;
      return (async function* () {
        yield { type: "text", text };
        yield { type: "done", finishReason: "stop" };
      })();
    },
  };
}

test("generateBroadcast：搜索 → 候选 → 她挑 → 结构化，彩蛋在最后", async () => {
  const mock = mockTransport();
  const got = await generateBroadcast(
    { settings, tags: ["人工智能", "游戏"], now: new Date(2026, 10, 2, 9, 0) },
    { transport: mock, assets }
  );

  assert.equal(got.queries[0], "人工智能 最新 新闻");
  assert.equal(got.candidates, 8);
  assert.equal(got.items.filter((item) => !item.egg).length, 5);
  assert.equal(got.items.at(-1).egg, true);
  assert.equal(got.items[0].url, "https://news.example.com/0");

  const first = mock.calls[0];
  assert.match(first.messages[0].content, /我是黑塔/);
  assert.match(first.messages[1].content, /https:\/\/news\.example\.com\/0/);
  assert.match(first.messages[1].content, /人工智能/);
});

test("generateBroadcast：第一次不是 JSON，会带着提醒重试一次", async () => {
  const mock = mockTransport({ raw: (n) => (n === 1 ? "今天没什么新闻。" : issueJson()) });
  const got = await generateBroadcast({ settings, tags: ["人工智能"] }, { transport: mock, assets });

  assert.equal(got.items.filter((item) => !item.egg).length, 5);
  assert.equal(mock.calls.length, 2);
  assert.match(mock.calls[1].messages[1].content, /只输出 JSON/);
});

test("generateBroadcast：搜索全空 / 候选不足 3 条，明确失败，不硬凑", async () => {
  await assert.rejects(
    () => generateBroadcast({ settings, tags: ["游戏"] }, { transport: mockTransport({ hits: [] }), assets }),
    /没搜到新闻/
  );
  await assert.rejects(
    () => generateBroadcast({ settings, tags: ["游戏"] }, { transport: mockTransport({ hits: makeHits(2) }), assets }),
    /没搜到足够/
  );
});

test("generateBroadcast：编出来的链接会被丢掉，剩不到 3 条就失败", async () => {
  const raw = JSON.stringify({
    items: [
      { source: "示例媒体", title: "A", summary: "a", url: "https://news.example.com/0", comment: "a" },
      { source: "示例媒体", title: "B", summary: "b", url: "https://made-up.example/b", comment: "b" },
      { source: "示例媒体", title: "C", summary: "c", url: "https://made-up.example/c", comment: "c" },
      { source: "示例媒体", title: "D", summary: "d", url: "https://made-up.example/d", comment: "d" },
    ],
  });
  await assert.rejects(
    () => generateBroadcast({ settings, tags: ["人工智能"] }, { transport: mockTransport({ raw }), assets }),
    /没写完整/
  );
});

test("generateBroadcast：没有 Key 直接拒绝，不发请求", async () => {
  const mock = mockTransport();
  await assert.rejects(
    () => generateBroadcast({ settings: { ...settings, apiKey: "" }, tags: ["游戏"] }, { transport: mock, assets }),
    /API Key/
  );
  assert.equal(mock.calls.length, 0);
});
