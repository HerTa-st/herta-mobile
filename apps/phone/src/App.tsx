import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Block, HertaBlock, ImportBundle, Session, UserBlock } from "@herta/protocol";
import {
  appendBlocks,
  type BroadcastIssue,
  type BroadcastItem,
  classifyPickedFile,
  createSession,
  decodeTextFile,
  humanizeError,
  parseImportBundle,
  parseSharedConversation,
  planImport,
  presenceAt,
  retractLastTurn,
  searchMemories,
  searchSessions,
  shareIdFromInput,
  READABLE_FILE_EVENT_NOTE,
  sanitizeFileName,
  stripStageDirections,
  SHARE_API,
  TEXT_FILE_MAX_BYTES,
  timePhrase,
  type MemoryRecord,
} from "@herta/core";
import { BrowserAssetSource } from "./assets-browser.ts";
import { Drawer } from "./components/Drawer.tsx";
import { NmsScreen } from "./nms/NmsScreen.tsx";
import { createActivationStore } from "./nms/network/activation.ts";
import { BroadcastView } from "./components/BroadcastView.tsx";
import { BroadcastNotice } from "./components/BroadcastNotice.tsx";
import { CoinView } from "./components/CoinView.tsx";
import { MemoryViewer } from "./components/MemoryViewer.tsx";
import { SettingsSheet } from "./components/SettingsSheet.tsx";
import { CapabilitiesSheet } from "./components/CapabilitiesSheet.tsx";
import { Onboarding } from "./components/Onboarding.tsx";
import { ToolLogSheet } from "./components/ToolLogSheet.tsx";
import { BackupSheet } from "./components/BackupSheet.tsx";
import { DesignSystemSheet } from "./components/DesignSystemSheet.tsx";
import { StickerTray } from "./components/StickerTray.tsx";
import { AttachTray } from "./components/AttachTray.tsx";
import { longPressProps } from "./components/long-press.ts";
import { Shot, ShotViewer, isTallImage } from "./components/Shot.tsx";
import { Splash } from "./components/Splash.tsx";
import { UsageChip } from "./components/UsageChip.tsx";
import { ReminderCard, parseReminderLike, reminderMeta } from "./components/ReminderCard.tsx";
import { useChatTurn } from "./hooks/useChatTurn.ts";
import { useProactive } from "./hooks/useProactive.ts";
import { seedPureIfNeeded } from "./pure.ts";
import { captionImage, compressImage, dataUrlToBlob, prepareImage } from "./vision.ts";
import { extractDocumentText, type DocumentFormat } from "./doc-text.ts";
import { tagSticker } from "./sticker-tag.ts";
import { cameraFailureText, dueReminders, formatBytes, isNative, listReminders, markReminderSpoken, openLink, snapPhoto, type ReminderRecord } from "./capabilities.ts";
import { useMemory } from "./hooks/useMemory.ts";
import { flushNmsTurns, recordNmsTurn } from "./nms/turn-recorder.ts";
import { acquireKeepAlive } from "./nms/keepalive-lease.ts";
import { deleteNmsTurn } from "./nms/controller.ts";
import { countUserTurns, normalizeVoiceSchema, renderVoiceParamsLine } from "@herta/nms";
import { collect } from "./stream.ts";
import { buildTools } from "./devtools.ts";
import { IdbMemoryStore } from "./memory-idb.ts";
import {
  deleteSession,
  deleteSticker,
  listSessions,
  listStickers,
  loadSession,
  appendToolLog,
  putSession,
  putSticker,
  type SessionMeta,
  type StickerRecord,
} from "./storage.ts";
import { loadReadableFiles, saveReadableFile } from "./readable-files.ts";
import { budgetOf, loadSettings, saveSettings, type Settings } from "./settings.ts";
import { pickTransport } from "./transport.ts";
import { loadPromptCode } from "./prompts.ts";
import { resolveCoinApiBase } from "./coin/config.ts";
import { loadCoinQuote } from "./coin/coin-storage.ts";
import { onCoinNotificationTap, syncCoinReminder } from "./coin/notify.ts";
import { onBroadcastNotificationTap, syncBroadcastReminder } from "./broadcast/notify.ts";
import { useBroadcast } from "./broadcast/useBroadcast.ts";
import { readArticle } from "./broadcast/reader.ts";
import { synthesize } from "./tts.ts";
import { playVoice, stopVoice } from "./voice.ts";

const assets = new BrowserAssetSource();
const transport = pickTransport();
const memoryStore = new IdbMemoryStore();

/** 侧栏底部的四个入口图标（线稿，跟桌面端同一套笔画）。 */
function RailIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** 模型名里带这些的，当它自己能看图（deepseek-flash / 各家 VL）。 */
const VISION_MODEL = /flash|vision|vl|omni/i;

