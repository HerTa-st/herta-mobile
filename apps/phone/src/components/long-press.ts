/**
 * 长按。
 *
 * 手机上没有右键，WebView 里 onContextMenu 也不一定触发，所以两条路都挂上：
 * 触摸计时（420ms）与右键。**不用 hook**——它要能塞进 map 出来的每一个气泡里，
 * 而在循环里调 hook 是违规的。
 *
 * 为什么是 420ms：WebView 自己的长按手势大约 500ms 就开始识别，会先发一个
 * touchcancel 把我们的计时清掉。早 80ms 落锤，长按才不会被系统抢去做文字选择。
 *
 * 返回 { props, fired }：长按之后手指抬起还会补一个 click，用 fired() 把这个 click
 * 吞掉，否则「长按存表情」会顺手把看图页面打开。
 */
import type { MouseEvent, TouchEvent } from "react";

export function longPressProps(run: () => void, ms = 420) {
  let timer: number | null = null;
  let fired = false;
  let startX = 0;
  let startY = 0;
  const clear = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  const props = {
    onTouchStart: (e: TouchEvent) => {
      fired = false;
      clear();
      const t = e.touches[0];
      if (t) {
        startX = t.clientX;
        startY = t.clientY;
      }
      timer = window.setTimeout(() => {
        timer = null;
        fired = true;
        run();
      }, ms);
    },
    onTouchEnd: clear,
    // 手指按着不动时也会零星来几个 touchmove；走开 10px 才算滑动，别把它当取消
    onTouchMove: (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return clear();
      if (Math.hypot(t.clientX - startX, t.clientY - startY) > 10) clear();
    },
    onTouchCancel: clear,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      // 系统长按在触摸计时之后还会补一个 contextmenu：这一次不能再开一遍，
      // 否则「打开」紧接着被同一个手势「关掉」，看起来就是长按没反应。
      if (fired) return;
      fired = true;
      run();
    },
  };
  return { props, fired: () => fired };
}
