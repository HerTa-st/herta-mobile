/**
 * 做梦：把一段对话蒸馏成一则废案（她的记忆）。
 *
 * 算法是我们重写的，但每一步问的问题都是桌面版原文（buildWorthinessPrompt /
 * buildGenerationPrompt / buildCritiquePrompt / buildRefinePrompt），
 * 格式校验也是原文（validateFeian）。所以产出和桌面版同一个形状。
 *
 * 一次 pass 的路径：
 *   材料够不够 → 值不值得记 → 写一稿 → 格式/语气评审 → 不合格就改一遍 → 落库
 *
 * 与桌面版的差距（照实记）：
 *   - 没做再激活 / 遗忘 / 语义化 / 淘汰（那些要长期时间轴，等有了足够的真实使用再说）；
 *   - 没做"事件重述"（retellsKnownEvent）那一支；
 *   - 门槛用的是手机端自己的（material 6 块、间隔 10 分钟），不是桌面版那四道。
 */

import type { Block } from "../../protocol/src/index.ts";
import {
  EMPTY_STATE,
  memoryFileName,
  memoryTitle,
  nextMemoryIndex,
  type DreamState,
  type MemoryRecord,
  type MemoryStore,
} from "./memory.ts";

/**
 * 桌面版的建造函数返回的是 **两条消息**：`{ systemPrompt, userPayload }`，
 * 不是一整段字符串。照 `buildSupervisorPrompt` 的形状来就对了。
 *
 * 第一版把返回值直接当 content 塞进 messages，请求体里 content 成了对象，
 * 服务端回 422 Invalid Parameters——教训：**这类"看起来像字符串"的东西先打出来看一眼**。
 */
export interface DreamPrompt {
  systemPrompt: string;
  userPayload: string;
}

export interface DreamPrompts {
  buildEpisodeDigest(blocks: Block[]): string;
  buildWorthinessPrompt(
    digest: string,
    summaries: readonly { title: string; tag: string }[],
    env: string,
    lang?: string
  ): DreamPrompt | string;
  buildGenerationPrompt(
    digest: string,
    exemplars: readonly string[],
    summaries: readonly { title: string; tag: string }[],
    guide: string,
    env: string,
    lang?: string
  ): DreamPrompt | string;
  buildCritiquePrompt(draft: string, guide: string, lang?: string, digest?: string): DreamPrompt | string;
  buildRefinePrompt(draft: string, errors: readonly string[], guide: string, lang?: string): DreamPrompt | string;
  validateFeian(text: string): { ok: true } | { ok: false; errors: string[] };
}

/** 兼容两种返回形状：字符串当 user，对象原样拆。 */
function asPrompt(value: DreamPrompt | string): DreamPrompt {
  return typeof value === "string" ? { systemPrompt: "", userPayload: value } : value;
}

export interface DreamDeps {
  store: MemoryStore;
  prompts: DreamPrompts;
  /** 桌面版的 envSet 与 hertaGuide —— 做梦提示词里把这两段原样喂回去。 */
  scene: { env: string; guide: string; lang: string };
  /** 发一次请求。`system` 为空时就只发 user。 */
  chat(input: { system: string; user: string; maxTokens: number }): Promise<string>;
  now(): number;
}

export interface DreamPassConfig {
  /** 至少攒够这么多块才开始做梦。 */
  minNewBlocks: number;
  /** 两次做梦之间至少隔这么久。 */
  minGapMs: number;
  /** 生成时给几篇既有废案当范例。 */
  exemplarCount: number;
  /** 语气分低于这个值就改。 */
  minVoice: number;
  /** 忠实度分低于这个值就改。 */
  minFaithfulness: number;
}

export const DREAM_PASS_DEFAULTS: DreamPassConfig = {
  minNewBlocks: 6,
  minGapMs: 10 * 60 * 1000,
  exemplarCount: 3,
  minVoice: 0.7,
  minFaithfulness: 0.6,
};

export type DreamOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "made"; record: MemoryRecord }
  | { kind: "rejected"; reason: string }
  | { kind: "failed"; reason: string };

interface Worthiness {
  worthy?: boolean;
  reason?: string;
  occasion?: string;
}

interface Draft {
  feian?: string;
  situationTag?: string;
}

interface Critique {
  voice?: number;
  format?: number;
  novelty?: number;
  charge?: number;
  faithfulness?: number;
  fixes?: string[];
}

