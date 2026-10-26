/**
 * 纯净版。
 *
 * 用 `vite build --mode pure` 打出的一份特殊构建：装上去第一次打开就把本地数据全清掉，
 * 只留那 628 条对话。没有种子记忆、没有旧会话、没有表情包。
 *
 * 为什么用 mode 而不是环境变量：mode 是构建期常量，打包时那一整支代码会被静态求值，
 * 普通构建里这段连同那份 887KB 的对话一起被摇掉，不会平白撑大安装包。
 */

import { loadPureSession } from "./data/loader.ts";
import { clearAll, listSessions, putSession } from "./storage.ts";
import { parseImportBundle, planImport } from "@herta/core";

export const PURE = import.meta.env.MODE === "pure";

const PURE_FLAG = "herta.pure.v1";

/**
 * 把库清空，然后只放那一条对话进去。
 * 只在**第一次**打开时做一次——否则你跟她聊两句、切到后台回来，历史就没了。
 */
export async function seedPureIfNeeded(): Promise<void> {
  if (!PURE) return;
  if (localStorage.getItem(PURE_FLAG) === "1") return;

  await clearAll();
  // 顺手把"种子记忆只搬一次"的标记也立上，免得后面又被塞回四篇废案
  localStorage.setItem("herta.seeded.v1", "1");

  const bundle = await loadPureSession();
  const parsed = parseImportBundle(JSON.stringify(bundle));
  if (parsed.ok) {
    const plan = planImport(parsed.bundle, new Set((await listSessions()).map((s) => s.id)));
    for (const s of plan.toWrite) await putSession(s);
  }

  localStorage.setItem(PURE_FLAG, "1");
}
