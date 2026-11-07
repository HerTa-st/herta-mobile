/**
 * 桌面版原文的提示词函数（824KB，由 acorn 从 app.asar 切出来）。
 *
 * 它放在 runtime/ 而不是 assets/：publicDir 会把 assets/ 整份摊到站点根，
 * 而这份东西只能当模块被 bundler 处理——摊进 dist 当静态文件等于白背 824KB。
 * 它内部 `from '../runtime/dream-io.mjs'` 是生成器写死的，所以两兄弟必须同目录。
 *
 * 正文不进仓库（824KB，且夹着私聊原文），clone 下来默认没有这个文件，
 * 生成方法见 runtime/README.md。所以这里不用静态 import，改用 import.meta.glob：
 * - 文件在 → 打包成单独 chunk，复核/做梦时才拉（按需加载）；
 * - 文件不在 → 拿到空对象，typecheck 与构建都不会因为「找不到模块」挂掉，
 *   真要用复核/做梦时再抛一句能看懂的话。
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

/**
 * import.meta.glob 是字符串字面量，Vite 在构建期展开；没有文件时得到空对象
 * （Vite 只打一条 warning，不中断构建），这正是「仓库里没有它也能 build」要的行为。
 */
const promptCodeModules = import.meta.glob("../../../runtime/prompts-code.zh.mjs");

export async function loadPromptCode(): Promise<PromptModule> {
  if (cached) return cached;
  const load = Object.values(promptCodeModules)[0];
  if (!load) {
    throw new Error(
      "缺 runtime/prompts-code.zh.mjs：复核与做梦要用它，但它的正文不进仓库。" +
        "生成方法见 runtime/README.md（跑旧仓库的 tools/extract-code-prompts.mjs，需要本机桌面版 app.asar）。"
    );
  }
  const mod = (await load()) as unknown as PromptModule;
  cached = mod;
  return mod;
}
