/**
 * `prompts-code.zh.mjs` 的类型声明（只声明这个仓库真正用到的那几个）。
 *
 * 那个文件是 196 个函数的原文搬运，给它补全类型没有意义——补了也是在描述别人写的东西。
 * 这里只钉住我们调用的入口，剩下的一律 any。
 */

type RenderBlock = {
  kind: "user" | "herta" | "system";
  surface?: "speech" | "thought";
  text?: string;
  label?: string;
  body?: string;
  at?: string;
};

export interface SupervisorPromptInput {
  feianFewShots: string[];
  lang: string;
  currentState: string;
  recentRecord: RenderBlock[];
  currentTurnThought: string;
  candidateSpeech: string;
  sessionReceipts: unknown[];
}

export declare const USER_MESSAGE_SEPARATOR: string;

export declare function buildSupervisorPrompt(input: SupervisorPromptInput): { prompt: string };

export declare function buildEpisodeDigest(blocks: RenderBlock[]): string;
export declare function buildWorthinessPrompt(digest: string, summaries: unknown[], env: string, lang?: string): string;
export declare function buildGenerationPrompt(
  digest: string,
  exemplars: string[],
  summaries: unknown[],
  guide: string,
  env: string,
  lang?: string
): string;
export declare function buildCritiquePrompt(draft: string, guide: string, lang?: string, digest?: string): string;
export declare function buildRefinePrompt(draft: string, errors: readonly string[], guide: string, lang?: string): string;
export declare function validateFeian(text: string): { ok: true } | { ok: false; errors: string[] };
