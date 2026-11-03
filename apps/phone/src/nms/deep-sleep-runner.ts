/**
 * 手机端深睡执行器：把 transport.stream 适配成 NMS 的 caller，跑六阶段。
 *
 * 只在有 API key + 网络 + 前台/保活时由 App 计时调用；失败只记统计，不阻塞 UI。
 */
import { Capacitor } from "@capacitor/core";
import { runDeepSleep, DEEP_SLEEP_DEFAULTS } from "@herta/nms";
import type { DeepSleepStats, NmsStore } from "@herta/nms";
import { collect } from "../stream.ts";
import type { Settings } from "../settings.ts";
import { getNmsStore } from "./controller.ts";
import { maybeAutoGenerateVoice } from "./voice-runner.ts";

export interface DeepSleepRunResult {
  ok: boolean;
  error: string;
  stats: DeepSleepStats | null;
}

let deepRunning = false;

/** 深睡需要的调用上限：手机端默认 8，设置可覆盖，最高 40。 */
export function deepSleepCapOf(settings: Settings): number {
  const value = Number.isFinite(settings.nmsNightCap) ? Math.floor(settings.nmsNightCap) : 8;
  return Math.max(0, Math.min(40, value));
}

export async function runMobileDeepSleep(options: {
  settings: Settings;
  now?: number;
  cap?: number;
}): Promise<DeepSleepRunResult> {
  if (!Capacitor.isNativePlatform()) return { ok: false, error: "web_platform", stats: null };
  if (!options.settings.apiKey) return { ok: false, error: "no_key", stats: null };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, error: "offline", stats: null };
  const cap = options.cap ?? deepSleepCapOf(options.settings);
  if (cap <= 0) return { ok: false, error: "disabled", stats: null };

  const store: NmsStore = await getNmsStore();
  const now = options.now ?? Date.now();
  const dateKey = new Date(now).toISOString().slice(0, 10);
  const usedKey = "nms_deep_calls_" + dateKey;
  const usedRaw = Number(await store.getMeta(usedKey));
  const used = Number.isFinite(usedRaw) ? usedRaw : 0;
  const remaining = Math.max(0, cap - used);
  if (remaining <= 0) return { ok: false, error: "night_cap_reached", stats: null };
  if (deepRunning) return { ok: false, error: "busy", stats: null };
  deepRunning = true;
  const settings = options.settings;
  const caller = async (args: { stage: string; system: string; user: string; maxTokens: number; timeoutMs: number }): Promise<string | null> => {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), Math.max(1000, args.timeoutMs));
    try {
      const stream = transportStream(settings, args, controller?.signal);
      return await collect(stream);
    } catch (error) {
      console.log("[nms] 深睡调用失败（" + args.stage + "）：" + String(error instanceof Error ? error.message : error));
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  let stats: DeepSleepStats | null = null;
  try {
    stats = await runDeepSleep({
      store,
      caller,
      nightCallCap: Math.min(remaining, DEEP_SLEEP_DEFAULTS.nightCallCapMax),
      now,
    });
    try {
      await store.setMeta(usedKey, String(used + Math.max(0, stats.callsUsed ?? 0)));
    } catch {
      /* 记账失败不阻塞 */
    }
    // 深睡把新情景写下来之后，顺手让她重读一遍、重写自己的语气（不阻塞返回）。
    if (stats.ok) {
      void maybeAutoGenerateVoice({ settings, store, stats, now })
        .then((voice) => {
          if (!voice.ok && voice.error !== "no_new_memory" && voice.error !== "cheap_mode") {
            console.log("[nms] 自动语气没写成：" + voice.error);
          }
        })
        .catch(() => undefined);
    }
    return { ok: stats.ok === true, error: stats.error ?? "", stats };
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error), stats };
  } finally {
    deepRunning = false;
  }
}

function transportStream(settings: Settings, args: { system: string; user: string; maxTokens: number }, signal?: AbortSignal) {
  // 动态 import 避免把 transport 的副作用带进包的单测；实际调用在原生环境。
  return transportSingleton.stream({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    messages: args.system
      ? [
          { role: "system", content: args.system },
          { role: "user", content: args.user },
        ]
      : [{ role: "user", content: args.user }],
    maxTokens: args.maxTokens,
    ...(signal ? { signal } : {}),
  });
}

// transport 的构造在模块加载时就 pick，和 useChatTurn 保持一致。
import { pickTransport } from "../transport.ts";
const transportSingleton = pickTransport();