/** 文档格式的显示名：toast 里说「从 Word 抽出 1234 字」比说 docx 好懂。 */
const DOC_LABEL: Record<DocumentFormat, string> = { pdf: "PDF", docx: "Word", pptx: "PPT", xlsx: "Excel" };

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  /** 系统是不是深色。theme=system 时用它决定解析结果。 */
  const [systemDark, setSystemDark] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
  );
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
    nmsSnapshot,
    voiceState,
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
    rewriteVoice,
    changeVoiceParams,
    revertVoice,
  } = useMemory(settings, { onError: (m) => reportError(m) });
  /** 自动语气：有它就用它，没有就回落冻结的旧语气（useChatTurn 里判断）。 */
  const nmsVoice = useMemo(() => {
    if (!voiceState) return null;
    const schema = normalizeVoiceSchema();
    return { profile: voiceState.profile, paramsLine: renderVoiceParamsLine(schema, voiceState.params, settings.userName) };
  }, [voiceState]);
  const nmsActivation = useMemo(() => createActivationStore(), []);
  const nmsRecallSeq = useRef(0);
  const memorySleepEnabled = settings.autoDream || settings.nmsDeepSleepEnabled;
  const [showSettings, setShowSettings] = useState(false);
  const [showCaps, setShowCaps] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showToolLog, setShowToolLog] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showDesignSystem, setShowDesignSystem] = useState(false);
  const [moodOpen, setMoodOpen] = useState(false);
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
  /** 正在抽文字的文档名（null = 没在抽）。抽大 PDF 要十几秒，得让用户看见进度。 */
  const [docReading, setDocReading] = useState<string | null>(null);
  /** 点开看整张图（长图缩略裁过，原图在这里）。 */
  const [viewingShot, setViewingShot] = useState<{ pieces: string[]; name?: string } | null>(null);
  /** 待发的图是不是长图：是就裁成竖卡片，不然预览也只剩一条线。 */
  const [previewTall, setPreviewTall] = useState(false);
  const [stickers, setStickers] = useState<StickerRecord[]>([]);
  /** 表情面板：从输入框抽起来的一层 */
  const [showTray, setShowTray] = useState(false);
  /** 回形针面板：拍照 / 选文件。和表情面板互斥，一次只抽一层。 */
  const [showAttach, setShowAttach] = useState(false);
  /** 一句话的回执（「存进表情箱了」）。她看不到控制台，这种小事也得说一声。 */
  const [toast, setToast] = useState<string | null>(null);
  /** 回形针的「选文件」：现在什么都收，按类型分流（图片 / 文本 / 其它）。 */
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** 防重入：抽文档期间又选了一份，两份 buffer + 两份 pdf.js 文档同时进内存会卡死。 */
  const docBusyRef = useRef(false);
  /** 浏览器里没有相机插件：退回带 capture 的 file input（桌面浏览器会开文件选择）。 */
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const [viewing, setViewing] = useState<MemoryRecord | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  /** 黑塔币页：聊天之外的小模块，v1 只从抽屉进。 */
  const [showCoin, setShowCoin] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  /** 抽屉入口右侧那枚涨跌幅：只用最后一次成功行情的缓存，没打开过就是 null。 */
  const [coinPct, setCoinPct] = useState<number | null>(null);
  /** 本机提醒记录：用来把写进对话的「提醒」认出来、渲染成卡片。 */
  const [reminderRecords, setReminderRecords] = useState<ReminderRecord[]>([]);
  const [shareInput, setShareInput] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const dreamingRef = useRef(false);
  /** 用户手动选给她读的文件：工具只能读这里，不能自己翻磁盘。 */
  const filesRef = useRef(new Map<string, string>());
  /** 她把你的表情收进库时要落库；存库函数定义在后面，用 ref 把这根线接上。 */
  const keepStickerRef = useRef<(record: StickerRecord) => void>(() => undefined);
  const feedRef = useRef<HTMLElement | null>(null);
  /** 输入框：多行草稿要自己长高，胶囊跟着长，别在 1 行小框里滚。 */
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  /** 用户是不是"贴着底部"。他往上一翻就松手，不再跟着新消息跑。 */
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => saveSettings(settings), [settings]);

  /**
   * 外观：把解析后的主题写到 <html data-theme>。
   * CSS 只在 [data-theme="dark"] 下覆盖 token；布局不动。
   */
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      setSystemDark(mq.matches);
      const dark = settings.theme === "dark" || (settings.theme === "system" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", dark ? "#061018" : "#f8fbfa");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [settings.theme]);

  /** 行情接口从哪来：设置里手填的优先，其次构建注入；再没有就空（页面会说明未配置）。 */
  const coinBase = useMemo(() => resolveCoinApiBase(settings.coinApiBase), [settings.coinApiBase]);

  /**
   * 黑塔币的启动杂活：
   *   - 把最后一次行情的涨跌幅喂给抽屉入口（不开页也能看见）；
   *   - 补排每天 09:30 的开盘提醒（用户关掉就静默）；
   *   - 接住通知点击：点提醒直接落到黑塔币页。
   */
  useEffect(() => {
    void loadCoinQuote().then((cached) => {
      if (cached) setCoinPct(cached.response.market.changePct);
    });
    void syncCoinReminder();
    // StrictMode 下 effect 会挂载→卸载→再挂载：监听还没 resolve 就轮到 cleanup 时，
    // 直接把取消函数丢掉会导致监听泄漏（dev 里点一次通知触发两次）。用 cancelled 兜住。
    let off: (() => void) | null = null;
    let cancelled = false;
    void onCoinNotificationTap(() => {
      setDrawer(false);
      setShowCoin(true);
    }).then((fn) => {
      if (cancelled) fn();
      else off = fn;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  /** 播报提醒：每次开 app 补排一遍；点通知直接落到播报页。 */
  useEffect(() => {
    void syncBroadcastReminder();
    let off: (() => void) | null = null;
    let cancelled = false;
    void onBroadcastNotificationTap(() => {
      setDrawer(false);
      setShowBroadcast(true);
    }).then((fn) => {
      if (cancelled) fn();
      else off = fn;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

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

        // 不再往手机里预装记忆。第一次打开记忆库就是空的；
        // 之后每一条都必须是这段对话真正长出来的。
        if (alive) await refreshMemories();
        if (alive) setStickers(await listStickers());

        // 她能读的文件落盘在上一次运行里：重启后还在，聊天里那句「放进入口」才不是假话
        try {
          const readable = await loadReadableFiles();
          if (alive) {
            filesRef.current.clear();
            for (const f of readable) filesRef.current.set(f.name, f.text);
            setFileNames([...filesRef.current.keys()]);
          }
        } catch {
          /* 文件库坏了不该拖垮启动 */
        }

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

  // 提醒卡片的数据源：本机提醒记录。一分钟刷一次，她新排的提醒也能很快被认出来。
  useEffect(() => {
    const load = () => {
      void listReminders()
        .then(setReminderRecords)
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  /** 一个回合的全过程都在这里：判心情、算行踪、带工具说话、复核、落库。 */
  const { send, stop, busy, mood, moodAt, typing } = useChatTurn({
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
    onTurnEnd: (payload) => recordNmsTurn(payload),
    onNmsRecall: (events) => {
      nmsRecallSeq.current += 1;
      nmsActivation.ingest({ seq: nmsRecallSeq.current, at: new Date().toISOString(), nodes: events });
    },
    nmsVoice,
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

  // NMS 深睡与 proactive 共用 HertaKeeperService：引用计数，任一需要就保活。
  useEffect(() => {
    if (!settings.nmsDeepSleepEnabled) return;
    const release = acquireKeepAlive("nms-deep-sleep");
    return release;
  }, [settings.nmsDeepSleepEnabled]);

  /** 从表情面板发一张：文字是空的，这一轮的起点是那张表情块。 */
  const sendSticker = useCallback(
    (record: StickerRecord) => {
      setShowTray(false);
      void send("", undefined, record);
    },
    [send]
  );

  /** 播报好了：往当时的会话里塞一条「播报提示」，同一天只塞一次。 */
  const appendBroadcastPrompt = useCallback(
    async (issue: BroadcastIssue) => {
      // 她正在回话时不要插：那一轮结束时会用自己的会话覆盖，提示会丢
      if (busyRef.current) throw new Error("她正在说话，等这一轮结束再递播报");
      const target = sessionRef.current ?? (await loadSession((await listSessions())[0]?.id ?? ""));
      if (!target) throw new Error("还没有会话能接住播报提示");
      const exists = target.blocks.some(
        (block) => block.kind === "herta" && block.action?.kind === "broadcast" && block.action.issueId === issue.id
      );
      if (exists) return;
      const at = new Date().toISOString();
      const block: HertaBlock = {
        kind: "herta",
        surface: "speech",
        text: "今天的星际和平播报到了。",
        at,
        action: { kind: "broadcast", issueId: issue.id, no: issue.no },
      };
      const next: Session = { ...target, blocks: [...target.blocks, block], updatedAt: at };
      await putSession(next);
      if (sessionRef.current?.id === next.id) setSession(next);
      await refreshList();
    },
    [refreshList]
  );

  const broadcast = useBroadcast({
    settings,
    enabled: splashGone,
    onPrompt: appendBroadcastPrompt,
  });

  /** 侧栏四个入口：同一时间只开一页，再点一次关掉。 */
  const openPage = useCallback(
    (target: "memory" | "broadcast" | "coin") => {
      const isOpen = target === "memory" ? showGraph : target === "broadcast" ? showBroadcast : showCoin;
      setShowGraph(target === "memory" ? !isOpen : false);
      setShowBroadcast(target === "broadcast" ? !isOpen : false);
      setShowCoin(target === "coin" ? !isOpen : false);
    },
    [showGraph, showBroadcast, showCoin]
  );

  /** 回对话：关掉所有整屏页，不新建会话。 */
  const showChat = useCallback(() => {
    setShowGraph(false);
    setShowBroadcast(false);
    setShowCoin(false);
    setShowSettings(false);
    setDrawer(false);
  }, []);

  /** 从播报里点「让她再多说两句」：关页、回聊天、带引用发一句。 */
  const discussBroadcastItem = useCallback(
    (item: BroadcastItem) => {
      setShowBroadcast(false);
      const quote = "关于这条新闻，你怎么看？\n「" + item.title + "」" + (item.url ? "\n" + item.url : "");
      void send(quote);
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
    if (!memorySleepEnabled) return;
    const tick = () => {
      if (!session || busy || dreaming || distilling || maintaining) return;
      if (!memorySleepEnabled) return;
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
  }, [busy, distilling, dreamNow, dreaming, maintaining, memorySleepEnabled, session]);

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
    if (!memorySleepEnabled) return;

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
  }, [memorySleepEnabled, runUpkeep]);

  /** 打开 App 放了半天没说话的，进来二十秒后让她做一次梦。 */
  useEffect(() => {
    if (!memorySleepEnabled) return;
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
    const turn = countUserTurns(session.blocks);
    const cut = retractLastTurn(session);
    setSession(cut);
    await persist(cut);
    if (turn > 0) {
      // 先让排队中的 pending 落库，再删，避免插入晚于删除。
      await flushNmsTurns();
      void deleteNmsTurn(session.id, turn);
    }
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
    setShowAttach(false);
    // 长图切出来的每一片都是独立附件：模型逐片看，气泡把它们接成一摞
    void send(
      text,
      img ? img.pieces.map((data) => ({ mediaType: img.mediaType, data, name: img.name })) : undefined
    );
  }, [draft, pendingImage, send]);

  /**
   * 图从哪儿来都走这一条：切片 →（模型不收图时）让视觉模型描述 → 落成待发状态。
   * 相机拍的和从文件里选的是同一张图，后面的路不该有两套。
   */
  const preparePendingImage = useCallback(
    async (blob: Blob, name: string) => {
      // 省 token 档把长图压到 4 段：每段都按 1024 token 算，12 段太贵
      const pieces = await prepareImage(blob, { maxPieces: budgetOf(settings).imagePieces });
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
      setPendingImage({ mediaType: "image/jpeg", pieces, name, caption });
    },
    [settings]
  );

  /** 收一张图：忙碌标记与报错都在这里，两个入口都不用各写一遍。 */
  const ingestImage = useCallback(
    async (blob: Blob, name: string) => {
      setImageBusy(true);
      try {
        await preparePendingImage(blob, name);
      } catch (err) {
        reportError("这张图没看明白：" + (err instanceof Error ? err.message : String(err)));
      } finally {
        setImageBusy(false);
      }
    },
    [preparePendingImage, reportError]
  );

  /**
   * 拍照。
   *
   * 手机上走 Capacitor 相机（调系统相机 Intent，不需要 App 自己申请相机权限）；浏览器里没有那个插件，
   * 退回带 capture 的 file input——dev 时点「拍照」至少能开文件选择，不会是个死按钮。
   */
  const takePhoto = useCallback(async () => {
    setShowAttach(false);
    if (!isNative()) {
      cameraInputRef.current?.click();
      return;
    }
    setImageBusy(true);
    try {
      let shot: { data: string; mediaType: string };
      try {
        shot = await snapPhoto();
      } catch (err) {
        // 取消不是错误：点开相机又退出，不该在聊天页留一行红字
        const message = cameraFailureText(err);
        if (message) reportError(message);
        return;
      }
      // 解码单独兜：相机其实拍成功了，别把「读不出来」报成「相机没打开」
      let blob: Blob;
      try {
        blob = dataUrlToBlob(shot.data);
      } catch (err) {
        reportError("拍到了，但这张图读不出来：" + (err instanceof Error ? err.message : String(err)));
        return;
      }
      await ingestImage(blob, "相机照片");
    } finally {
      setImageBusy(false);
    }
  }, [ingestImage, reportError]);

  /**
   * 文字进「她能读的文件」：落盘、聊天里留提示、toast。
   * 纯文本文件与 PDF / Office 抽出来的文字都走这一条——后面只有一份存储、一个 read_file。
   */
  const addReadableText = useCallback(
    async (name: string, text: string, suffix: string, opts: { truncate?: boolean } = {}) => {
      let body = text;
      let note = suffix;
      if (body.length > TEXT_FILE_MAX_BYTES) {
        // 文本文件可以叫用户截一段再选；PDF/Word 没法截，只能替她截断
        if (!opts.truncate) {
          reportError(
            "「" + name + "」抽出 " + Math.round(body.length / 1024) + "KB 文字，太长了——她能读的单个文件上限是 " +
              Math.round(TEXT_FILE_MAX_BYTES / 1024) + "KB，截一段再选。"
          );
          return;
        }
        body = body.slice(0, TEXT_FILE_MAX_BYTES);
        note += "（太长，只放了前 " + Math.round(TEXT_FILE_MAX_BYTES / 1024) + "KB 文字）";
      }
      filesRef.current.set(name, body);
      setFileNames([...filesRef.current.keys()]);
      // 落盘：重启之后她还读得到，聊天里那条提示才不会变成假话
      let dropped: string[] = [];
      try {
        const saved = await saveReadableFile({ name, text: body, at: new Date().toISOString() });
        dropped = saved.dropped;
        filesRef.current.clear();
        for (const f of saved.kept) filesRef.current.set(f.name, f.text);
        setFileNames([...filesRef.current.keys()]);
      } catch {
        /* 落盘失败不影响这次能用 */
      }
      // 审计页留一条：文件是什么时候、以什么名字进来的（聊天页不显示，见下面的 hidden 块）
      void appendToolLog({
        at: new Date().toISOString(),
        sessionId: sessionRef.current?.id ?? "",
        name: "可读文件",
        label: "文件库",
        ok: true,
        args: JSON.stringify({ name, chars: body.length }),
        content:
          "「" + name + "」已放进她能读的文件" +
          (dropped.length > 0 ? "；移出：" + dropped.join("、") : ""),
      }).catch(() => undefined);
      // 聊天里留一行痕迹：文件塞进去了却什么都不显示，用户会以为没成功。
      // 用 ref 判当前状态：await 期间她可能已经开始说话，闭包里的 busy/session 会是旧的。
      const current = sessionRef.current;
      if (current && !busyRef.current) {
        const at = new Date().toISOString();
        const notes: Block[] = [
          {
            kind: "system",
            label: "系统",
            hidden: true,
            // 写成中立句：这条会作为〔系统〕进她的转录，用「你」会让她分不清是谁在说话。
            // 聊天页不显示（hidden），只在「工具调用记录」里能查到。
            body: "（「" + name + "」已放进她能读的文件里；想让她看就说「看看 " + name + "」。）",
            at,
          },
        ];
        // 淘汰不只在 toast 里说：她那边也留一条，否则她的上下文还认为文件在
        if (dropped.length > 0) {
          notes.push({
            kind: "system",
            label: "系统",
            hidden: true,
            body: "（整库超过 2MB，「" + dropped.join("」、「") + "」已从她能读的文件里移出。）",
            at,
          });
        }
        const next = appendBlocks(current, notes);
        setSession(next);
        // 文件本身已经加进去了；这条提示写不进去不算失败
        try {
          await persist(next);
        } catch {
          /* 忽略 */
        }
      }
      // 淘汰必须说出来：文件静默消失、聊天里提示还在，就又是"她以为文件在"的老毛病
      const evictNote = dropped.length > 0 ? "；整库超过 2MB，已移出最早的：" + dropped.join("、") : "";
      flashToast("「" + name + "」她能读了" + note + evictNote);
    },
    [flashToast, persist, reportError]
  );

  /** 纯文本文件：先解码（GBK / UTF-16 直接当 UTF-8 读会静默乱码），再进文件库。 */
  const addReadableFile = useCallback(
    async (file: File) => {
      // 文件名要进 system 旁白，先清洗（换行/「」〔〕能伪造一行系统提示）
      const name = sanitizeFileName(file.name);
      if (file.size > TEXT_FILE_MAX_BYTES) {
        reportError(
          "「" + name + "」有 " + formatBytes(file.size) + "，太大了——她能读的单个文本文件上限是 " +
            Math.round(TEXT_FILE_MAX_BYTES / 1024) + "KB，截一段再选。"
        );
        return;
      }
      // 调用方理论上已经分过类；设置页等入口也走这里，accept 在部分 ROM 上会被忽略
      const kind = classifyPickedFile(file);
      if (kind !== "text") {
        reportError(
          kind === "image"
            ? "「" + name + "」是图片——直接发给她看就行，这里只放能读的文件。"
            : "「" + name + "」不是文本文件——这里只能放文本、PDF / Word / Excel / PPT。"
        );
        return;
      }
      try {
        const decoded = decodeTextFile(new Uint8Array(await file.arrayBuffer()));
        const encodingNote = decoded.encoding === "utf-8" ? "" : "（按 " + decoded.encoding.toUpperCase() + " 解）";
        await addReadableText(name, decoded.text, encodingNote);
      } catch (err) {
        reportError("这个文件读不出来：" + (err instanceof Error ? err.message : String(err)));
      }
    },
    [addReadableText, reportError]
  );

  /**
   * PDF / Word / Excel / PPT：先抽文字，再走文本文件同一条落库路径。
   * 扫描件 PDF 抽不到文字（没有文字层），要提示用户转图片发给她看。
   */
  const addDocument = useCallback(
    async (file: File) => {
      const name = sanitizeFileName(file.name);
      if (docBusyRef.current) {
        reportError("还在读上一份文档，等它读完再选。");
        return;
      }
      docBusyRef.current = true;
      setDocReading(name);
      try {
        const { format, text } = await extractDocumentText(file);
        const trimmed = text.trim();
        if (!trimmed) {
          reportError("「" + name + "」里没抽到文字——可能是扫描件/图片版；把它转成图片发给她看。");
          return;
        }
        // 文档没法让用户自己截，超长时由 addReadableText 截断并注明
        await addReadableText(name, trimmed, "（从 " + DOC_LABEL[format] + " 抽出 " + trimmed.length + " 字）", {
          truncate: true,
        });
      } catch (err) {
        reportError("这个文档读不出来：" + (err instanceof Error ? err.message : String(err)));
      } finally {
        docBusyRef.current = false;
        setDocReading(null);
      }
    },
    [addReadableText, reportError]
  );

  /**
   * 「能读的文件」入口：文本与文档都收，图片请走回形针看图。
   * 设置页那个 file input 也走这里——accept 在部分 ROM 上会被忽略，分类兜底不能省。
   */
  const ingestReadable = useCallback(
    (file: File) => {
      const name = sanitizeFileName(file.name);
      const kind = classifyPickedFile(file);
      if (kind === "text") {
        void addReadableFile(file);
        return;
      }
      if (kind === "doc") {
        void addDocument(file);
        return;
      }
      if (kind === "image") {
        reportError("「" + name + "」是图片——直接发给她看就行，这里只放能读的文件。");
        return;
      }
      // HEIC 是图片，但 WebView 解不了——单独给一句，别让她以为是文件坏了。
      // 扩展名和 MIME 都要认：相册导出的 HEIC 未必带 .heic 后缀
      if (/\.(heic|heif)$/i.test(file.name) || /^image\/hei[cf]/i.test(file.type)) {
        reportError("「" + name + "」是 HEIC 图，她这边解不了——先在相册里导出成 JPG 再选。");
        return;
      }
      reportError(
        "「" + name + "」这种文件她现在读不了：支持图片、文本文件和 PDF / Word(.docx) / Excel(.xlsx) / PPT(.pptx)；老版 .doc/.xls/.ppt 和压缩包还不行。"
      );
    },
    [addDocument, addReadableFile, reportError]
  );

  /**
   * 回形针选回来的文件按类型分流：图片进看图管线，其余交给「能读的文件」入口。
   * 文件名与 MIME 都要看——文件管理器给的 MIME 有时是空的（见 core/files.ts）。
   */
  const pickFile = useCallback(
    (file: File) => {
      if (classifyPickedFile(file) === "image") {
        void ingestImage(file, sanitizeFileName(file.name));
        return;
      }
      ingestReadable(file);
    },
    [ingestImage, ingestReadable]
  );

  const blocks = useMemo(() => session?.blocks ?? [], [session]);

  /**
   * 把「先想一句、紧跟着说出来」合成一张卡：
   * 桌面端也是一张卡里先想再说，分成两块会多一个头像、多一个时间。
   */
  const renderBlocks = useMemo(() => {
    const out: { b: Block; i: number; thought: HertaBlock | null }[] = [];
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i];
      const next = blocks[i + 1];
      if (
        b.kind === "herta" &&
        b.surface === "thought" &&
        next &&
        next.kind === "herta" &&
        next.surface === "speech"
      ) {
        out.push({ b: next, i: i + 1, thought: b });
        i += 1;
      } else {
        out.push({ b, i, thought: null });
      }
    }
    return out;
  }, [blocks]);
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
  const themeIsDark = settings.theme === "dark" || (settings.theme === "system" && systemDark);

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

  // 草稿换到多行时把输入框长高（最多 120），胶囊跟着长。
  useEffect(() => {
    const el = draftRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [draft]);

  // 键盘弹出/收起会改可视高度：adjustResize 之后把最新一条留在输入条上面。
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onViewportResize = () => {
      if (stickToBottom.current) requestAnimationFrame(() => scrollToBottom(false));
    };
    vv.addEventListener("resize", onViewportResize);
    return () => vv.removeEventListener("resize", onViewportResize);
  }, [scrollToBottom]);

  /** 提醒记录按「title\n正文」索引：写进对话的提醒正文就是这个格式。 */
  const reminderByText = useMemo(() => {
    const map = new Map<string, ReminderRecord>();
    for (const record of reminderRecords) map.set(record.title + "\n" + record.text, record);
    return map;
  }, [reminderRecords]);

  /** 块上的时间：只给眼睛看，不参与序列化。 */
  const clockOf = (at: string) => {
    const d = new Date(at);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  };

  /** 一条消息的正文：图在气泡里，字是字。 */
  const bodyOf = (b: UserBlock | HertaBlock) => {
    if (b.kind === "herta" && b.surface === "thought") {
      return (
        <div className="thought">
          <span className="thoughtLabel">想</span>
          <p>{b.text}</p>
        </div>
      );
    }
    const att = b.attachments?.[0];
    const actionMatch =
      b.kind === "herta" && b.surface === "speech" ? /^（([^）]*)）\s*/.exec(b.text) : null;
    const actionText = actionMatch?.[1] ?? "";
    const bodyText = actionMatch ? b.text.slice(actionMatch[0].length) : b.text;
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
        {actionText && <p className="action">（{actionText}）</p>}
        {bodyText && <p>{bodyText}</p>}
        {b.kind === "herta" && b.surface === "speech" && b.usage && <UsageChip usage={b.usage} />}
      </>
    );
  };

  return (
    <div className="app" data-rail={settings.railCollapsed ? "collapsed" : "expanded"}>
      {!splashGone && <Splash onDone={hideSplash} />}

      {/* 桌面端那条侧栏的窄版：会话常驻，入口在底部 */}
      <aside className="rail" aria-label="侧栏">
        <button className="railMark" type="button" onClick={() => setDrawer((v) => !v)} aria-label="会话">
          H
        </button>
        <button className="railNew" type="button" onClick={() => void newSession()} aria-label="新对话">
          ＋
        </button>
        <nav className="railNav" aria-label="模块">
          <button
            type="button"
            className={!showGraph && !showBroadcast && !showCoin && !showSettings ? "on" : ""}
            onClick={showChat}
            aria-label="对话"
          >
            <RailIcon d="M4 5.5h16v10.5H9l-5 4z" />
          </button>
          <button type="button" className={showGraph ? "on" : ""} onClick={() => openPage("memory")} aria-label="记忆">
            <RailIcon d="M8 4h8a2 2 0 0 1 2 2v14l-6-4-6 4V6a2 2 0 0 1 2-2Z" />
          </button>
          <button
            type="button"
            className={showBroadcast ? "on" : ""}
            onClick={() => openPage("broadcast")}
            aria-label="播报"
          >
            <RailIcon d="M12 12h.01M8.6 15.4a4.8 4.8 0 0 1 0-6.8M15.4 8.6a4.8 4.8 0 0 1 0 6.8M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
          </button>
          <button type="button" className={showCoin ? "on" : ""} onClick={() => openPage("coin")} aria-label="黑塔币">
            <RailIcon d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 8v8M9 10h4.5a1.5 1.5 0 0 1 0 3H9" />
          </button>
        </nav>
        <div className="railFoot">
          <button
            type="button"
            className={showSettings ? "on" : ""}
            onClick={() => setShowSettings((v) => !v)}
            aria-label="设置"
          >
            <RailIcon d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 13a7.9 7.9 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.9 7.9 0 0 0-1.7-1L15 3.5h-4l-.3 2.5a7.9 7.9 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.9 7.9 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.9 7.9 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7.9 7.9 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6Z" />
          </button>
          <button type="button" onClick={() => setDrawer((v) => !v)} aria-label="更多">
            ⋯
          </button>
        </div>
      </aside>

      {/* 左轨收起的把手：贴在轨道右缘，点一下 58 → 12；状态记在 settings 里。 */}
      <button
        className="railHandle"
        type="button"
        onClick={() => setSettings((s) => ({ ...s, railCollapsed: !s.railCollapsed }))}
        aria-label={settings.railCollapsed ? "展开左轨" : "收起左轨"}
        aria-expanded={!settings.railCollapsed}
      />

      <section className="workspace">
      <header className="bar">
        <button className="iconBtn" type="button" onClick={() => setDrawer((v) => !v)} aria-label="会话">
          ☰
        </button>
        <div className="topTitle">
          <span className="topName">黑塔</span>
          <span className="topSub">
            {presenceAt().phase} · {presenceAt().place}
          </span>
        </div>
        <button
          className="moodChip"
          type="button"
          onClick={() => setMoodOpen((v) => !v)}
          aria-expanded={moodOpen}
          aria-label="她的心情"
          title="点开看她这会儿是什么心情"
        >
          <i />
          {!mood || mood === "默认" ? "平静" : mood}
        </button>
        <button
          className="themeToggle"
          type="button"
          onClick={() => setSettings((s) => ({ ...s, theme: themeIsDark ? "light" : "dark" }))}
          aria-label={themeIsDark ? "切到日间" : "切到夜间"}
          title={themeIsDark ? "切到日间" : "切到夜间"}
        >
          {themeIsDark ? "日" : "夜"}
        </button>
        <button className="topAvatarBtn" type="button" onClick={() => setShowSettings(true)} aria-label="设置">
          <img src="/herta.png" alt="" />
        </button>
      </header>

      {moodOpen && (
        <div className="moodPop" role="dialog" aria-label="她的心情">
          <b>{!mood || mood === "默认" ? "平静" : mood}</b>
          <span>{moodAt ? clockOf(new Date(moodAt).toISOString()) + " 判的" : "还没判过"}</span>
          <small>每轮开头判一次；三小时没说话就淡回去。这里不额外调模型。</small>
        </div>
      )}

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
          coinPct={coinPct}
          broadcastNo={broadcast.today?.no ?? null}
          broadcastUnread={broadcast.unread}
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
            openCoin: () => {
              setDrawer(false);
              openPage("coin");
            },
            openBroadcast: () => {
              setDrawer(false);
              openPage("broadcast");
            },
          }}
        />
      )}

      {showCoin && (
        <CoinView
          // base 变了就重挂：设置里改接口地址后要重新拉，不用杀 app
          key={coinBase || "coin-no-base"}
          base={coinBase}
          identity={settings.coinIdentity}
          onIdentityChange={(next) => setSettings({ ...settings, coinIdentity: next })}
          onClose={() => setShowCoin(false)}
          onQuoteChange={(q) => setCoinPct(q ? q.market.changePct : null)}
        />
      )}

      {showBroadcast && (
        <BroadcastView
          issues={broadcast.issues}
          today={broadcast.today}
          status={broadcast.status}
          error={broadcast.error}
          generating={broadcast.generating}
          config={broadcast.config}
          onClose={() => setShowBroadcast(false)}
          onRetry={() => void broadcast.generate(true)}
          onMarkRead={broadcast.markRead}
          onOpenLink={(url) => {
            void openLink(url).catch((openError) => {
              setError(openError instanceof Error ? openError.message : String(openError));
            });
          }}
          onDiscuss={discussBroadcastItem}
          onReadItem={(item) => readArticle(item, settings)}
          onCacheItem={(issueId, itemId, digest) => broadcast.cacheDetail(issueId, itemId, digest)}
          onConfigChange={(next) => void broadcast.updateConfig(next)}
          onClearHistory={() => void broadcast.clearHistory()}
        />
      )}

      {showGraph && (
        <NmsScreen
          snapshot={nmsSnapshot}
          activationStore={nmsActivation}
          settings={settings}
          voice={voiceState}
          onSettingsChange={(patch) => setSettings({ ...settings, ...patch })}
          onRefresh={() => void refreshMemories()}
          onRewriteVoice={rewriteVoice}
          onChangeVoiceParams={(params) => void changeVoiceParams(params)}
          onRollbackVoice={(version) => void revertVoice(version)}
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
          onOpenBackup={() => setShowBackup(true)}
          onReplayOnboarding={() => {
            setShowSettings(false);
            setShowOnboarding(true);
          }}
          onOpenDesignSystem={() => setShowDesignSystem(true)}
          onFile={(file) => ingestReadable(file)}
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

      {showDesignSystem && <DesignSystemSheet onClose={() => setShowDesignSystem(false)} />}

      {showBackup && (
        <BackupSheet
          settings={settings}
          onClose={() => setShowBackup(false)}
          onRestored={() => {
            void refreshList();
            void refreshMemories();
            void listStickers().then(setStickers);
            void broadcast.refresh();
          }}
        />
      )}

      {showCaps && (
        <CapabilitiesSheet
          settings={settings}
          onChange={(patch) => setSettings({ ...settings, ...patch })}
          onClose={() => setShowCaps(false)}
        />
      )}

      {viewingShot && <ShotViewer pieces={viewingShot.pieces} name={viewingShot.name} onClose={() => setViewingShot(null)} />}

      <div className="chatContext">
        <span className="liveDot" />
        <span>记忆 {memories.filter((m) => !m.forgotten).length} 篇</span>
        <i>·</i>
        <span>复核 {settings.reviewEnabled ? "开" : "关"}</span>
        <i>·</i>
        <span>省 token {settings.cheapMode ? "开" : "关"}</span>
        <span className="chatClock">
          {new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>

      {/* 点聊天区就把附件面板收起来：它是冲着输入框来的，不该一直挂着 */}
      <main className="feed" ref={feedRef} onScroll={onFeedScroll} onPointerDown={() => setShowAttach(false)}>
        {blocks.length === 0 && <p className="empty">她还没开口。说点什么。</p>}
        {blocks.length > 0 && (
          <div className="dayLine">
            <span>今天</span>
          </div>
        )}

        {renderBlocks.map(({ b, i, thought }) => {
          if (b.kind === "system") {
            // 文件库事件只在「工具调用记录」里显示，聊天流里不刷屏；
            // 老版本写下的块没有 hidden 标记，按正文再认一遍（见 core 的 READABLE_FILE_EVENT_NOTE）
            if (b.hidden || READABLE_FILE_EVENT_NOTE.test(b.body)) return null;
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
          // 播报提示：她递过来的一份东西，不是一句台词 —— 用转播卡，不用对话气泡
          if (b.kind === "herta" && b.action?.kind === "broadcast") {
            const issue = broadcast.issues.find((item) => item.id === b.action?.issueId);
            return (
              <BroadcastNotice
                key={i}
                no={b.action.no}
                count={issue?.items.length}
                text={b.text}
                onOpen={() => {
                  setDrawer(false);
                  setShowBroadcast(true);
                }}
              />
            );
          }
          // 提醒：到点被写进对话的那条，渲染成卡片，不混在对话气泡里
          if (b.kind === "herta" && b.surface === "speech") {
            const record = reminderByText.get(b.text);
            if (record) {
              return (
                <ReminderCard
                  key={i}
                  index={i}
                  title={record.title}
                  text={record.text}
                  at={b.at}
                  meta={reminderMeta(record)}
                />
              );
            }
            const parsed = parseReminderLike(b.text);
            if (parsed) {
              return <ReminderCard key={i} index={i} title={parsed.title} text={parsed.text} at={b.at} />;
            }
          }
          if (b.kind === "herta" && b.surface === "speech" && thought) {
            return (
              <div key={i} data-idx={i} className="turn herta speech">
                <img className="turnAvatar" src="/herta.png" alt="" />
                <article className="bubble herta speech">
                  <div className="thought">
                    <span className="thoughtLabel">想</span>
                    <p>{thought.text}</p>
                  </div>
                  {bodyOf(b)}
                  <span className="bubbleTime">{clockOf(b.at)}</span>
                </article>
              </div>
            );
          }
          return (
            <div
              key={i}
              data-idx={i}
              className={"turn " + b.kind + (b.kind === "herta" ? " " + b.surface : "")}
            >
              {b.kind === "herta" && <img className="turnAvatar" src="/herta.png" alt="" />}
              <article className={"bubble " + b.kind + (b.kind === "herta" ? " " + b.surface : "")}>
                {bodyOf(b)}
                <span className="bubbleTime">{clockOf(b.at)}</span>
              </article>
              {b.kind === "user" && <span className="userMark">你</span>}
            </div>
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
        {docReading && (
          <p className="notice">正在读「{docReading}」…大文档要十几秒，读完会出现在她能读的文件里。</p>
        )}
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
        {/* 选文件：什么都收（不设 accept），由 pickFile 按类型分流。
            图片进看图管线，文本进她能读的文件，二进制/文档明确拒绝。 */}
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: "none" }}
          onChange={(e) => {
            // FileList 是活引用：先取快照再清 value，否则清空时把文件也清了
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            pickFile(file);
          }}
        />
        {/* 浏览器里的拍照退路：capture 输入框；桌面浏览器会落到文件选择，别当它坏了 */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void ingestImage(file, file.name || "相机照片");
          }}
        />
        <div className="composerQuick">
          {!busy && blocks.length > 0 && (
            <button className="composerRetract" onClick={() => void retract()} title="撤回上一轮">
              ↶ 撤回上一轮
            </button>
          )}
          <span>Enter 发送 · 长图自动切段</span>
        </div>

        {showAttach && (
          <AttachTray
            onCamera={() => void takePhoto()}
            onFile={() => {
              setShowAttach(false);
              fileInputRef.current?.click();
            }}
            onClose={() => setShowAttach(false)}
            busy={imageBusy || docReading !== null}
          />
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
            ref={draftRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="给黑塔发消息…"
            rows={1}
            // 点正文就把附件面板收起来：那两个按钮已经不需要了
            onFocus={() => setShowAttach(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                dispatch();
              }
            }}
          />
          <button
            className={"composerAttach composerEmoji" + (showTray ? " on" : "")}
            onClick={() => {
              setShowAttach(false);
              setShowTray((v) => !v);
            }}
            aria-label="发表情"
            aria-expanded={showTray}
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
            className={"composerAttach composerFile" + (showAttach ? " on" : "")}
            onClick={() => {
              setShowTray(false);
              setShowAttach((v) => !v);
            }}
            disabled={imageBusy || docReading !== null}
            aria-label="拍照或选文件"
            aria-expanded={showAttach}
            title="拍照或选文件"
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
        <div className="composerFoot">
          <span>她的手机 · 本机模型调用</span>
          <span>{settings.model}</span>
        </div>
      </footer>
      </section>
    </div>
  );
}
