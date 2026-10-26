/**
 * 桌面版原文的提示词函数（766KB，由 acorn 从 app.asar 切出来）。
 *
 * 它放在 runtime/ 而不是 assets/：publicDir 会把 assets/ 整份摊到站点根，
 * 而这份东西只能当模块被 bundler 处理——摊进 dist 当静态文件等于白背 766KB。
 * 它内部 `from '../runtime/dream-io.mjs'` 是生成器写死的，所以两兄弟必须同目录。
 *
 * 复核与做梦都要它，所以单独打一个 chunk，按需加载。
 */

import type { PromptCode } from "@herta/core";

export interface PromptModule extends PromptCode {
  buildEpisodeDigest(blocks: unknown[]): string;
  buildWorthinessPrompt(
    digest: string,
    summaries: readonly { title: string; tag: string }[],
    env: string,
    lang?: string
  ): { systemPrompt: string; userPayload: string };
  buildGenerationPrompt(
    digest: string,
    exemplars: readonly string[],
    summaries: readonly { title: string; tag: string }[],
    guide: string,
    env: string,
    lang?: string
  ): { systemPrompt: string; userPayload: string };
  buildCritiquePrompt(draft: string, guide: string, lang?: string, digest?: string): { systemPrompt: string; userPayload: string };
  buildRefinePrompt(draft: string, errors: readonly string[], guide: string, lang?: string): { systemPrompt: string; userPayload: string };
  validateFeian(text: string): { ok: true } | { ok: false; errors: string[] };
}

let cached: PromptModule | null = null;

export async function loadPromptCode(): Promise<PromptModule> {
  if (cached) return cached;
  const mod = (await import("../../../runtime/prompts-code.zh.mjs")) as unknown as PromptModule;
  cached = mod;
  return mod;
}
