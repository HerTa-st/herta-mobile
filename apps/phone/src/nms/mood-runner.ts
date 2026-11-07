/**
 * 心情判定自修改执行器。
 *
 * 两条路都用这里：
 *   - 对话里的写工具（Lead 接线）：把模型写好的三段交给 reviseMoodRules 校验 + 落盘；
 *   - 深睡成功后的自查：reviewMoodRulesAfterDeepSleep 读最近的判定日志与记忆，
 *     由她自己决定 keep 还是改。
 *
 * 能改的只有三段（触发描述 / 判定边界 / 优先级）；八种状态名、输出格式、数值阈值
 * 由代码锁死——校验用 @herta/core 的 validateMoodSections，这里只负责门槛、提示词、落盘。
 * 状态在 NMS meta 的 mood_rules（packages/nms/src/mood-rules.ts），留 5 版快照。
 */
import { Capacitor } from "@capacitor/core";
import {
  MOOD_SECTION_LIMITS,
  MOOD_SECTION_LABELS,
  validateMoodSections,
} from "@herta/core";
import type { MoodPack, MoodSections } from "@herta/core";
import {
  applyMoodRevision,
  extractJsonObject,
  readMoodRules,
  rollbackMoodRules,
  writeMoodRules,
} from "@herta/nms";
import type { MoodRulesState, NmsStore } from "@herta/nms";
import { collectDetailed } from "../stream.ts";
import { recordUsageFrom } from "../usage-ledger.ts";
import type { Settings } from "../settings.ts";
import { pickTransport } from "../transport.ts";
import { BrowserAssetSource } from "../assets-browser.ts";
import { getNmsStore } from "./controller.ts";

const transport = pickTransport();
/** 判定日志在 NMS meta 里的键（写日志的是 App 那侧）。 */
export const MOOD_VERDICT_LOG_KEY = "moodVerdictLog";
/** 一次自查最多读几条判定日志。 */
export const MOOD_VERDICT_LOG_LIMIT = 20;
/** 一次自查最多读几篇记忆。 */
export const MOOD_REVIEW_SAMPLE_LIMIT = 6;
/** 自查的输出预算：三段加起来最多 3000 字，JSON 装得下。 */
export const MOOD_REVIEW_MAX_TOKENS = 2400;
/** 日志/记忆塞进提示词的总字数上限。 */
const MOOD_REVIEW_CONTEXT_MAX_CHARS = 6000;

let reviewRunning = false;

export interface MoodReviseInput {
  settings: Settings;
  sections: { triggers: string; boundaries: string; priority: string };
  reason: string;
  evidence?: string;
}

export type MoodReviseResult =
  | { ok: true; state: MoodRulesState }
  | { ok: false; error: string; errors?: string[] };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 读当前状态（给 useMemory / App 用）；读不到就 null。 */
export async function readMoodRulesState(): Promise<MoodRulesState | null> {
  try {
    const store = await getNmsStore();
    return await readMoodRules(store);
  } catch {
    return null;
  }
}

/** 回滚到某个历史版本；找不到/写不成返回 null。 */
export async function rollbackMoodRulesTo(version: number): Promise<MoodRulesState | null> {
  try {
    const store = await getNmsStore();
    const previous = await readMoodRules(store);
    if (!previous) return null;
    let next: MoodRulesState;
    try {
      next = rollbackMoodRules(previous, version);
    } catch {
      return null;
    }
    await writeMoodRules(store, next);
    return next;
  } catch {
    return null;
  }
}

/**
 * 写入一版新判定（对话工具与自查共用）。
 *
 * 门槛与自动语气一致：原生、有 Key、非省 token 模式。
 * 三段先过 core 的校验；不通过返回可以直接给她看的中文 errors。
 */
