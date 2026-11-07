import test from "node:test";
import assert from "node:assert/strict";

import {
  PING_LOG_LIMIT,
  appendPingLog,
  buildPingArchiveNote,
  fillPingReplies,
  initiativeLimits,
  interactionDelta,
  interactionFromLog,
  moodForPing,
  shouldRecoverInitiative,
} from "../src/proactive.ts";
import { decidePresencePing } from "../src/presence.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function entry(at, over = {}) {
  return { at: new Date(at).toISOString(), text: "说了句话", replyDelayMs: null, userLine: null, ...over };
}

/* ------------------------------------------------------------ 旋钮 → 节奏 */

test("initiativeLimits：0/40/60/80/100 分别 0/2/4/6/10 次，间隔 6/4/3/2/1 小时", () => {
  assert.deepEqual(initiativeLimits(0), { maxPerDay: 0, minGapMs: 6 * HOUR });
  assert.deepEqual(initiativeLimits(40), { maxPerDay: 2, minGapMs: 4 * HOUR });
  assert.deepEqual(initiativeLimits(60), { maxPerDay: 4, minGapMs: 3 * HOUR });
  assert.deepEqual(initiativeLimits(80), { maxPerDay: 6, minGapMs: 2 * HOUR });
  assert.deepEqual(initiativeLimits(100), { maxPerDay: 10, minGapMs: 1 * HOUR });
});

test("initiativeLimits：旋钮超出 0–100 时先夹再算；间隔永远在 [45min, 6h] 里", () => {
  const low = initiativeLimits(-30);
  assert.deepEqual(low, { maxPerDay: 0, minGapMs: 6 * HOUR });
  const high = initiativeLimits(250);
  assert.deepEqual(high, { maxPerDay: 10, minGapMs: 1 * HOUR });
  for (const n of [-100, 0, 20, 40, 60, 80, 100, 200]) {
    const { minGapMs } = initiativeLimits(n);
    assert.ok(minGapMs >= 45 * MIN && minGapMs <= 6 * HOUR, "间隔越界：" + n + " → " + minGapMs);
  }
});

test("interactionDelta：三种分支，负数优先", () => {
  // 连续没回 ≥3：哪怕回得快、回得长，也降一档
  assert.equal(
    interactionDelta({ medianReplyMs: 2 * MIN, avgReplyChars: 30, consecutiveMisses: 3, maxGapMs: HOUR }),
    -1
  );
  // 最长一次拖过 24h：同样降
  assert.equal(
    interactionDelta({ medianReplyMs: 2 * MIN, avgReplyChars: 30, consecutiveMisses: 0, maxGapMs: 25 * HOUR }),
    -1
  );
  // 回得快（<10min）且回得长（>15 字）：加一档
  assert.equal(
    interactionDelta({ medianReplyMs: 9 * MIN, avgReplyChars: 16, consecutiveMisses: 0, maxGapMs: HOUR }),
    1
  );
  // 中位正好 10min 不算快；平均正好 15 字不算长
  assert.equal(
    interactionDelta({ medianReplyMs: 10 * MIN, avgReplyChars: 30, consecutiveMisses: 0, maxGapMs: HOUR }),
    0
  );
  assert.equal(
    interactionDelta({ medianReplyMs: 9 * MIN, avgReplyChars: 15, consecutiveMisses: 0, maxGapMs: HOUR }),
    0
  );
  assert.equal(interactionDelta(null), 0);
});

test("initiativeLimits：互动信号 ±1 后夹在 0–10", () => {
  const good = { medianReplyMs: 5 * MIN, avgReplyChars: 20, consecutiveMisses: 0, maxGapMs: HOUR };
  const bad = { medianReplyMs: 5 * MIN, avgReplyChars: 20, consecutiveMisses: 4, maxGapMs: HOUR };
  assert.equal(initiativeLimits(60, good).maxPerDay, 5, "60 基准 4，回得好 +1");
  assert.equal(initiativeLimits(60, bad).maxPerDay, 3, "60 基准 4，被冷落 -1");
  assert.equal(initiativeLimits(100, good).maxPerDay, 10, "上限封在 10");
  assert.equal(initiativeLimits(0, bad).maxPerDay, 0, "下限封在 0");
  assert.equal(initiativeLimits(5, bad).maxPerDay, 0, "基准 0 再 -1 还是 0");
});

