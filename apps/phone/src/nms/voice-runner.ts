/**
 * 自动语气执行器：读最近记忆 → 一次 LLM → 写进 NMS meta 的 voice_state。
 *
 * 只在原生环境跑（SQLite）；浏览器开发态没有 NMS 库，直接返回 web_platform。
 * 省 token 模式不跑；深睡之后只有真产生了新记忆才自动重写。
 */
import { Capacitor } from "@capacitor/core";
import type { DeepSleepStats, NmsStore, VoiceParams, VoiceState } from "@herta/nms";
import {
  VOICE_SAMPLE_LIMIT,
  applyVoiceGeneration,
  applyVoiceParams,
  buildVoicePrompt,
  defaultVoiceParams,
  normalizeVoiceParams,
  normalizeVoiceSchema,
  parseVoiceReply,
  readVoiceState,
  rollbackVoiceState,
  writeVoiceState,
} from "@herta/nms";
import { collect } from "../stream.ts";
import type { Settings } from "../settings.ts";
import { pickTransport } from "../transport.ts";
import { getNmsStore } from "./controller.ts";

const transport = pickTransport();
let voiceRunning = false;

export interface VoiceRunResult {
  ok: boolean;
  error: string;
  state: VoiceState | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readVoice(store?: NmsStore): Promise<VoiceState | null> {
  try {
    const db = store ?? (await getNmsStore());
    return await readVoiceState(db);
  } catch {
    return null;
  }
}

/** 最近几条有正文的 ep/sem，按时间从旧到新。 */
export async function collectVoiceSamples(store: NmsStore, limit = VOICE_SAMPLE_LIMIT): Promise<string[]> {
  const nodes = await store.listNodes({});
  return nodes
    .filter((node) => (node.tier === "ep" || node.tier === "sem") && node.body.trim().length > 0)
    .sort((a, b) => (a.createdAt === b.createdAt ? a.id - b.id : a.createdAt < b.createdAt ? -1 : 1))
    .slice(-limit)
    .map((node) => "「" + node.title + "」\n" + node.body.trim());
}

/** 重写一次语气（手动按钮与自动共用）。 */
export async function runVoiceGenerate(options: {
  settings: Settings;
  store?: NmsStore;
  reason?: string;
  now?: number;
}): Promise<VoiceRunResult> {
  if (!Capacitor.isNativePlatform()) return { ok: false, error: "web_platform", state: null };
  if (!options.settings.apiKey) return { ok: false, error: "no_key", state: null };
  if (options.settings.cheapMode) return { ok: false, error: "cheap_mode", state: null };
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ok: false, error: "offline", state: null };
  }
  if (voiceRunning) return { ok: false, error: "busy", state: null };
  voiceRunning = true;
  const settings = options.settings;
  try {
    const store = options.store ?? (await getNmsStore());
    const schema = normalizeVoiceSchema();
    const previous = await readVoiceState(store);
    const params = previous ? normalizeVoiceParams(schema, previous.params) : defaultVoiceParams(schema);
    const samples = await collectVoiceSamples(store);
    // 一篇记忆都没有就别空转：她还没有可观察的样本，写出来的只会是设定
    if (samples.length === 0) return { ok: false, error: "no_samples", state: previous };
    const prompt = buildVoicePrompt({
      samples,
      previousProfile: previous?.profile ?? null,
      previousParams: params,
      schema,
    });
    const raw = await collect(
      transport.stream({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        maxTokens: 1200,
      })
    );
    const parsed = parseVoiceReply(raw, schema, params);
    if (!parsed) return { ok: false, error: "bad_reply", state: previous };
    const next = applyVoiceGeneration(previous, {
      profile: parsed.profile,
      params: parsed.params,
      reason: options.reason ?? "auto",
      now: options.now,
    });
    await writeVoiceState(store, next);
    return { ok: true, error: "", state: next };
  } catch (error) {
    return { ok: false, error: messageOf(error), state: null };
  } finally {
    voiceRunning = false;
  }
}

/** 手动改性子参数（没有笔记时不建状态，免得出现没正文的参数）。 */
export async function saveVoiceParams(
  params: VoiceParams,
  options: { reason?: string; now?: number } = {}
): Promise<VoiceState | null> {
  const store = await getNmsStore();
  const previous = await readVoiceState(store);
  if (!previous) return null;
  const schema = normalizeVoiceSchema();
  const next = applyVoiceParams(previous, normalizeVoiceParams(schema, params), {
    reason: options.reason ?? "manual",
    now: options.now,
  });
  await writeVoiceState(store, next);
  return next;
}

/** 整块回滚到某个历史版本。 */
export async function rollbackVoice(version: number, now = Date.now()): Promise<VoiceState | null> {
  const store = await getNmsStore();
  const previous = await readVoiceState(store);
  if (!previous) return null;
  const next = rollbackVoiceState(previous, version, now);
  if (!next) return null;
  await writeVoiceState(store, next);
  return next;
}

/** 深睡之后：这次真产生了新记忆才自动重写一次。 */
export async function maybeAutoGenerateVoice(options: {
  settings: Settings;
  store?: NmsStore;
  stats: DeepSleepStats;
  now?: number;
}): Promise<VoiceRunResult> {
  const fresh = (options.stats.pendingConsumed ?? 0) > 0 || (options.stats.semanticNodesCreated ?? 0) > 0;
  if (!fresh) return { ok: false, error: "no_new_memory", state: null };
  return runVoiceGenerate({ settings: options.settings, store: options.store, reason: "auto", now: options.now });
}
