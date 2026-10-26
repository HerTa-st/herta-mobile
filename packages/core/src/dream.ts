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
import { repairFeian } from "./feian.ts";
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
  /** 只剩环境设定：语气指南不再打包，也不再喂给提示词。 */
  scene: { env: string; lang: string };
  /**
   * 记忆攒够之后，让她重读自己的记忆、重写「我说话的方式」。
   * 由调用方注入（提示词与清洗都在 voice.ts）。
   */
  reviseVoice?(records: readonly MemoryRecord[], previous: string | null): Promise<string | null>;
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
  /** 每攒够几篇记忆，重写一次语气笔记。 */
  voiceEvery: number;
  /** 语气分低于这个值就改。 */
  minVoice: number;
  /** 忠实度分低于这个值就改。 */
  minFaithfulness: number;
}

export const DREAM_PASS_DEFAULTS: DreamPassConfig = {
  minNewBlocks: 6,
  minGapMs: 10 * 60 * 1000,
  exemplarCount: 3,
  voiceEvery: 3,
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
    voice: patch.voice ?? state.voice,
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

  /* 写作与评审的"语气基线"不再是一份固定指南，而是**她自己写的那段笔记**。
   * 没有笔记时传空串——提示词里会退化成"按语气不变量与范例来"，也说得通。 */
  const voiceGuide = state.voice?.text ?? "";

  /* 第二道门：写一稿 */
  const exemplars = records.slice(-cfg.exemplarCount).map((r) => r.body);
  const draftRaw = (await askJson(
    deps,
    deps.prompts.buildGenerationPrompt(digest, exemplars, summaries, voiceGuide, deps.scene.env, deps.scene.lang),
    4000
  ) ?? {}) as Draft;

  let body = String(draftRaw.feian ?? "").trim();
  let tag = String(draftRaw.situationTag ?? "").trim();
  if (!body) {
    const note = "这一篇没写成：模型没给出正文";
    await deps.store.saveState(advance(state, input.sessionId, nextCursor, { lastNote: note }));
    return { kind: "failed", reason: note };
  }

  /* 第三道门：格式 + 语气。格式是死规矩，语气是她的招牌。
   *
   * 但**格式可以机械修**：首行没写对、少了那根 ---，这些跟她像不像她毫无关系。
   * 先就地修好再去问评审，省掉一次「改一遍」，也不至于为一道格式丢掉一段记忆。 */
  const index = nextMemoryIndex(records);
  const titleHint = tag || "无题";
  let repaired: string | null = null;

  const tryRepair = (): boolean => {
    const fix = repairFeian(body, index, titleHint);
    if (!fix.changed) return false;
    if (!deps.prompts.validateFeian(fix.text).ok) return false;
    body = fix.text;
    repaired = fix.reason;
    return true;
  };

  let problems: string[] = [];
  let check = deps.prompts.validateFeian(body);
  if (!check.ok) {
    if (!tryRepair()) problems = check.errors;
    else check = deps.prompts.validateFeian(body);
  }

  const critiqueRaw = (await askJson(
    deps,
    deps.prompts.buildCritiquePrompt(body, voiceGuide, deps.scene.lang, digest),
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
      deps.prompts.buildRefinePrompt(body, problems, voiceGuide, deps.scene.lang),
      4000
    ) ?? {}) as Draft;
    if (refinedRaw.feian) {
      body = String(refinedRaw.feian).trim();
      tag = String(refinedRaw.situationTag ?? tag).trim();
    }
    let recheck = deps.prompts.validateFeian(body);
    if (!recheck.ok) {
      // 改完还只是格式问题 → 再机械修一次；真修不好才算失败。
      if (!tryRepair()) {
        const note = "改了一遍还是不合格：" + recheck.errors.slice(0, 2).join("；");
        await deps.store.saveState(advance(state, input.sessionId, nextCursor, { lastNote: note }));
        return { kind: "failed", reason: note };
      }
      recheck = deps.prompts.validateFeian(body);
    }
  }

  const title = memoryTitle({ name: "### 废案_00：新记忆.txt", body, createdAt: "", sessionId: input.sessionId });
  const record: MemoryRecord = {
    name: memoryFileName(index, title),
    body,
    createdAt: new Date(deps.now()).toISOString(),
    sessionId: input.sessionId,
    tag,
  };
  await deps.store.write(record);

  /* 攒够几篇，就让她重读一遍自己的记忆、重写「我说话的方式」。 */
  const nextMade = state.made + 1;
  let voiceProfile = state.voice;
  let voiceNote = "";
  if (deps.reviseVoice && nextMade % cfg.voiceEvery === 0) {
    try {
      const written = await deps.reviseVoice([...records, record], state.voice?.text ?? null);
      if (written && written.trim()) {
        voiceProfile = { text: written.trim(), updatedAt: new Date(deps.now()).toISOString(), basis: records.length + 1 };
        voiceNote = "，顺手改了自己说话的方式";
      }
    } catch {
      // 语气笔记没写成不算这次做梦失败——记忆已经落库了，别把它一起废掉
    }
  }

  const note = "记住了一件事：" + title + (repaired ? "（格式我修了一下：" + repaired + "）" : "") + voiceNote;
  await deps.store.saveState(
    advance(state, input.sessionId, nextCursor, {
      made: nextMade,
      lastPassAt: deps.now(),
      lastNote: note,
      voice: voiceProfile,
    })
  );
  return { kind: "made", record };
}