/** 模型爱把 JSON 包在 ```json 里。抽不出来就当没给——宁可记一次失败，也别猜。 */
export function extractJson(raw: string): unknown {
  const text = String(raw ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function askJson(
  deps: DreamDeps,
  prompt: DreamPrompt | string,
  maxTokens: number
): Promise<Record<string, unknown> | null> {
  const { systemPrompt, userPayload } = asPrompt(prompt);
  const raw = await deps.chat({ system: systemPrompt, user: userPayload, maxTokens });
  const parsed = extractJson(raw);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

function advance(state: DreamState, sessionId: string, cursor: number, patch: Partial<DreamState>): DreamState {
  return {
    ...state,
    cursors: { ...state.cursors, [sessionId]: cursor },
    lastPassAt: patch.lastPassAt ?? state.lastPassAt,
    made: patch.made ?? state.made,
    skipped: patch.skipped ?? state.skipped,
    lastNote: patch.lastNote ?? state.lastNote,
  };
}

/**
 * 跑一次。**同一时间只能有一次 pass**——两趟同时写记忆库会撞编号。
 * 调用方负责串行（App 里用一个 in-flight 标志）。
 */
export async function runDreamPass(
  deps: DreamDeps,
  input: { sessionId: string; blocks: readonly Block[]; config?: Partial<DreamPassConfig> }
): Promise<DreamOutcome> {
  const cfg: DreamPassConfig = { ...DREAM_PASS_DEFAULTS, ...(input.config ?? {}) };
  const state = (await deps.store.state()) ?? { ...EMPTY_STATE };
  const cursor = state.cursors[input.sessionId] ?? 0;
  const pending = input.blocks.slice(cursor);

  if (pending.length < cfg.minNewBlocks) {
    return { kind: "skipped", reason: "材料还不够（" + pending.length + "/" + cfg.minNewBlocks + " 块）" };
  }
  const gap = state.lastPassAt === null ? Infinity : deps.now() - state.lastPassAt;
  if (gap < cfg.minGapMs) {
    return { kind: "skipped", reason: "刚做过梦，隔一会儿再说" };
  }

  const digest = deps.prompts.buildEpisodeDigest([...pending]);
  const records = await deps.store.list();
  const summaries = records.map((r) => ({ title: memoryTitle(r), tag: r.tag ?? "" }));
  const nextCursor = input.blocks.length;

  /* 第一道门：值不值得记 */
  const worthRaw = await askJson(
    deps,
    deps.prompts.buildWorthinessPrompt(digest, summaries, deps.scene.env, deps.scene.lang),
    600
  );
  const worth = (worthRaw ?? {}) as Worthiness;
  if (!worth.worthy) {
    const note = "这段没记住：" + (worth.reason ?? "不值得");
    await deps.store.saveState(advance(state, input.sessionId, nextCursor, { skipped: state.skipped + 1, lastNote: note }));
    return { kind: "rejected", reason: note };
  }

  /* 第二道门：写一稿 */
  const exemplars = records.slice(-cfg.exemplarCount).map((r) => r.body);
  const draftRaw = (await askJson(
    deps,
    deps.prompts.buildGenerationPrompt(digest, exemplars, summaries, deps.scene.guide, deps.scene.env, deps.scene.lang),
    4000
  ) ?? {}) as Draft;

  let body = String(draftRaw.feian ?? "").trim();
  let tag = String(draftRaw.situationTag ?? "").trim();
  if (!body) {
    const note = "这一篇没写成：模型没给出正文";
    await deps.store.saveState(advance(state, input.sessionId, nextCursor, { lastNote: note }));
    return { kind: "failed", reason: note };
  }

  /* 第三道门：格式 + 语气。格式是死规矩，语气是她的招牌。 */
  let problems: string[] = [];
  const check = deps.prompts.validateFeian(body);
  if (!check.ok) problems = check.errors;

  const critiqueRaw = (await askJson(
    deps,
    deps.prompts.buildCritiquePrompt(body, deps.scene.guide, deps.scene.lang, digest),
    900
  ) ?? {}) as Critique;
  const voice = Number(critiqueRaw.voice ?? 0);
  const faithful = Number(critiqueRaw.faithfulness ?? 1);
  if (voice > 0 && voice < cfg.minVoice) problems.push(...(critiqueRaw.fixes ?? []).slice(0, 4));
  if (faithful < cfg.minFaithfulness) problems.push(...(critiqueRaw.fixes ?? []).slice(0, 4));
  if (voice === 0 && critiqueRaw.voice === undefined) problems.push("评审没给分，按不合格处理");

  /* 第四道门：改一遍。只改一次——改两次以上她会越改越不像她。 */
  if (problems.length > 0) {
    const refinedRaw = (await askJson(
      deps,
      deps.prompts.buildRefinePrompt(body, problems, deps.scene.guide, deps.scene.lang),
      4000
    ) ?? {}) as Draft;
    if (refinedRaw.feian) {
      body = String(refinedRaw.feian).trim();
      tag = String(refinedRaw.situationTag ?? tag).trim();
    }
    const recheck = deps.prompts.validateFeian(body);
    if (!recheck.ok) {
      const note = "改了一遍还是不合格：" + recheck.errors.slice(0, 2).join("；");
      await deps.store.saveState(advance(state, input.sessionId, nextCursor, { lastNote: note }));
      return { kind: "failed", reason: note };
    }
  }

  const index = nextMemoryIndex(records);
  const title = memoryTitle({ name: "### 废案_00：新记忆.txt", body, createdAt: "", sessionId: input.sessionId });
  const record: MemoryRecord = {
    name: memoryFileName(index, title),
    body,
    createdAt: new Date(deps.now()).toISOString(),
    sessionId: input.sessionId,
    tag,
  };
  await deps.store.write(record);

  const note = "记住了一件事：" + title;
  await deps.store.saveState(
    advance(state, input.sessionId, nextCursor, { made: state.made + 1, lastPassAt: deps.now(), lastNote: note })
  );
  return { kind: "made", record };
}
