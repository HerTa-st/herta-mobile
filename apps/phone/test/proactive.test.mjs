import test from "node:test";
import assert from "node:assert/strict";

import { PING_MAX_GAP_MS, PING_MIN_GAP_MS, fallbackPingLine, pickNextPing } from "../src/proactive.ts";
import { presenceAt } from "@herta/core";

const MIN = 60_000;
const HOUR = 60 * MIN;

test("pickNextPing：给定 random 时落在 [min, max] 之间，且不落在安静时段", () => {
  const now = new Date(2026, 0, 15, 10, 0, 0); // 上午十点
  for (const r of [0, 0.25, 0.5, 0.999]) {
    const at = pickNextPing(now, () => r);
    const gap = at.getTime() - now.getTime();
    assert.ok(gap >= PING_MIN_GAP_MS, "间隔下界 2h，实际 " + gap + "（r=" + r + "）");
    assert.ok(gap <= PING_MAX_GAP_MS + MIN, "间隔上界 5h，实际 " + gap + "（r=" + r + "）");
    const h = at.getHours();
    assert.ok(h >= 8 && h < 22, "应落在 8:00–22:00，实际 " + at.toString());
  }
});

test("pickNextPing：旋钮换算的间隔从第三个参数进；max<min 时按 min 算", () => {
  const now = new Date(2026, 0, 15, 10, 0, 0);
  const early = pickNextPing(now, () => 0, { minGapMs: 4 * HOUR, maxGapMs: 6 * HOUR });
  assert.equal(early.getTime() - now.getTime(), 4 * HOUR, "random=0 落在下界");

  const late = pickNextPing(now, () => 0.999999, { minGapMs: 4 * HOUR, maxGapMs: 6 * HOUR });
  const lateGap = late.getTime() - now.getTime();
  assert.ok(lateGap >= 4 * HOUR && lateGap <= 6 * HOUR, "random→1 落在上界，实际 " + lateGap);

  const guarded = pickNextPing(now, () => 0.5, { minGapMs: 6 * HOUR, maxGapMs: 5 * HOUR });
  assert.equal(guarded.getTime() - now.getTime(), 6 * HOUR, "max<min 不算负数间隔");
});

test("pickNextPing：撞上安静时段推到次日 8 点后", () => {
  // 晚八点 + 将近五小时 → 凌晨，必须推到第二天早上
  const now = new Date(2026, 0, 15, 20, 0, 0);
  const at = pickNextPing(now, () => 0.99);
  assert.equal(at.getFullYear(), 2026);
  assert.equal(at.getMonth(), 0);
  assert.equal(at.getDate(), 16, "跨到第二天：" + at.toString());
  assert.equal(at.getHours(), 8, "八点之后才发：" + at.toString());
  assert.ok(at.getMinutes() >= 15 && at.getMinutes() < 55, "别正好卡在八点整：" + at.toString());

  // 晚上九点半 + 两小时 → 当天 23:30，同样推到次日
  const late = new Date(2026, 0, 15, 21, 30, 0);
  const next = pickNextPing(late, () => 0);
  assert.equal(next.getDate(), 16);
  assert.equal(next.getHours(), 8);
});

test("fallbackPingLine：按行踪拼一句，带上地点", () => {
  const p = presenceAt(new Date(2026, 0, 15, 10, 0, 0));
  const line = fallbackPingLine(p);
  assert.ok(line.includes("我在"), line);
  assert.ok(line.includes(p.place), "要说出她在哪：" + line);
  assert.ok(line.includes(p.doing), "要说出她在干嘛：" + line);
  assert.ok(line.includes("想起你了"), line);
});