test("shouldRecoverInitiative：低于 20 且七天没动过才回血，封顶 20", () => {
  const now = Date.UTC(2026, 0, 15, 12);
  assert.equal(shouldRecoverInitiative({ initiative: 10, lastMovedAt: null, now }), 15);
  assert.equal(shouldRecoverInitiative({ initiative: 10, lastMovedAt: now - 8 * DAY, now }), 15);
  // 正好七天也算「≥7 天」
  assert.equal(shouldRecoverInitiative({ initiative: 10, lastMovedAt: now - 7 * DAY, now }), 15);
  // 一天前动过：不动
  assert.equal(shouldRecoverInitiative({ initiative: 10, lastMovedAt: now - DAY, now }), null);
  // 已经到 20：不动
  assert.equal(shouldRecoverInitiative({ initiative: 20, lastMovedAt: null, now }), null);
  // 18 涨到 20 就封顶
  assert.equal(shouldRecoverInitiative({ initiative: 18, lastMovedAt: null, now }), 20);
});

/* ---------------------------------------------------------------- 主动档案 */

test("appendPingLog：新的在前，最多 5 条，不动原数组", () => {
  const old = [entry(4 * HOUR), entry(3 * HOUR), entry(2 * HOUR), entry(1 * HOUR)];
  const fresh = { ...entry(0), text: "新的一条" };
  const next = appendPingLog(old, fresh);
  assert.equal(next.length, 5);
  assert.equal(next[0], fresh, "新条目放在最前");
  assert.equal(next[4], old[3], "老的往后挪一位");
  assert.equal(old.length, 4, "原数组不被改");
  assert.notEqual(next, old);

  // 超过 5 条就截掉最老的
  let log = [];
  for (let i = 0; i < 7; i += 1) log = appendPingLog(log, { ...entry(0), text: "第" + i + "条" });
  assert.equal(log.length, PING_LOG_LIMIT);
  assert.equal(log[0].text, "第6条");
  assert.equal(log[4].text, "第2条", "第0、1条被截掉");
});

test("interactionFromLog：只看最近 7 天，算中位/平均字数/最长延迟", () => {
  const now = Date.UTC(2026, 0, 15, 12);
  const log = [
    entry(now - 2 * HOUR, { replyDelayMs: 5 * MIN, userLine: "今天怎么样啊" }), // 6 字
    entry(now - DAY, { replyDelayMs: 30 * MIN, userLine: "嗯" }), // 1 字
    entry(now - 2 * DAY, { replyDelayMs: 10 * MIN, userLine: "你拆的是哪一具" }), // 7 字
    entry(now - 8 * DAY, { replyDelayMs: 99 * MIN, userLine: "八天前的老消息，不该算" }),
  ];
  const s = interactionFromLog(log, now);
  assert.equal(s.medianReplyMs, 10 * MIN, "三个延迟 5/30/10，中位 10");
  assert.equal(s.maxGapMs, 30 * MIN);
  assert.ok(Math.abs(s.avgReplyChars - 14 / 3) < 1e-9, "平均字数≈4.67，八天前那条不算");
  assert.equal(s.consecutiveMisses, 0, "最新一条有回复，连续没回是 0");
});

test("interactionFromLog：偶数个延迟取中间两个平均；连续没回从最新往前数", () => {
  const now = Date.UTC(2026, 0, 15, 12);
  const even = [
    entry(now - HOUR, { replyDelayMs: 10 * MIN }),
    entry(now - 2 * HOUR, { replyDelayMs: 20 * MIN }),
  ];
  assert.equal(interactionFromLog(even, now).medianReplyMs, 15 * MIN);

  const log = [
    entry(now - HOUR), // 没回
    entry(now - 2 * HOUR), // 没回
    entry(now - 3 * HOUR, { replyDelayMs: 5 * MIN }), // 回了，停
    entry(now - 4 * HOUR), // 更早的没回，不算进连续数
  ];
  assert.equal(interactionFromLog(log, now).consecutiveMisses, 2);

  const allMissed = [entry(now - HOUR), entry(now - 2 * HOUR), entry(now - 3 * HOUR)];
  assert.equal(interactionFromLog(allMissed, now).consecutiveMisses, 3);
  // 七天内一条都没有：所有信号都是空
  const stale = [entry(now - 8 * DAY, { replyDelayMs: 5 * MIN, userLine: "老" })];
  assert.deepEqual(interactionFromLog(stale, now), {
    medianReplyMs: null,
    avgReplyChars: null,
    consecutiveMisses: 0,
    maxGapMs: null,
  });
});

