import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import type { DreamState, MemoryRecord } from "@herta/core";
import type { Session } from "@herta/protocol";
import type { MoodRulesState, NmsSnapshot, VoiceParams, VoiceState } from "@herta/nms";
import { IdbMemoryStore } from "../memory-idb.ts";
import { archiveNmsNode, initializeNms, readNmsSnapshot, runManualLightSleep } from "../nms/controller.ts";
import { runMobileDeepSleep } from "../nms/deep-sleep-runner.ts";
import { readVoice, rollbackVoice, runVoiceGenerate, saveVoiceParams } from "../nms/voice-runner.ts";
import { readMoodRulesState, rollbackMoodRulesTo } from "../nms/mood-runner.ts";
import { snapshotToMemoryRecords } from "../nms/adapter.ts";
import type { Settings } from "../settings.ts";

/**
 * 记忆钩子（NMS 过渡版）。
 *
 * 旧 IndexedDB 只读：启动时用 initializeNms 一次性迁移到 NMS SQLite，
 * 之后 memories 是 NMS 节点的只读适配视图（旧 Drawer/Viewer 暂时还能看）。
 * 做梦/整理/遗忘不再写旧库：dreamNow 先跑浅睡，深睡引擎接入后替换。
 * 冻结语气：dreamState 仍从旧库读，只供 persona 注入。
 */
const legacyStore = new IdbMemoryStore();

/** 判定自修改的「看过了」时间点（本地）；设置页入口的小红点靠它算。 */
const MOOD_RULES_SEEN_KEY = "herta.moodRules.seenAt";

function readMoodRulesSeenAt(): number {
  try {
    const raw = Number(localStorage.getItem(MOOD_RULES_SEEN_KEY));
    return Number.isFinite(raw) ? raw : 0;
  } catch {
    return 0;
  }
}