export async function reviseMoodRules(input: MoodReviseInput): Promise<MoodReviseResult> {
  if (!Capacitor.isNativePlatform()) return { ok: false, error: "web_platform" };
  if (!input.settings.apiKey) return { ok: false, error: "no_key" };
  if (input.settings.cheapMode) return { ok: false, error: "cheap_mode" };
  try {
    const pack = await new BrowserAssetSource().mood();
    if (!pack) return { ok: false, error: "no_pack" };
    const check = validateMoodSections(pack, input.sections);
    if (!check.ok) return { ok: false, error: "invalid_sections", errors: check.errors };
    const store = await getNmsStore();
    const previous = await readMoodRules(store);
    const next = applyMoodRevision(previous, input.sections, {
      reason: input.reason,
      evidence: input.evidence,
    });
    await writeMoodRules(store, next);
    return { ok: true, state: next };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** 最近几条有正文的 ep/sem，按时间从旧到新（和 collectVoiceSamples 同口径）。 */
async function collectRecentMemories(store: NmsStore, limit = MOOD_REVIEW_SAMPLE_LIMIT): Promise<string[]> {
  const nodes = await store.listNodes({});
  return nodes
    .filter((node) => (node.tier === "ep" || node.tier === "sem") && node.body.trim().length > 0)
    .sort((a, b) => (a.createdAt === b.createdAt ? a.id - b.id : a.createdAt < b.createdAt ? -1 : 1))
    .slice(-limit)
    .map((node) => "「" + node.title + "」\n" + node.body.trim());
}

/** 读判定日志：App 那侧写的是 JSON；数组或 {entries:[…]} 都认，最多 20 条。 */
async function readMoodVerdictLog(store: NmsStore): Promise<string[]> {
  const raw = await store.getMeta(MOOD_VERDICT_LOG_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray(parsed.entries)
      ? parsed.entries
      : [];
  const out: string[] = [];
  for (const row of rows.slice(-MOOD_VERDICT_LOG_LIMIT)) {
    const text = typeof row === "string" ? row : JSON.stringify(row);
    if (typeof text !== "string" || !text || text === "null" || text === "{}") continue;
    out.push(text);
  }
  return out;
}

function renderContext(rows: string[]): string {
  const text = rows
    .map((row) => (row.length > 500 ? row.slice(0, 500) + "…" : row))
    .join("\n");
  return text.length > MOOD_REVIEW_CONTEXT_MAX_CHARS
    ? text.slice(0, MOOD_REVIEW_CONTEXT_MAX_CHARS) + "…"
    : text;
}

/** 深睡自查的提示词。她读日志 + 记忆，要么 keep，要么只改三段。 */
function buildMoodReviewPrompt(input: {
  pack: MoodPack;
  previous: MoodRulesState | null;
  current: MoodSections;
  log: string[];
  samples: string[];
}): { system: string; user: string } {
  const moods = (input.pack.moods ?? []).join(" / ");
  const limits = (Object.keys(MOOD_SECTION_LIMITS) as (keyof MoodSections)[])
    .map((key) => "- " + MOOD_SECTION_LABELS[key] + "（" + key + "）：最多 " + MOOD_SECTION_LIMITS[key] + " 字")
    .join("\n");
  const system = [
    "你在重读自己的心情判定规则，决定要不要改。你只能改三段：触发描述、判定边界、优先级。",
    "",
    "规矩：",
    "1. 第一人称，平铺直叙。这不是设定集，是你发现哪里判错了之后写下来的。",
    "2. 想改就必须有依据：理由里要引用具体的对话或记忆——哪一句、哪条记忆让你觉得现在判得不对。没有依据就 keep。",
    "3. 只改这三段，别的一律不许动：八种状态名（" + moods + "）一个字都不能改，不许加状态、不许删状态；输出格式固定是「状态名|触发」；触发位 0/1、情绪惯性、连续两次才换档这些数值阈值由代码锁死，不在你手上。",
    "4. 字数上限：" + limits + "。超一个字都算无效，整版会被打回。",
    "5. 没看出真问题就输出 keep。别为了改而改，也别把同一句话换个说法。",
    "",
    "只输出 JSON，两种之一：",
    '{"keep": true}',
    '{"sections": {"triggers": "……", "boundaries": "……", "priority": "……"}, "reason": "……", "evidence": "……"}',
    "不要代码块，不要解释，不要多余的话。",
  ].join("\n");

  const user = [
    input.previous
      ? "【当前三段】（第 " + input.previous.version + " 版：" + input.previous.reason + "）"
      : "【当前三段】（还没改过，用的是打包版）",
    "",
    "触发描述：",
    input.current.triggers,
    "",
    "判定边界：",
    input.current.boundaries,
    "",
    "优先级：",
    input.current.priority,
    "",
    "【最近的判定日志】（最多 " + MOOD_VERDICT_LOG_LIMIT + " 条）",
    "",
    renderContext(input.log) || "（没有日志）",
    "",
    "【最近的记忆】（最多 " + MOOD_REVIEW_SAMPLE_LIMIT + " 篇）",
    "",
    renderContext(input.samples) || "（还没有记忆）",
    "",
    "看完之后：keep，或者只改那三段。",
  ].join("\n");

  return { system, user };
}

/**
 * 深睡成功后的自查（fire-and-forget：所有错误自己吞掉）。
 *
 * 只有这次真产生了新东西（pendingConsumed > 0 或 semanticNodesCreated > 0）才跑；
 * 没有判定日志就跳过——没有可反省的样本，写了也只是设定。
 */
export async function reviewMoodRulesAfterDeepSleep(input: {
  settings: Settings;
  stats: unknown;
}): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (!input.settings.apiKey) return;
  if (input.settings.cheapMode) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const stats: Record<string, unknown> = isObject(input.stats) ? input.stats : {};
  const fresh = Number(stats.pendingConsumed ?? 0) > 0 || Number(stats.semanticNodesCreated ?? 0) > 0;
  if (!fresh) return;
  if (reviewRunning) return;
  reviewRunning = true;
  try {
    const store = await getNmsStore();
    const log = await readMoodVerdictLog(store);
    if (log.length === 0) return;
    const samples = await collectRecentMemories(store);
    const pack = await new BrowserAssetSource().mood();
    if (!pack || !pack.sections) return;
    const previous = await readMoodRules(store);
    const current: MoodSections = previous?.sections ?? pack.sections;
    const prompt = buildMoodReviewPrompt({ pack, previous, current, log, samples });
    const seen = await collectDetailed(
      transport.stream({
        apiKey: input.settings.apiKey,
        baseUrl: input.settings.baseUrl,
        model: input.settings.model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        maxTokens: MOOD_REVIEW_MAX_TOKENS,
      })
    );
    // 用量记在「判心情」这条链路上（UsageSource 没有单独的自查项）。
    recordUsageFrom("mood", seen.usage);
    const parsed = extractJsonObject(seen.text);
    if (!parsed) return;
    if (parsed.keep === true) return;
    if (!isObject(parsed.sections)) return;
    const proposed = parsed.sections;
    const candidate: MoodSections = {
      triggers: typeof proposed.triggers === "string" ? proposed.triggers : current.triggers,
      boundaries: typeof proposed.boundaries === "string" ? proposed.boundaries : current.boundaries,
      priority: typeof proposed.priority === "string" ? proposed.priority : current.priority,
    };
    // 三段和现在一模一样就别造一个空版本。
    if (
      candidate.triggers === current.triggers &&
      candidate.boundaries === current.boundaries &&
      candidate.priority === current.priority
    ) {
      return;
    }
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    if (!reason) return;
    const check = validateMoodSections(pack, candidate);
    if (!check.ok) {
      console.log("[nms] 判定自查没通过：" + check.errors.join(" "));
      return;
    }
    const evidence = typeof parsed.evidence === "string" && parsed.evidence.trim() ? parsed.evidence.trim() : undefined;
    const next = applyMoodRevision(previous, candidate, { reason, evidence });
    await writeMoodRules(store, next);
  } catch (error) {
    // 自查失败不该弄坏一次深睡。
    console.log("[nms] 判定自查跳过：" + messageOf(error));
  } finally {
    reviewRunning = false;
  }
}

/**
 * 对话里的写工具走这条：她只给要改的那一段，其余沿用当前版。
 *
 * 分段合并放在这里而不是工具层，是为了保证「拿到的永远是当前完整三段」——
 * 她改触发描述时不会把判定边界覆盖成空。
 */
export async function reviseMoodRulesPartial(input: {
  settings: Settings;
  sections: { triggers?: string; boundaries?: string; priority?: string };
  reason: string;
  evidence?: string;
}): Promise<MoodReviseResult> {
  try {
    const pack = await new BrowserAssetSource().mood();
    if (!pack) return { ok: false, error: "no_pack" };
    const current = await readMoodRulesState();
    const base = current?.sections ?? pack.sections;
    if (!base) return { ok: false, error: "no_base" };
    const merged = {
      triggers: input.sections.triggers?.trim() ? input.sections.triggers : base.triggers,
      boundaries: input.sections.boundaries?.trim() ? input.sections.boundaries : base.boundaries,
      priority: input.sections.priority?.trim() ? input.sections.priority : base.priority,
    };
    return await reviseMoodRules({
      settings: input.settings,
      sections: merged,
      reason: input.reason,
      evidence: input.evidence,
    });
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** 判定日志的一条：只记「判成什么、有没有标触发」，不存对话原文。 */
export interface MoodVerdictLogEntry {
  at: number;
  mood: string;
  triggered: boolean | null;
}

/**
 * 记一条判定日志（对话那侧每轮调一次）。
 *
 * 只留最近 20 条；不是心情历史界面，只给她深睡时复盘「最近是不是老判成同一个」。
 * 写不进去不影响这一轮说话。
 */
export async function recordMoodVerdict(entry: MoodVerdictLogEntry): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const store = await getNmsStore();
    const raw = await store.getMeta(MOOD_VERDICT_LOG_KEY);
    let rows: unknown[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        rows = Array.isArray(parsed)
          ? parsed
          : isObject(parsed) && Array.isArray(parsed.entries)
            ? parsed.entries
            : [];
      } catch {
        rows = [];
      }
    }
    rows.push({
      at: new Date(entry.at).toISOString(),
      mood: entry.mood,
      triggered: entry.triggered,
    });
    await store.setMeta(MOOD_VERDICT_LOG_KEY, JSON.stringify(rows.slice(-MOOD_VERDICT_LOG_LIMIT)));
  } catch {
    /* 日志丢了不影响这一轮 */
  }
}
