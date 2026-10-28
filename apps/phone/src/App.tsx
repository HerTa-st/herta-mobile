import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Block, HertaBlock, ImportBundle, Session, UserBlock } from "@herta/protocol";
import {
  appendBlocks,
  createSession,
  effectiveWeight,
  humanizeError,
  memoryTitle,
  parseImportBundle,
  parseSharedConversation,
  planImport,
  presenceAt,
  retractLastTurn,
  searchMemories,
  searchSessions,
  shareIdFromInput,
  shouldConsolidate,
  stripStageDirections,
  shouldForget,
  SHARE_API,
  timePhrase,
  type MemoryRecord,
} from "@herta/core";
import { BrowserAssetSource } from "./assets-browser.ts";
import { Drawer } from "./components/Drawer.tsx";
import { GraphView } from "./components/GraphView.tsx";
import { MemoryViewer } from "./components/MemoryViewer.tsx";
import { SettingsSheet } from "./components/SettingsSheet.tsx";
import { CapabilitiesSheet } from "./components/CapabilitiesSheet.tsx";
import { Onboarding } from "./components/Onboarding.tsx";
import { ToolLogSheet } from "./components/ToolLogSheet.tsx";
import { StickerTray } from "./components/StickerTray.tsx";
import { longPressProps } from "./components/long-press.ts";
import { Shot, ShotViewer, isTallImage } from "./components/Shot.tsx";
import { Splash } from "./components/Splash.tsx";
import { UsageChip } from "./components/UsageChip.tsx";
import { useChatTurn } from "./hooks/useChatTurn.ts";
import { useProactive } from "./hooks/useProactive.ts";
import { seedPureIfNeeded } from "./pure.ts";
import { captionImage, compressImage, prepareImage } from "./vision.ts";
import { tagSticker } from "./sticker-tag.ts";
import { dueReminders, markReminderSpoken } from "./capabilities.ts";
import { useMemory } from "./hooks/useMemory.ts";
import { MemoryGraph } from "./MemoryGraph.tsx";
import { collect } from "./stream.ts";
import { buildTools } from "./devtools.ts";
import { IdbMemoryStore } from "./memory-idb.ts";
import {
  deleteSession,
  deleteSticker,
  listSessions,
  listStickers,
  loadSession,
  putSession,
  putSticker,
  type SessionMeta,
  type StickerRecord,
} from "./storage.ts";
import { budgetOf, loadSettings, saveSettings, type Settings } from "./settings.ts";
import { pickTransport } from "./transport.ts";
import { loadPromptCode } from "./prompts.ts";
import { synthesize } from "./tts.ts";
import { playVoice, stopVoice } from "./voice.ts";

const assets = new BrowserAssetSource();
const transport = pickTransport();
const memoryStore = new IdbMemoryStore();