test("buildPingArchiveNote：空档案 null，有档案含相对时间/说了什么/他多久回，≤300 字", () => {
  const now = Date.UTC(2026, 0, 15, 12);
  assert.equal(buildPingArchiveNote([], now), null);

  const log = [
    entry(now - 3 * HOUR, {
      text: "我在实验舱拆人偶，拆坏了",
      replyDelayMs: 5 * MIN,
      userLine: "你拆的是哪一具？",
    }),
  ];
  const note = buildPingArchiveNote(log, now);
  assert.ok(note.startsWith("你上次找他"), "第一人称，不用「记录显示」：" + note);
  assert.ok(note.includes("3小时前"), "带相对时间");
  assert.ok(note.includes("拆人偶"), "带上次说了什么");
  assert.ok(note.includes("5分钟") && note.includes("回了"), "带他多久回");
  assert.ok(note.includes("你拆的是哪一具"), "带他最后一句");
  assert.ok(note.length <= 300);

  // 还没回
  const missed = buildPingArchiveNote([entry(now - HOUR, { text: "在吗" })], now);
  assert.ok(missed.includes("还没回"), missed);

  // 超长内容压到 300 字以内
  const long = buildPingArchiveNote(
    [
      entry(now - HOUR, {
        text: "长".repeat(400),
        replyDelayMs: 5 * MIN,
        userLine: "也长".repeat(200),
      }),
    ],
    now
  );
  assert.ok(long.length <= 300, "档案旁注最多 300 字，实际 " + long.length);
});

test("fillPingReplies：只补它之后的第一条 user 块，不拿最后一条顶替", () => {
  const now = Date.UTC(2026, 0, 15, 12);
  const sent = new Date(now - 2 * HOUR).toISOString();
  const log = [entry(sent, { text: "想起你了" })];
  const blocks = [
    { kind: "herta", at: new Date(now - 2 * HOUR + 60_000).toISOString(), text: "想起你了" },
    { kind: "sticker", at: new Date(now - 90 * MIN).toISOString() },
    { kind: "user", at: new Date(now - 80 * MIN).toISOString(), text: "我在忙" },
    { kind: "user", at: new Date(now - 10 * MIN).toISOString(), text: "刚看到，怎么了" },
  ];
  const filled = fillPingReplies(log, blocks, now);
  assert.equal(filled.changed, true);
  assert.equal(filled.log[0].replyDelayMs, 40 * MIN, "取第一条 user 块，不是最后一条");
  assert.equal(filled.log[0].userLine, "我在忙");
  assert.equal(log[0].replyDelayMs, null, "不改传进来的数组");

  // 已经回过的、以及还没人回的都不动
  const done = fillPingReplies([entry(sent, { replyDelayMs: MIN })], blocks, now);
  assert.equal(done.changed, false);
  const nobody = fillPingReplies([entry(new Date(now - 5 * MIN).toISOString(), { text: "刚发的" })], blocks, now);
  assert.equal(nobody.changed, false);
});

test("moodForPing：空心情 null、负面档 null、平静/倾听照带", () => {
  assert.equal(moodForPing(null, []), null);
  assert.equal(moodForPing("", []), null);
  assert.equal(moodForPing("被烦", ["被烦", "被戳穿", "被顶嘴"]), null);
  assert.equal(moodForPing("平静", ["被烦", "被戳穿", "被顶嘴"]), "平静");
  assert.equal(moodForPing("倾听", []), "倾听");
});

/* ------------------------------------------------------------ presence 接线 */

test("decidePresencePing：给了 maxPerDay/minGapMs 就按它判，不给还是旧常量", () => {
  const now = new Date(2026, 0, 15, 10, 0, 0); // 上午，不在安静时段
  const base = { now, seenKey: "不是这一段", countToday: 0, lastPingAt: null, random: 0.1 };

  assert.equal(decidePresencePing({ ...base, maxPerDay: 1, minGapMs: 4 * HOUR }).fire, true);
  assert.equal(
    decidePresencePing({ ...base, countToday: 1, maxPerDay: 1 }).reason,
    "daily-cap",
    "旋钮给的上限优先"
  );
  assert.equal(
    decidePresencePing({ ...base, lastPingAt: now.getTime() - 3 * HOUR, minGapMs: 4 * HOUR }).reason,
    "too-soon"
  );
  assert.equal(
    decidePresencePing({ ...base, lastPingAt: now.getTime() - 3 * HOUR, minGapMs: 2 * HOUR }).fire,
    true,
    "间隔够就放行"
  );
});
