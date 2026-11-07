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
import { shouldRecoverInitiative } from "@herta/core";
import { collectDetailed } from "../stream.ts";
import { recordUsageFrom } from "../usage-ledger.ts";
import type { Settings } from "../settings.ts";
import { pickTransport } from "../transport.ts";
import { getNmsStore } from "./controller.ts";

const transport = pickTransport();
let voiceRunning = false;

/** 主动程度最近一次真的动过（毫秒时间戳字符串）；回温只看它，不看语气整体更新时间。 */
const INITIATIVE_MOVED_KEY = "initiative_moved_at";

async function touchInitiativeMoved(store: NmsStore, now: number): Promise<void> {
  try {
    await store.setMeta(INITIATIVE_MOVED_KEY, String(now));
  } catch {
    /* 记不上只影响下次回温的起算，不该让这一版参数失败 */
  }
}

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
      userName: settings.userName,
    });
    const seen = await collectDetailed(
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
    // B14：自动语气是一次后台重请求（带样本与画像），单独记
    recordUsageFrom("voice", seen.usage);
    const raw = seen.text;
    const parsed = parseVoiceReply(raw, schema, params);
    if (!parsed) return { ok: false, error: "bad_reply", state: previous };
    const next = applyVoiceGeneration(previous, {
      profile: parsed.profile,
      params: parsed.params,
      reason: options.reason ?? "auto",
      now: options.now,
    });
    await writeVoiceState(store, next);
    // 主动程度换了档就记一笔：回温的「七天没动」从这儿起算。
    const beforeInitiative = Number(previous?.params.initiative ?? params.initiative);
    if (Number(next.params.initiative) !== beforeInitiative) {
      await touchInitiativeMoved(store, options.now ?? Date.now());
    }
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
  if (Number(next.params.initiative) !== Number(previous.params.initiative)) {
    await touchInitiativeMoved(store, options.now ?? Date.now());
  }
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

/**
 * 深睡之后：主动程度低得反常、又七天没动过，就把它往回抬 5 分（封顶 20）。
 *
 * 这是兜底，不是自动调参：只处理「她把自己设成静音之后就再没人叫醒她」这一种。
 * 每次抬都算一次「动过」，所以最多七天一次。
 */
export async function recoverInitiative(options: {
  settings: Settings;
  store?: NmsStore;
  now?: number;
}): Promise<VoiceState | null> {
  if (!Capacitor.isNativePlatform() || options.settings.cheapMode) return null;
  try {
    const store = options.store ?? (await getNmsStore());
    const previous = await readVoiceState(store);
    if (!previous) return null;
    const now = options.now ?? Date.now();
    const raw = await store.getMeta(INITIATIVE_MOVED_KEY).catch(() => null);
    const movedAt = raw === null ? NaN : Number(raw);
    const nextInitiative = shouldRecoverInitiative({
      initiative: Number(previous.params.initiative ?? 40),
      lastMovedAt: Number.isFinite(movedAt) && movedAt > 0 ? movedAt : null,
      now,
    });
    if (nextInitiative === null) return null;
    const schema = normalizeVoiceSchema();
    const params = normalizeVoiceParams(schema, { ...previous.params, initiative: nextInitiative });
    const state = applyVoiceParams(previous, params, { reason: "recover", now });
    await writeVoiceState(store, state);
    await touchInitiativeMoved(store, now);
    return state;
  } catch {
    return null;
  }
}
