/**
 * 桌面版原文的提示词函数（805KB，由 acorn 从 app.asar 切出来）。
 *
 * 它放在 runtime/ 而不是 assets/：publicDir 会把 assets/ 整份摊到站点根，
 * 而这份东西只能当模块被 bundler 处理——摊进 dist 当静态文件等于白背 805KB。
 * 它内部 `from '../runtime/dream-io.mjs'` 是生成器写死的，所以两兄弟必须同目录。
 *
 * 只在真要复核时才加载——它不该压首屏。
 */
import type { PromptCode } from "@herta/core";

let cached: PromptCode | null = null;

export async function loadPromptCode(): Promise<PromptCode> {
  if (cached) return cached;
  const mod = (await import("../../../runtime/prompts-code.zh.mjs")) as unknown as {
    buildSupervisorPrompt(input: unknown): { prompt: string };
    USER_PromptSeparator?: string;
    USER_MESSAGE_SEPARATOR: string;
  };
  cached = {
    buildSupervisorPrompt: mod.buildSupervisorPrompt,
    USER_MESSAGE_SEPARATOR: mod.USER_MESSAGE_SEPARATOR,
  };
  return cached;
}