/** 模型名里带这些的，当它自己能看图（deepseek-flash / 各家 VL）。 */
const VISION_MODEL = /flash|vision|vl|omni/i;

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  /** 开屏动画：播完（或失败兜底）之后卸掉 */
  const [splashGone, setSplashGone] = useState(false);
  // 稳定的回调：启动页退场那 450ms 里如果 App 重渲染，内联箭头会让计时器反复重置
  const hideSplash = useCallback(() => setSplashGone(true), []);
  const [session, setSession] = useState<Session | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 报错统一走这里：接口吐回来的 JSON 先翻成人话再上屏。 */
  const reportError = useCallback((message: string | null) => {
    setError(message ? humanizeError(message) : null);
  }, []);
  const {
    memories,
    dreamState,
    dreaming,
    distilling,
    distillNote,
    maintaining,
    refresh: refreshMemories,
    removeMemory,
    consolidateNow,
    dreamNow,
    distillNow,
    maintainMemories,
  } = useMemory(settings, { onError: (m) => reportError(m) });
  const [showSettings, setShowSettings] = useState(false);
  const [showCaps, setShowCaps] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showToolLog, setShowToolLog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importNote, setImportNote] = useState<string | null>(null);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [pendingJump, setPendingJump] = useState<{ sessionId: string; index: number } | null>(null);
  /** 待发的图：长图会被切成几片（pieces），气泡只拿第一片当缩略图。 */
  const [pendingImage, setPendingImage] = useState<{
    mediaType: string;
    pieces: string[];
    name: string;
    caption: string;
  } | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  /** 点开看整张图（长图缩略裁过，原图在这里）。 */
  const [viewingShot, setViewingShot] = useState<{ pieces: string[]; name?: string } | null>(null);
  /** 待发的图是不是长图：是就裁成竖卡片，不然预览也只剩一条线。 */
  const [previewTall, setPreviewTall] = useState(false);
  const [stickers, setStickers] = useState<StickerRecord[]>([]);
  /** 表情面板：从输入框抽起来的一层 */
  const [showTray, setShowTray] = useState(false);
  /** 一句话的回执（「存进表情箱了」）。她看不到控制台，这种小事也得说一声。 */
  const [toast, setToast] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [viewing, setViewing] = useState<MemoryRecord | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  const [shareInput, setShareInput] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const dreamingRef = useRef(false);
  /** 用户手动选给她读的文件：工具只能读这里，不能自己翻磁盘。 */
  const filesRef = useRef(new Map<string, string>());
  /** 她把你的表情收进库时要落库；存库函数定义在后面，用 ref 把这根线接上。 */
  const keepStickerRef = useRef<(record: StickerRecord) => void>(() => undefined);
  const feedRef = useRef<HTMLElement | null>(null);
  /** 用户是不是"贴着底部"。他往上一翻就松手，不再跟着新消息跑。 */
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => saveSettings(settings), [settings]);

  /**
   * 第一次打开：老用户（已经填过 Key）直接立标记跳过；
   * 新装的人看到那四步。标记只立一次，之后再也不会自己弹出来。
   */
  useEffect(() => {
    if (localStorage.getItem("herta.onboarded.v1") === "1") return;
    if (loadSettings().apiKey) {
      localStorage.setItem("herta.onboarded.v1", "1");
      return;
    }
    setShowOnboarding(true);
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    stickToBottom.current = true;
    setAtBottom(true);
  }, []);

  const onFeedScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    // 距离底部 80px 以内都算"贴底"——手指抖一下不该让它停止跟随
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottom.current = near;
    setAtBottom(near);
  }, []);

  const refreshList = useCallback(async () => {
    setSessions(await listSessions());
  }, []);

  /* 启动：取最近一条会话；一条都没有就开一条。 */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // 纯净版：第一次打开把库清空，只留内置的那条对话
        await seedPureIfNeeded();

        // 种子只在**真正第一次**启动时搬一次，用标记记住。
        // 否则用户把记忆全删光之后，下次启动会被原样复活——"我删了它又回来了"这种惊吓不能有。
        const seeded = localStorage.getItem("herta.seeded.v1") === "1";
        if (!seeded) {
          if ((await memoryStore.list()).length === 0) {
            const names = await assets.seedFiles();
            const at = new Date().toISOString();
            for (const name of names) {
              const body = await assets.readSeed(name);
              if (body && body.trim()) {
                await memoryStore.write({ name, body, createdAt: at });
              }
            }
          }
          localStorage.setItem("herta.seeded.v1", "1");
        }
        if (alive) await refreshMemories();
        if (alive) setStickers(await listStickers());

        const list = await listSessions();
        if (!alive) return;
        if (list.length > 0) {
          const s = await loadSession(list[0].id);
          if (alive && s) {
            setSession(s);
            setSessions(list);
            return;
          }
        }
        const fresh = createSession();
        await putSession(fresh);
        if (alive) {
          setSession(fresh);
          await refreshList();
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
      stopVoice();
    };
  }, [refreshList]);


  const newSession = useCallback(async () => {
    const fresh = createSession();
    await putSession(fresh);
    setSession(fresh);
    setDrawer(false);
    await refreshList();
  }, [refreshList]);

  const openSession = useCallback(async (id: string) => {
    const s = await loadSession(id);
    if (s) {
      setSession(s);
      setDrawer(false);
    }
  }, []);

  const removeSession = useCallback(
    async (id: string) => {
      await deleteSession(id);
      const rest = await listSessions();
      setSessions(rest);
      if (session?.id === id) {
        if (rest.length > 0) {
          const next = await loadSession(rest[0].id);
          setSession(next);
        } else {
          const fresh = createSession();
          await putSession(fresh);
          setSession(fresh);
          await refreshList();
        }
      }
    },
    [refreshList, session?.id]
  );

  const persist = useCallback(
    async (s: Session) => {
      await putSession(s);
      await refreshList();
    },
    [refreshList]
  );

  /** 她这一句要接进哪个会话（补齐提醒时用，避免闭包里拿到旧的）。 */
  const sessionRef = useRef<Session | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  /** 她正在说话的时候不往会话里插东西——那一轮结束时会用自己那份覆盖掉。 */
  const busyRef = useRef(false);
  /** 防止两分钟器同时补（一次连开两次 App 很常见）。 */
  const flushingRef = useRef(false);

  /**
   * 到点的提醒落进对话。
   *
   * 系统通知只是一条通知——它响的时候她并没有"说话"。所以这里要**在响的那一刻**就把
   * 那句话写进会话，而不是等你打开 App 才补：常驻服务让进程活着，JS 那一分钟一次的
   * 定时器就能做到"响的时候话就在那儿"。
   *
   * 进程被杀掉时才退化成"回来补"——那是兜底，不是主路径。
   * 补过的记 spokenAt，同一次到点只说一次。
   */
  const flushReminders = useCallback(async () => {
    if (flushingRef.current || busyRef.current) return;
    const current = sessionRef.current;
    if (!current) return;
    flushingRef.current = true;
    try {
      const due = await dueReminders();
      if (due.length === 0) return;
      let next = sessionRef.current ?? current;
      for (const { record, at: when } of due) {
        // 用「该响的那一刻」当块的时间，而不是「补上的那一刻」：
        // 补写只是延迟，她那句话仍然发生在八点整。
        next = appendBlocks(next, [
          { kind: "herta", surface: "speech", text: record.title + "\n" + record.text, at: when.toISOString() },
        ]);
      }
      setSession(next);
      await persist(next);
      for (const { record, at } of due) await markReminderSpoken(record.id, at);
    } catch {
      // 读不到就等下一次——补写失败不该让整个界面报错
    } finally {
      flushingRef.current = false;
    }
  }, [persist]);

  useEffect(() => {
    const run = () => void flushReminders();
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    // 主路径：每分钟看一眼到点没有（后台里会被节流到一分钟一次，正好够）
    const timer = window.setInterval(run, 60_000);
    const t = window.setTimeout(run, 1200);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
      window.clearTimeout(t);
    };
  }, [flushReminders, session?.id]);

  /** 一个回合的全过程都在这里：判心情、算行踪、带工具说话、复核、落库。 */
  const { send, stop, busy, mood, typing } = useChatTurn({
    settings,
    session,
    setSession,
    persist,
    memories,
    dreamState,
    files: filesRef.current,
    stickers,
    // 她把你发的表情收进库：走同一条存库路径（重复的会被挡掉）
    onKeepSticker: (record) => keepStickerRef.current(record),
    onError: reportError,
    onNeedKey: () => setShowSettings(true),
  });

  // 她说话的那几秒里不让提醒插进来（那一轮结束时会整体覆盖会话）
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // 她到点自己找你：常驻服务保活 + 每分钟看一眼 + 走一遍人格装配
  useProactive({
    settings,
    session,
    setSession,
    persist,
    memories,
    dreamState,
    mood,
    busy,
    onError: reportError,
  });

  /** 从表情面板发一张：文字是空的，这一轮的起点是那张表情块。 */
  const sendSticker = useCallback(
    (record: StickerRecord) => {
      setShowTray(false);
      void send("", undefined, record);
    },
    [send]
  );

  /** 真正落库：去重 → 只写新的。永远不覆盖已有会话。 */
  const applyBundle = useCallback(
    async (bundle: ImportBundle) => {
      const existing = new Set((await listSessions()).map((s) => s.id));
      const plan = planImport(bundle, existing);
      for (const s of plan.toWrite) await putSession(s);
      await refreshList();
      setImportNote(
        plan.toWrite.length > 0
          ? "导进来了 " + plan.toWrite.length + " 个对话" + (plan.skipped ? "，跳过 " + plan.skipped + " 个已存在的" : "")
          : "这份包里的 " + plan.total + " 个对话都已经在库里了"
      );
      if (plan.toWrite.length > 0) {
        setImportText("");
        // 导完直接跳到最新那个，省得她自己在列表里找
        const newest = [...plan.toWrite].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
        setSession(newest);
        setDrawer(false);
      }
    },
    [refreshList]
  );

  /* ------------------------------------------------------------ 自主做梦 */

  /**
   * 她自己做梦的时机：**你走了之后**，不是说完就做。
   *
   * 判据三条：
   *   1. 有一阵子没人说话（空闲阈值，见下）
   *   2. 这一段攒够了新对话（dreamNow 内部还有 6 块 / 10 分钟两道门）
   *   3. 她这会儿没在忙别的（不做梦、不消化、不整理）
   *
   * 阈值按她的行踪浮动：凌晨和深夜是她本来就没人的时段，两分钟就够；
   * 白天你在身边的时候给到六分钟——她不该在你打字的中途突然发呆。
   * 页面切到后台时不跑：手机上那点电不该花在她没人的时候。
   */
  const lastActivityRef = useRef(Date.now());

  useEffect(() => {
    if (draft || busy) lastActivityRef.current = Date.now();
  }, [draft, busy, session?.blocks.length]);

  useEffect(() => {
    if (!settings.autoDream) return;
    const tick = () => {
      if (!session || busy || dreaming || distilling || maintaining) return;
      if (!settings.autoDream) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const phase = presenceAt().phase;
      const quiet = phase === "凌晨" || phase === "深夜" || phase === "夜里";
      const idleMs = quiet ? 2 * 60 * 1000 : 6 * 60 * 1000;
      if (Date.now() - lastActivityRef.current < idleMs) return;
      // 剩下的门槛（材料够不够、距上次多久）交给 dreamNow 自己判
      void dreamNow(session, false);
    };
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, [busy, distilling, dreamNow, dreaming, maintaining, session, settings.autoDream]);

  /**
   * 切到后台满十分钟：做梦，然后把记忆整理一遍。
   *
   * 为什么是"十分钟"而不是立刻：立刻整理等于你刚切走她就干活，电和额度都花在没人的时候；
   * 而十分钟足够攒出一次像样的整理。
   *
   * 后台里能不能真跑，取决于系统给不给定时器。跑不动也不亏——回到前台时会补做一次
   * （见下面的 visibilitychange），补做的判据是"后台待够了十分钟"。
   */
  const backgroundAtRef = useRef<number | null>(null);
  const upkeepDoneRef = useRef(false);

  const runUpkeep = useCallback(async () => {
    if (session && !busy && !dreaming) await dreamNow(session, false);
    try {
      await consolidateNow(true);
    } catch (e) {
      setError("整理记忆失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }, [busy, consolidateNow, dreamNow, dreaming, session]);

  useEffect(() => {
    if (!settings.autoDream) return;

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (backgroundAtRef.current === null) backgroundAtRef.current = Date.now();
        upkeepDoneRef.current = false;
        return;
      }
      const since = backgroundAtRef.current;
      backgroundAtRef.current = null;
      if (since !== null && Date.now() - since >= 10 * 60 * 1000 && !upkeepDoneRef.current) {
        upkeepDoneRef.current = true;
        void runUpkeep();
      }
    };

    // 后台定时器可能被系统节流；能跑就跑，跑不动就等回到前台补
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") return;
      const since = backgroundAtRef.current;
      if (since === null || upkeepDoneRef.current) return;
      if (Date.now() - since < 10 * 60 * 1000) return;
      upkeepDoneRef.current = true;
      void runUpkeep();
    }, 60_000);

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
    };
  }, [runUpkeep, settings.autoDream]);

  /** 打开 App 放了半天没说话的，进来二十秒后让她做一次梦。 */
  useEffect(() => {
    if (!settings.autoDream) return;
    const t = setTimeout(() => {
      if (session && !busy && !dreaming) void dreamNow(session, false);
    }, 20_000);
    return () => clearTimeout(t);
    // 只在挂载时排一次：这是"刚打开"的那一次，不该因为换会话重排
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flashToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 1800);
  }, []);

  /**
   * 往表情库里加图：压到 512，配了视觉模型就顺手打一组标签。
   *
   * 标签是"互发表情"能不能成立的关键：没有它，她挑表情只能随机，
   * 那就跟把一堆图扔进抽奖箱没区别。打标失败不算失败——加图照常完成。
   */
  const addStickers = useCallback(
    async (files: File[], owner: "herta" | "mine" = "herta") => {
      const vision = settings.visionModel && settings.apiKey ? settings.visionModel : "";
      for (const file of files) {
        try {
          const { dataUrl, mediaType } = await compressImage(file, 512, 0.85);
          const tags = vision
            ? await tagSticker(transport, { apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: vision }, dataUrl)
            : [];
          await putSticker({
            id: crypto.randomUUID(),
            name: file.name.replace(/\.[^.]+$/, ""),
            tags,
            data: dataUrl,
            mediaType,
            createdAt: new Date().toISOString(),
            owner,
          });
        } catch (e) {
          setError("这张表情没加进去：" + (e instanceof Error ? e.message : String(e)));
        }
      }
      setStickers(await listStickers());
    },
    [settings.apiKey, settings.baseUrl, settings.visionModel]
  );

  const removeSticker = useCallback(async (id: string) => {
    await deleteSticker(id);
    setStickers(await listStickers());
  }, []);

  /**
   * 把一张图存进表情箱（同一张只存一次）。
   * 长按聊天里的图、或者她收下你的表情，都走这里。
   */
  const saveToBox = useCallback(
    async (data: string, name: string, mediaType: string, tags: string[], owner: "herta" | "mine") => {
      const all = await listStickers();
      const where = owner === "mine" ? "你的箱" : "她的库";
      if (all.some((s) => s.owner === owner && s.data === data)) {
        flashToast("这张已经在" + where + "里了");
        return;
      }
      await putSticker({
        id: crypto.randomUUID(),
        name,
        tags,
        data,
        mediaType,
        createdAt: new Date().toISOString(),
        owner,
      });
      setStickers(await listStickers());
      flashToast(owner === "mine" ? "存进表情箱了" : "她已经收下了");
    },
    [flashToast]
  );

  // 收表情要存库，存库的函数在下面（它要用 flashToast 与 setStickers）。
  // 用一个 ref 把回调接过去：回合层只认这个 ref，不等函数定义顺序。
  keepStickerRef.current = (record) =>
    void saveToBox(record.data, record.name, record.mediaType, record.tags, "herta");

  const runImport = useCallback(async () => {
    const parsed = parseImportBundle(importText);
    if (!parsed.ok) {
      setImportNote("没导进来：" + parsed.error);
      return;
    }
    await applyBundle(parsed.bundle);
  }, [applyBundle, importText]);

  /** 从分享链接导入：公开接口，不需要登录态，也不用把文件搬来搬去。 */
  const importFromLink = useCallback(async () => {
    const id = shareIdFromInput(shareInput);
    if (!id) {
      setImportNote("认不出链接。要形如 https://chat.deepseek.com/share/xxxxx");
      return;
    }
    setImportBusy(true);
    setImportNote("正在取这份分享…");
    try {
      const json = await transport.getText(SHARE_API + id);
      const parsed = parseSharedConversation(json, "从分享导入");
      if (!parsed.ok) {
        setImportNote("没导进来：" + parsed.error);
        return;
      }
      await applyBundle({
        format: "herta-import",
        version: 1,
        source: "deepseek-web",
        exportedAt: new Date().toISOString(),
        collector: { name: "deepseek-share", version: "1.0.0" },
        sessions: [parsed.session],
      });
    } catch (e) {
      setImportNote("没导进来：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setImportBusy(false);
    }
  }, [applyBundle, shareInput]);




  const retract = useCallback(async () => {
    if (!session || busy) return;
    const cut = retractLastTurn(session);
    setSession(cut);
    await persist(cut);
  }, [busy, persist, session]);

  /** 念一段：合成完直接播。合成失败就把原因说出来，不静默。 */
  const speakBlock = useCallback(
    async (text: string) => {
      try {
        // 动作标注不念：写给人看的（转了下椅子），念出来只是一句怪旁白
        const spoken = stripStageDirections(text);
        if (!spoken) return;
        const url = await synthesize(
          transport,
          {
            provider: settings.ttsProvider,
            apiKey: settings.ttsApiKey,
            baseUrl: settings.ttsBaseUrl,
            model: settings.ttsModel,
            voice: settings.ttsVoice,
            groupId: settings.ttsGroupId,
          },
          spoken
        );
        await playVoice(url);
      } catch (e) {
        setError("念不出来：" + (e instanceof Error ? e.message : String(e)));
      }
    },
    [settings.ttsApiKey, settings.ttsBaseUrl, settings.ttsGroupId, settings.ttsModel, settings.ttsProvider, settings.ttsVoice]
  );

  /** 发出去：文字 + 待发的图（图会作为附件存进会话，描述并进正文）。 */
  const dispatch = useCallback(() => {
    const img = pendingImage;
    const text = (draft.trim() + (img?.caption ? "\n\n" + img.caption : "")).trim();
    if (!text && !img) return;
    // 只发图时正文可以是空的：序列化层会补一行「（附了一张图）」，她不会当你在发空气。
    setDraft("");
    setPendingImage(null);
    setPreviewTall(false);
    setShowTray(false);
    // 长图切出来的每一片都是独立附件：模型逐片看，气泡把它们接成一摞
    void send(
      text,
      img ? img.pieces.map((data) => ({ mediaType: img.mediaType, data, name: img.name })) : undefined
    );
  }, [draft, pendingImage, send]);

  const blocks = useMemo(() => session?.blocks ?? [], [session]);
  /** 表情块只存引用：渲染时按 id 去库里找那张图。 */
  const stickerById = useMemo(() => new Map(stickers.map((s) => [s.id, s])), [stickers]);
  /** 她的库（她发给你用）与你的箱（你发给她用）分开。 */
  const herStickers = useMemo(() => stickers.filter((s) => s.owner !== "mine"), [stickers]);
  const myStickers = useMemo(() => stickers.filter((s) => s.owner === "mine"), [stickers]);

  /* 搜索需要在内存里扫全文，所以查的时候才把会话都读出来（几十条，几十万字，毫秒级）。 */
  useEffect(() => {
    if (!filter.trim()) return;
    let alive = true;
    void (async () => {
      const loaded = await Promise.all(sessions.map((s) => loadSession(s.id)));
      if (alive) setAllSessions(loaded.filter((s): s is Session => s !== null));
    })();
    return () => {
      alive = false;
    };
  }, [filter, sessions.length]);

  const memHits = useMemo(() => searchMemories(memories, filter), [memories, filter]);
  const sessHits = useMemo(() => searchSessions(allSessions, filter), [allSessions, filter]);

  /* 从搜索结果跳到某一条消息：开对应会话，然后滚到那一块。 */
  useEffect(() => {
    if (!pendingJump || !session || pendingJump.sessionId !== session.id) return;
    const t = setTimeout(() => {
      const el = feedRef.current?.querySelector('[data-idx="' + pendingJump.index + '"]');
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      setPendingJump(null);
    }, 80);
    return () => clearTimeout(t);
  }, [pendingJump, session]);

  const jumpTo = useCallback(
    async (sessionId: string, index: number) => {
      const s = await loadSession(sessionId);
      if (!s) return;
      stickToBottom.current = false;
      setSession(s);
      setPendingJump({ sessionId, index });
      setDrawer(false);
    },
    []
  );

  /** 星图数据：节点=记忆（大小=有效权重），边=她自己建立的关联。布局交给组件实时算。 */
  const graph = useMemo(() => {
    const now = Date.now();
    const active = memories.filter((m) => !m.forgotten);
    const nodes = active.map((m) => ({ name: m.name, weight: effectiveWeight(m, now), title: memoryTitle(m) }));
    const names = new Set(nodes.map((n) => n.name));
    const edges: { a: string; b: string }[] = [];
    for (const m of active) {
      for (const l of m.links ?? []) {
        if (names.has(l) && m.name < l) edges.push({ a: m.name, b: l });
      }
    }
    return { nodes, edges };
  }, [memories]);

  // 记忆跨过阈值就自动整理/遗忘。整理要用模型，没填 Key 就不动。
  useEffect(() => {
    if (!settings.apiKey || maintaining || memories.length === 0) return;
    const active = memories.filter((m) => !m.forgotten).length;
    if (shouldForget(active) || shouldConsolidate(active, dreamState?.lastConsolidatedCount ?? null)) {
      void maintainMemories();
    }
  }, [memories, dreamState, maintaining, maintainMemories, settings.apiKey]);

  // 换了会话：直接落在最新一条，别让人自己找。
  useEffect(() => {
    stickToBottom.current = true;
    requestAnimationFrame(() => scrollToBottom(false));
  }, [session?.id, scrollToBottom]);

  // 新消息进来：只有像平时那样贴着底才跟着走；用户翻上去看历史时不打断他。
  useEffect(() => {
    if (!stickToBottom.current) return;
    requestAnimationFrame(() => scrollToBottom(false));
  }, [blocks.length, scrollToBottom]);

  /** 一条消息的正文：图在气泡里，字是字。 */
  const bodyOf = (b: UserBlock | HertaBlock) => {
    if (b.kind === "herta" && b.surface === "thought") {
      return (
        <details>
          <summary>想法</summary>
          <p>{b.text}</p>
        </details>
      );
    }
    const att = b.attachments?.[0];
    return (
      <>
        {b.kind === "user" && att && (
          <Shot
            pieces={(b.attachments ?? []).map((a) => a.data)}
            name={att.name}
            onOpen={() => setViewingShot({ pieces: (b.attachments ?? []).map((a) => a.data), name: att.name })}
            // 长按存进表情箱：手机上这是唯一不打断看图的手势
            onLongPress={() => void saveToBox(att.data, att.name ?? "图", att.mediaType, [], "mine")}
          />
        )}
        {b.kind === "herta" && att && <img className="sticker" src={att.data} alt={att.name ?? "表情"} />}
        {b.kind === "herta" && b.surface === "speech" && settings.ttsEnabled && (
          <button className="say" onClick={() => void speakBlock(b.text)} title="用她的声音念出来">
            ▶ 念
          </button>
        )}
        {b.text && <p>{b.text}</p>}
        {b.kind === "herta" && b.surface === "speech" && b.usage && <UsageChip usage={b.usage} />}
      </>
    );
  };

  return (
    <div className="app">
      {!splashGone && <Splash onDone={hideSplash} />}
      <header className="bar">
        <button className="link left" onClick={() => setDrawer((v) => !v)} aria-label="会话列表">
          ☰
        </button>
        <span className="title">{session?.title ?? "Herta"}</span>
        <span className={"tag " + (transport.name === "native" ? "ok" : "warn")}>
          {transport.name === "native" ? "原生" : "浏览器"}
        </span>
        <button className="link" onClick={() => setShowSettings((v) => !v)}>
          设置
        </button>
      </header>

      {drawer && (
        <Drawer
          sessions={sessions}
          currentId={session?.id ?? null}
          filter={filter}
          onFilter={setFilter}
          memHits={memHits}
          sessHits={sessHits}
          memories={memories}
          dreamState={dreamState}
          maintaining={maintaining}
          dreaming={dreaming}
          distilling={distilling}
          distillNote={distillNote}
          showImport={showImport}
          importText={importText}
          importNote={importNote}
          importBusy={importBusy}
          shareInput={shareInput}
          nowLine={timePhrase() + " · 她在" + presenceAt().place}
          canDistill={(session?.blocks.length ?? 0) >= 12}
          actions={{
            newSession: () => void newSession(),
            openSession: (id) => void openSession(id),
            removeSession: (id) => void removeSession(id),
            jump: (sessionId, index) => void jumpTo(sessionId, index),
            openMemory: (record) => {
              setViewing(record);
              setDrawer(false);
            },
            removeMemory: (name) => void removeMemory(name),
            showGraph: () => setShowGraph(true),
            dream: () => void (session && dreamNow(session, true)),
            distill: () => void (session && distillNow(session)),
            toggleImport: () => setShowImport((v) => !v),
            setImportText,
            setShareInput,
            readImportFile: (text, name) => {
              setImportText(text);
              setImportNote("读到了 " + name + "，点下面「导进来」");
            },
            runImport: () => void runImport(),
            importFromLink: () => void importFromLink(),
          }}
        />
      )}

      {showGraph && (
        <GraphView
          nodes={graph.nodes}
          edges={graph.edges}
          onOpen={(name) => {
            const rec = memories.find((m) => m.name === name);
            if (rec) setViewing(rec);
          }}
          onClose={() => setShowGraph(false)}
        />
      )}

      {viewing && (
        <MemoryViewer
          record={viewing}
          onClose={() => setViewing(null)}
          onDelete={(name) => {
            setViewing(null);
            void removeMemory(name);
          }}
        />
      )}

      {showSettings && (
        <SettingsSheet
          settings={settings}
          onChange={(patch) => setSettings({ ...settings, ...patch })}
          onClose={() => setShowSettings(false)}
          mood={mood}
          fileNames={fileNames}
          stickers={herStickers}
          onAddStickers={(files) => void addStickers(files, "herta")}
          onRemoveSticker={(id) => void removeSticker(id)}
          onOpenCapabilities={() => setShowCaps(true)}
          onOpenToolLog={() => setShowToolLog(true)}
          onFile={(file) => {
            void file.text().then((text) => {
              filesRef.current.set(file.name, text);
              setFileNames([...filesRef.current.keys()]);
            });
          }}
        />
      )}

      {showOnboarding && (
        <Onboarding
          settings={settings}
          onChange={(patch) => setSettings({ ...settings, ...patch })}
          onOpenCapabilities={() => setShowCaps(true)}
          onDone={() => {
            localStorage.setItem("herta.onboarded.v1", "1");
            setShowOnboarding(false);
          }}
        />
      )}

      {showToolLog && <ToolLogSheet onClose={() => setShowToolLog(false)} />}

      {showCaps && (
        <CapabilitiesSheet
          settings={settings}
          onChange={(patch) => setSettings({ ...settings, ...patch })}
          onClose={() => setShowCaps(false)}
        />
      )}

      {viewingShot && <ShotViewer pieces={viewingShot.pieces} name={viewingShot.name} onClose={() => setViewingShot(null)} />}

      <main className="feed" ref={feedRef} onScroll={onFeedScroll}>
        {blocks.length === 0 && <p className="empty">她还没开口。说点什么。</p>}

        {blocks.map((b, i) => {
          if (b.kind === "system") {
            return (
              <p key={i} className="note">
                {b.body}
              </p>
            );
          }
          if (b.kind === "sticker") {
            const rec = stickerById.get(b.stickerId);
            // 库被删了也留一行：历史不该因为一张表情没了就凭空少一段
            if (!rec) {
              return (
                <p key={i} className="note">
                  （表情已删：{b.name}）
                </p>
              );
            }
            const press = longPressProps(() =>
              void saveToBox(rec.data, rec.name, rec.mediaType, rec.tags, b.from === "herta" ? "mine" : "herta")
            );
            return (
              <article key={i} data-idx={i} className={"bubble stickerBubble " + b.from}>
                <img className="sticker" src={rec.data} alt={rec.name} title={rec.tags.join("、") || rec.name} {...press.props} />
              </article>
            );
          }
          return (
            <article key={i} data-idx={i} className={"bubble " + b.kind + (b.kind === "herta" ? " " + b.surface : "")}>
              {bodyOf(b)}
            </article>
          );
        })}
        {typing && <p className="note typing">她正在敲字…</p>}
        {error && <p className="error">{error}</p>}
        {toast && <p className="toast">{toast}</p>}
      </main>

      {!atBottom && (
        <button className="jump" onClick={() => scrollToBottom(true)} aria-label="回到最新">
          ↓ 最新
        </button>
      )}

      <footer className="composer">
        {pendingImage && !VISION_MODEL.test(settings.model) && (
          <p className="notice">
            「{settings.model}」不一定收图：换成 deepseek-flash 才能让她真看见；不收图会退回纯文字。
          </p>
        )}
        {pendingImage && (
          <div className="shotPreview">
            <img
              className={previewTall ? "tall" : ""}
              src={pendingImage.pieces[0] ?? ""}
              alt="待发送的图"
              onLoad={(e) => setPreviewTall(pendingImage.pieces.length > 1 || isTallImage(e.currentTarget))}
            />
            <button onClick={() => setPendingImage(null)} aria-label="移除图片">
              ✕
            </button>
          </div>
        )}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setImageBusy(true);
            void (async () => {
              try {
                // 省 token 档把长图压到 4 段：每段都按 1024 token 算，12 段太贵
                const pieces = await prepareImage(file, { maxPieces: budgetOf(settings).imagePieces });
                let caption = "";
                // 主模型自己看得见就不用再描述一遍（省一次调用，也省一份重复的上下文）；
                // 只有「模型不吃图 + 配了视觉模型」才走老路。长图逐片描述，最多六片。
                if (settings.visionModel && !VISION_MODEL.test(settings.model)) {
                  const seen = pieces.slice(0, 6);
                  const parts = await Promise.all(
                    seen.map((dataUrl) =>
                      captionImage(
                        transport,
                        { apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.visionModel },
                        dataUrl
                      ).catch(() => "")
                    )
                  );
                  caption = parts.filter(Boolean).join("\n");
                  if (pieces.length > seen.length) {
                    caption += "\n（后面还有 " + (pieces.length - seen.length) + " 段没细看）";
                  }
                }
                setPendingImage({ mediaType: "image/jpeg", pieces, name: file.name, caption });
              } catch (err) {
                setError("这张图没看明白：" + (err instanceof Error ? err.message : String(err)));
              } finally {
                setImageBusy(false);
              }
            })();
          }}
        />
        {!busy && blocks.length > 0 && (
          <button className="composerRetract" onClick={() => void retract()} title="撤回上一轮">
            ↶ 撤回上一轮
          </button>
        )}

        {showTray && (
          <StickerTray
            her={herStickers}
            mine={myStickers}
            onPick={sendSticker}
            onAdd={(files, owner) => void addStickers(files, owner)}
            onRemove={(id) => void removeSticker(id)}
            onClose={() => setShowTray(false)}
          />
        )}

        <div className="composerBar">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="给黑塔发消息…"
            rows={1}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                dispatch();
              }
            }}
          />
          <button
            className={"composerAttach" + (showTray ? " on" : "")}
            onClick={() => setShowTray((v) => !v)}
            aria-label="发表情"
            title="发表情"
          >
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
              <circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <circle cx="9.2" cy="9.9" r="1.05" fill="currentColor" />
              <circle cx="14.8" cy="9.9" r="1.05" fill="currentColor" />
              <path
                d="M8.6 14.1c.9 1.1 2 1.65 3.4 1.65s2.5-.55 3.4-1.65"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            className="composerAttach"
            onClick={() => imageInputRef.current?.click()}
            disabled={imageBusy}
            aria-label="发一张图"
            title="给她看一张图"
          >
            {imageBusy ? (
              <span className="attachBusy">…</span>
            ) : (
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path
                  d="M20.5 11.6 12 20.1a5.4 5.4 0 0 1-7.6-7.6l8.2-8.2a3.6 3.6 0 0 1 5.1 5.1l-8.2 8.2a1.8 1.8 0 0 1-2.6-2.6l7.5-7.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
          {busy ? (
            <button className="composerSend stopping" onClick={stop} aria-label="打断">
              <span className="stopMark" />
            </button>
          ) : (
            <button
              className="composerSend"
              onClick={dispatch}
              disabled={!draft.trim() && !pendingImage}
              aria-label="发送"
            >
              <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
                <path
                  d="M12 19V6M5.6 12.4 12 6l6.4 6.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
