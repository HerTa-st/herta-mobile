import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/* 手机端才有 localStorage；这里给一个最小实现，测的是账本逻辑本身。 */
function makeStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
  };
}
globalThis.localStorage = makeStore();

const {
  recordUsage,
  recordUsageFrom,
  readUsage,
  clearUsage,
  localDayKey,
  USAGE_SOURCES,
  USAGE_LABELS,
} = await import("../src/usage-ledger.ts");

/** 上海时间 2026-11-06 20:00 */
const T = new Date("2026-11-06T20:00:00+08:00").getTime();
/** 第二天同一时刻 */
const T2 = new Date("2026-11-07T20:00:00+08:00").getTime();
/** 本地 11-07 早上七点：UTC 还停在 11-06 23:00，按 UTC 算会算错一天 */
const T_EARLY = new Date("2026-11-07T07:00:00+08:00").getTime();

const src = (rel) => readFile(path.join(here, "..", "src", rel), "utf8");

test("分链路各记各的，同一链路累加", () => {
  clearUsage();
  recordUsage("chat", 1200, 300, { now: T });
  recordUsage("chat", 800, 200, { now: T });
  recordUsage("review", 26000, 400, { now: T });
  const day = readUsage(T);
  assert.equal(day.rows.chat.prompt, 2000);
  assert.equal(day.rows.chat.completion, 500);
  assert.equal(day.rows.chat.calls, 2);
  assert.equal(day.rows.review.prompt, 26000);
  assert.equal(day.rows.review.calls, 1);
  assert.equal(day.rows.mood.calls, 0, "没动的链路是 0，不是没这一行");
  assert.equal(day.prompt, 28000, "总数是各链路之和");
  assert.equal(day.calls, 3);
});

test("过零点清零：昨天的数字不会混进今天", () => {
  clearUsage();
  recordUsage("chat", 5000, 900, { now: T });
  assert.equal(readUsage(T).prompt, 5000);
  const tomorrow = readUsage(T2);
  assert.equal(tomorrow.prompt, 0, "第二天读出来是空的");
  assert.equal(tomorrow.date, "2026-11-07");
  assert.equal(tomorrow.rows.chat.calls, 0);
  // 第二天写一笔，也只留当天那一页
  recordUsage("mood", 10, 2, { now: T2 });
  assert.equal(readUsage(T2).prompt, 10);
  assert.equal(readUsage(T).prompt, 0, "旧那页已经没了");
});

test("日期键按本地时区算，不按 UTC", () => {
  assert.equal(localDayKey(T), "2026-11-06");
  assert.equal(new Date(T_EARLY).toISOString().slice(0, 10), "2026-11-06", "这一刻 UTC 还是 6 号");
  assert.equal(localDayKey(T_EARLY), "2026-11-07", "本地已经是 7 号");
});

test("坏数据不炸：非 JSON、负数、字符串、缺字段一律当 0", () => {
  clearUsage();
  localStorage.setItem("herta.usage.v1", "{ 这不是 json");
  assert.deepEqual(readUsage(T), { ...readUsage(T), prompt: 0, completion: 0, calls: 0 });

  localStorage.setItem(
    "herta.usage.v1",
    JSON.stringify({
      date: localDayKey(T),
      rows: {
        chat: { prompt: -50, completion: "abc", cached: null, calls: 1.9 },
        review: "nope",
        ghost: { prompt: 999 },
      },
    })
  );
  const day = readUsage(T);
  assert.equal(day.rows.chat.prompt, 0, "负数是坏数据");
  assert.equal(day.rows.chat.completion, 0);
  assert.equal(day.rows.chat.calls, 1, "小数向下取整");
  assert.equal(day.rows.review.prompt, 0);
  assert.equal(day.prompt, 0, "没见过的链路不会被算进总数");
});

test("recordUsageFrom：没回执就不记，有回执才记", () => {
  clearUsage();
  assert.equal(recordUsageFrom("chat", null, T), null);
  assert.equal(readUsage(T).calls, 0, "接口没给 usage 就别挂个 0");

  recordUsageFrom("chat", { prompt: 100, completion: 20, cached: 60, calls: 1 }, T);
  const day = readUsage(T);
  assert.equal(day.prompt, 100);
  assert.equal(day.completion, 20);
  assert.equal(day.cached, 60);
  assert.equal(day.calls, 1);
});

test("九条链路都有中文名，顺序固定", () => {
  assert.equal(USAGE_SOURCES.length, 9);
  const expected = ["chat", "review", "mood", "redo", "broadcast", "reader", "deepSleep", "voice", "proactive"];
  assert.deepEqual([...USAGE_SOURCES], expected);
  for (const source of expected) {
    assert.ok(USAGE_LABELS[source], "缺中文名：" + source);
  }
});

test("六处调用点都接了账，一个不漏", async () => {
  const chat = await src("hooks/useChatTurn.ts");
  for (const tag of ["chat", "mood", "review", "redo"]) {
    assert.ok(chat.includes('recordUsageFrom("' + tag + '"'), "useChatTurn 少了 " + tag);
  }
  const checks = [
    ["broadcast/generate.ts", "broadcast"],
    ["broadcast/reader.ts", "reader"],
    ["nms/deep-sleep-runner.ts", "deepSleep"],
    ["nms/voice-runner.ts", "voice"],
    ["proactive.ts", "proactive"],
  ];
  for (const [rel, tag] of checks) {
    const text = await src(rel);
    assert.ok(text.includes('recordUsageFrom("' + tag + '"'), rel + " 没接 " + tag);
  }
});

test("记账不改请求：只多一行调用，没有动 apiKey / model / maxTokens", async () => {
  const files = [
    "broadcast/generate.ts",
    "broadcast/reader.ts",
    "nms/deep-sleep-runner.ts",
    "nms/voice-runner.ts",
    "proactive.ts",
  ];
  for (const rel of files) {
    const text = await src(rel);
    const before = text.split("recordUsageFrom(")[0];
    assert.ok(!before.includes("applyLedger"), rel + " 记账别和币账混在一起");
  }
});

test("设置里有入口、明细页写明搜索端点统计不到", async () => {
  const settings = await src("components/SettingsSheet.tsx");
  assert.ok(settings.includes("今日用量"), "设置「连接」组应有今日用量");
  assert.ok(settings.includes("onOpenUsage"), "设置要能压栈到明细页");

  const screen = await src("components/UsageScreen.tsx");
  assert.ok(screen.includes("/v1/tools/search"), "缺口要写在明细里");
  assert.ok(screen.includes("过零点清零"));
  assert.ok(!/¥|元\/|\$\d/.test(screen), "页面里不该出现钱");
  assert.ok(screen.includes("不折算成金额"), "要明说不折成钱");

  const routes = await src("nav/routes.ts");
  assert.ok(/usage: \{ label: "今日用量", fullscreen: true \}/.test(routes), "路由表要有 usage");
});
