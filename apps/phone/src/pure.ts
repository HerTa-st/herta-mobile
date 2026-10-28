/**
 * 白纸版（以及退役的纯净版）。
 *
 * `vite build --mode blank`：装上去第一次打开把本地数据全清掉——没有会话、没有记忆、
 * 没有表情包，她只带着自传和话术从零开始。而且**只对"新装"是白纸**：库里已经有东西
 * 说明是老用户在换安装包，这时不清库。
 *
 * `--mode pure` 曾经会灌入那 628 条内置对话。2026-10-28 用户要求把那段聊天历史从
 * 仓库里清掉，数据文件已删；现在 pure 与 blank 的行为一致，只为兼容旧构建命令留着。
 *
 * 为什么用 mode 而不是环境变量：mode 是构建期常量，普通构建里这段代码会被静态求值摇掉。
 */

import { clearAll, hasLocalData } from "./storage.ts";

export const PURE = import.meta.env.MODE === "pure";
/** 白纸版：清完库什么都不留。 */
export const BLANK = import.meta.env.MODE === "blank";

/**
 * 每档一个标记：装另一档盖上去时，得重新清一次——不然"白纸"就是句空话。
 */
const MODE = import.meta.env.MODE;
const PURE_FLAG = "herta.seed." + MODE + ".v1";

/**
 * 清库。只在**第一次**打开这一档时做一次——否则你跟她聊两句、切到后台回来，历史就没了。
 */
export async function seedPureIfNeeded(): Promise<void> {
  if (!PURE && !BLANK) return;
  if (localStorage.getItem(PURE_FLAG) === "1") return;

  // 种子记忆只搬一次的标记：白纸版也不能让四篇废案回来
  localStorage.setItem("herta.seeded.v1", "1");

  // 白纸版只对"新装"是白纸：库里已经有东西，就别删人家的数据
  if (await hasLocalData().catch(() => true)) {
    localStorage.setItem(PURE_FLAG, "1");
    return;
  }

  await clearAll();
  localStorage.setItem(PURE_FLAG, "1");
}
