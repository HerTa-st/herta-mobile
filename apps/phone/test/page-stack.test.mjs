import { test } from "node:test";
import assert from "node:assert/strict";
import { closePage, popPage, pushPage, replacePage, resetStack } from "../src/nav/stack.ts";

/* 侧栏一级入口（记忆 / 播报 / 黑塔币）是「换频道」：栈里只能留下它自己。
   B2 把三个布尔量换成 push 栈之后，三个入口都走 push，兄弟页全挂在栈里；
   CSS 里每页的 z-index 是写死的（币 55 / 播报 56），画面顺序于是跟栈序脱钩，
   点「黑塔币」画出来的是播报页。这组测试锁住 replace 的语义。 */

test("replace：换入口只留一页，兄弟页不留在栈里", () => {
  let stack = resetStack();
  stack = replacePage(stack, "memory");
  stack = replacePage(stack, "broadcast");
  stack = replacePage(stack, "coin");
  assert.deepEqual(stack.map((e) => e.name), ["coin"]);
});

test("replace：同一页再换一次不叠也不丢", () => {
  const stack = replacePage(replacePage(resetStack(), "broadcast"), "broadcast");
  assert.deepEqual(stack.map((e) => e.name), ["broadcast"]);
});

test("replace：chat 归零", () => {
  assert.deepEqual(replacePage(replacePage(resetStack(), "coin"), "chat"), []);
});

test("replace：带参数进去能取回来", () => {
  const stack = replacePage(resetStack(), "memoryDetail", { title: "某个节点" });
  assert.equal(stack.length, 1);
  assert.deepEqual(stack[0].param, { title: "某个节点" });
});

test("push 仍是叠楼层：设置里再压一页，退回来还在设置", () => {
  let stack = replacePage(resetStack(), "memory");
  stack = pushPage(stack, "memoryGraph");
  assert.deepEqual(stack.map((e) => e.name), ["memory", "memoryGraph"]);
  stack = popPage(stack);
  assert.deepEqual(stack.map((e) => e.name), ["memory"]);
});

test("push 不重复挂同一页", () => {
  const stack = pushPage(pushPage(resetStack(), "settings"), "settings");
  assert.equal(stack.length, 1);
});

test("close 能从中间摘掉，不是只能退栈顶", () => {
  let stack = pushPage(pushPage(replacePage(resetStack(), "memory"), "memoryGraph"), "memoryDetail");
  stack = closePage(stack, "memoryGraph");
  assert.deepEqual(stack.map((e) => e.name), ["memory", "memoryDetail"]);
});
