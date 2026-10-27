/**
 * 长按。
 *
 * 手机上没有右键，WebView 里 onContextMenu 也不一定触发，所以两条路都挂上：
 * 触摸计时（550ms）与右键。**不用 hook**——它要能塞进 map 出来的每一个气泡里，
 * 而在循环里调 hook 是违规的。
 *
 * 返回 { props, fired }：长按之后手指抬起还会补一个 click，用 fired() 把这个 click
 * 吞掉，否则「长按存表情」会顺手把看图页面打开。
 */
import type { MouseEvent } from "react";

export function longPressProps(run: () => void, ms = 550) {
  let timer: number | null = null;
  let fired = false;
  const clear = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  const props = {
    onTouchStart: () => {
      fired = false;
      clear();
      timer = window.setTimeout(() => {
        timer = null;
        fired = true;
        run();
      }, ms);
    },
    onTouchEnd: clear,
    onTouchMove: clear,
    onTouchCancel: clear,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      fired = true;
      run();
    },
  };
  return { props, fired: () => fired };
}