export function useMemory(settings: Settings, opts: { onError(message: string): void }) {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [dreamState, setDreamState] = useState<DreamState | null>(null);
  const [nmsSnapshot, setNmsSnapshot] = useState<NmsSnapshot | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState | null>(null);
  const [moodRules, setMoodRules] = useState<MoodRulesState | null>(null);
  const [moodRulesSeenAt, setMoodRulesSeenAt] = useState<number>(() => readMoodRulesSeenAt());
  const [dreaming, setDreaming] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [distillNote, setDistillNote] = useState<string | null>(null);
  const [maintaining, setMaintaining] = useState<string | null>(null);
  const initializedRef = useRef(false);
  const dreamingRef = useRef(false);
  const distillingRef = useRef(false);
  const viewRef = useRef<ReturnType<typeof snapshotToMemoryRecords> | null>(null);

  const setError = (message: string) => opts.onError(message);

  const refresh = useCallback(async () => {
    const state = await legacyStore.state();
    setDreamState(state);
    // 不清理手机里已有的任何记忆：新包只是不再预装，老用户的旧库原样读取/迁移。
    if (!Capacitor.isNativePlatform()) {
      // Web 开发没有原生 SQLite：保留旧库只读视图，不迁移、不报错。
      setMoodRules(null);
      setMemories(await legacyStore.list());
      return;
    }
    try {
      // 每次都走一次增量迁移：备份恢复后旧库会多出新记录，只导入没见过的。
      await initializeNms({ legacy: legacyStore, dreamState: state });
      initializedRef.current = true;
      const snapshot = await readNmsSnapshot();
      const view = snapshotToMemoryRecords(snapshot);
      viewRef.current = view;
      setNmsSnapshot(snapshot);
      setMemories(view.records);
      setVoiceState(await readVoice());
      setMoodRules(await readMoodRulesState());
    } catch (error) {
      setError("NMS 记忆初始化失败：" + (error instanceof Error ? error.message : String(error)));
      // 迁移失败：保留旧库只读视图，不回写、不假装成功。
      setMemories(await legacyStore.list());
    }
  }, []);

  const removeMemory = useCallback(async (name: string) => {
    const id = viewRef.current?.byName.get(name);
    if (id === undefined) {
      setError("这条记忆不在 NMS 库里（旧视图只读）");
      return;
    }
    try {
      await archiveNmsNode(id);
      await refresh();
    } catch (error) {
      setError("归档失败：" + (error instanceof Error ? error.message : String(error)));
    }
  }, [refresh]);

  /** 旧做梦流程留下的接口：NMS 版语气改成手动/深睡后自动重写，这里仍返回 null 不写旧库。 */
  const reviseVoiceImpl = useCallback(async (_records: MemoryRecord[], _previous: string | null) => null, []);

  const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

  /** 手动重写一次语气（面板上的「重写」）。 */
  const rewriteVoice = useCallback(async () => {
    const result = await runVoiceGenerate({ settings, reason: "manual" });
    if (result.ok) {
      setVoiceState(result.state);
      setDistillNote("语气重写好了：v" + String(result.state?.version ?? 1));
      return true;
    }
    const why = result.error === "cheap_mode" ? "省 token 模式下不跑" : result.error;
    setError("重写语气没成：" + why);
    return false;
  }, [settings]);

  /** 手动改性子参数：连点几下合成一版（600ms 防抖），旧版进历史，能回滚。 */
  const voiceSaveTimer = useRef<number | null>(null);
  const changeVoiceParams = useCallback((params: VoiceParams) => {
    if (voiceSaveTimer.current !== null) window.clearTimeout(voiceSaveTimer.current);
    voiceSaveTimer.current = window.setTimeout(() => {
      voiceSaveTimer.current = null;
      void saveVoiceParams(params, { reason: "manual" })
        .then((next) => {
          if (next) setVoiceState(next);
        })
        .catch((error) => setError("改语气参数失败：" + reasonOf(error)));
    }, 600);
  }, []);

  useEffect(() => () => {
    if (voiceSaveTimer.current !== null) window.clearTimeout(voiceSaveTimer.current);
  }, []);

  /** 整块回滚到某个历史版本。 */
  const revertVoice = useCallback(async (version: number) => {
    try {
      const next = await rollbackVoice(version);
      if (next) {
        setVoiceState(next);
        setDistillNote("语气回滚到 v" + version);
      }
    } catch (error) {
      setError("回滚语气失败：" + reasonOf(error));
    }
  }, []);

  /** 回滚她改过的判定（设置页每版一行「回到这版」）。 */
  const rollbackMoodRules = useCallback(async (version: number) => {
    try {
      const next = await rollbackMoodRulesTo(version);
      if (!next) {
        setError("回滚判定失败：找不到 v" + version);
        return;
      }
      setMoodRules(next);
      setDistillNote("判定回滚到 v" + version);
    } catch (error) {
      setError("回滚判定失败：" + reasonOf(error));
    }
  }, []);

  /** 看过设置页的判定块，红点灭掉。 */
  const clearMoodRulesUnseen = useCallback(() => {
    const now = Date.now();
    setMoodRulesSeenAt(now);
    try {
      localStorage.setItem(MOOD_RULES_SEEN_KEY, String(now));
    } catch {
      /* 存不下就只在这一次会话里灭掉 */
    }
  }, []);

  /** 她改过判定、我还没看过 → 入口标题旁的小红点。 */
  const moodRulesUnseen =
    moodRules !== null && new Date(moodRules.updatedAt).getTime() > moodRulesSeenAt;

  const dreamNow = useCallback(async (_target: Session, _force = false) => {
    if (dreamingRef.current) return;
    dreamingRef.current = true;
    setDreaming(true);
    setMaintaining("NMS 深睡：处理待加工轮次 / 语义化 / 建边…");
    try {
      if (settings.nmsDeepSleepEnabled !== false && settings.apiKey) {
        const deep = await runMobileDeepSleep({ settings });
        if (deep.ok) {
          const stats = deep.stats;
          setDistillNote(
            "深睡完成：" +
              "调用 " + String(stats?.callsUsed ?? 0) + " 次，" +
              "pending 入库 " + String(stats?.pendingInserted ?? 0) + " 条，" +
              "语义化 " + String(stats?.semanticized ?? 0) + " 条"
          );
        } else if (deep.error !== "no_key" && deep.error !== "disabled") {
          setDistillNote("深睡未完成（" + deep.error + "），先跑浅睡");
        }
      }
      const light = await runManualLightSleep();
      if (!light.ok) setError("浅睡失败：" + light.error);
      await refresh();
    } finally {
      dreamingRef.current = false;
      setDreaming(false);
      setMaintaining(null);
    }
  }, [refresh, settings]);

  const distillNow = useCallback(async (_target: Session) => {
    if (distillingRef.current) return;
    distillingRef.current = true;
    setDistilling(true);
    setDistillNote("NMS 深睡引擎接入中：旧的「消化」不再写旧库");
    try {
      const result = await runManualLightSleep();
      if (!result.ok) setDistillNote("浅睡失败：" + result.error);
      await refresh();
    } finally {
      distillingRef.current = false;
      setDistilling(false);
    }
  }, [refresh]);

  const consolidateNow = useCallback(async (_force = false) => {
    setMaintaining("浅睡：去重 / 衰减 / 剪边…");
    try {
      const result = await runManualLightSleep();
      if (!result.ok) setError("浅睡失败：" + result.error);
      await refresh();
      return result.ok;
    } finally {
      setMaintaining(null);
    }
  }, [refresh]);

  const maintainMemories = useCallback(async () => {
    if (maintaining !== null) return;
    await consolidateNow(true);
  }, [consolidateNow, maintaining]);

  return {
    memories,
    dreamState,
    nmsSnapshot,
    voiceState,
    moodRules,
    moodRulesUnseen,
    rollbackMoodRules,
    clearMoodRulesUnseen,
    rewriteVoice,
    changeVoiceParams,
    revertVoice,
    dreaming,
    distilling,
    distillNote,
    maintaining,
    refresh,
    removeMemory,
    consolidateNow,
    dreamNow,
    distillNow,
    maintainMemories,
    reviseVoiceImpl,
  };
}
