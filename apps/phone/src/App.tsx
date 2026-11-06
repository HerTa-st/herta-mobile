import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
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
import { GraphScreen } from "./nms/GraphScreen.tsx";
import { createActivationStore } from "./nms/network/activation.ts";
import { BroadcastView } from "./components/BroadcastView.tsx";
import { BroadcastNotice } from "./components/BroadcastNotice.tsx";
import { CoinView } from "./components/CoinView.tsx";
import { MemoryViewer } from "./components/MemoryViewer.tsx";
import { SettingsSheet } from "./components/SettingsSheet.tsx";
import { AppearanceScreen } from "./components/AppearanceScreen.tsx";
import { CapabilitiesSheet } from "./components/CapabilitiesSheet.tsx";
import { Onboarding } from "./components/Onboarding.tsx";
import { ToolLogSheet } from "./components/ToolLogSheet.tsx";
import { BackupSheet } from "./components/BackupSheet.tsx";
import { DesignSystemSheet } from "./components/DesignSystemSheet.tsx";
import { SponsorsScreen } from "./components/SponsorsScreen.tsx";
import { DevsScreen } from "./components/DevsScreen.tsx";
import { IssuesScreen } from "./components/IssuesScreen.tsx";
import { FEEDBACK_FORM_URL } from "./credits.ts";
import { StickerTray } from "./components/StickerTray.tsx";
import { AttachTray } from "./components/AttachTray.tsx";
import { longPressProps } from "./components/long-press.ts";
import { Shot, ShotViewer, isTallImage } from "./components/Shot.tsx";
import { Splash, shouldPlaySplash } from "./components/Splash.tsx";
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
  getKV,
  listSessions,
  listStickers,
  loadPinnedSessions,
  loadSession,
  appendToolLog,
  putSession,
  putSticker,
  renameSession,
  savePinnedSessions,
  setKV,
  type SessionMeta,
  type StickerRecord,
} from "./storage.ts";
import { clearReadableFiles, loadReadableFiles, removeReadableFile, saveReadableFile } from "./readable-files.ts";
import {
  SESSION_BACKGROUND_KEY,
  backgroundKind,
  backgroundOf,
  budgetOf,
  faceSrc,
  loadSettings,
  saveSettings,
  type Settings,
} from "./settings.ts";
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
import { usePageStack } from "./nav/use-page-stack.ts";
import { connectSystemBack } from "./nav/system-back.ts";
import { routeFromNotification } from "./nav/routes.ts";
import { ThemeScreen } from "./theme/ThemeScreen.tsx";
import {
  activateTheme,
  APP_VERSION,
  bootstrapTheme,
  installThemeFromBytes,
  installThemeFromUrl,
  uninstallTheme,
  type ThemeSnapshot,
} from "./theme/runtime.ts";
import { Slot } from "./theme/slots.tsx";
import type { InstalledThemeMeta } from "./theme/store.ts";

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

/**
 * 老版本写下的工具旁白没有 hidden 标记，正文形如「（上网查了：…）」。
 * 按这个形状认出来，聊天里同样不显示——「她看到了，没接话」这种没有冒号，不受影响。
 */
const LEGACY_TOOL_NOTE = /^（[^）]{1,48}：/;

/** 文档格式的显示名：toast 里说「从 Word 抽出 1234 字」比说 docx 好懂。 */
const DOC_LABEL: Record<DocumentFormat, string> = { pdf: "PDF", docx: "Word", pptx: "PPT", xlsx: "Excel" };

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  /**
   * 「按会话」的背景覆盖：sessionId → 背景值。
   *
   * 存在 kv 里（和置顶同一套做法），不往 Session 协议、备份包里加字段；
   * 新会话查不到条目，就继承 settings.chatBackground。
   */
  const [sessionBgs, setSessionBgs] = useState<Record<string, string>>({});
  /** 外观页在等哪一张图：相册/拍照回来时要知道塞给头像还是背景。 */
  const [appearancePick, setAppearancePick] = useState<"avatar" | "background" | null>(null);
  /** 外观页的一句话回执（读图失败 / 这张太大）。 */
  const [appearanceNote, setAppearanceNote] = useState<string | null>(null);
  /** 已安装的主题包与当前生效的那个（B10）。空串 = 内置。 */
  const [themes, setThemes] = useState<InstalledThemeMeta[]>([]);
  const [activeTheme, setActiveTheme] = useState("");
  const [themeNote, setThemeNote] = useState<string | null>(null);
  const [themeBusy, setThemeBusy] = useState(false);
  /** 系统是不是深色。theme=system 时用它决定解析结果。 */
  const [systemDark, setSystemDark] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  /**
   * 开屏动画：播完（或失败兜底）之后卸掉。
   * 距上次开屏 <12 小时就直接不播（设计文档 §4.4）；后台切回不重播，见下面的 effect。
   */
  const [splashGone, setSplashGone] = useState(() => !shouldPlaySplash(loadSettings().lastSplashAt));
  /** 未接通：装好了、能打开，但没有可用 Key。只锁聊天，记忆 / 币 / 备份照常。 */
  const unconnected = !settings.apiKey.trim();
  // 稳定的回调：启动页退场那 450ms 里如果 App 重渲染，内联箭头会让计时器反复重置
  const hideSplash = useCallback(() => setSplashGone(true), []);
  const [session, setSession] = useState<Session | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  /** 置顶会话（顺序表，存在 kv 里；会话对象本身不带这个字段）。 */
  const [pinned, setPinned] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 报错统一走这里：接口吐回来的 JSON 先翻成人话再上屏。 */
  const reportError = useCallback((message: string | null) => {
    if (!message) {
      setError(null);
      return;
    }
    // 发送失败要能一眼看出「这句没出去」——humanizeError 会把前缀洗掉，这里补回来。
    const prefix = "没发出去：";
    if (message.startsWith(prefix)) {
      const detail = humanizeError(message.slice(prefix.length));
      const offline = /failed to fetch|fetch failed|networkerror|network request failed|load failed/i.test(detail);
      setError(prefix + (offline ? "网络不通，检查一下再点「重发」。" : detail || "这一轮没发出去。"));
      return;
    }
    setError(humanizeError(message));
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
  /**
   * 整屏页的骨架：布尔量换成页面栈（ADR-0002）。
   * 页面只认 route 名；返回键、通知深链、主题都从这一处走。
   */
  const pages = usePageStack();
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

  /** 待发的图是不是长图：是就裁成竖卡片，不然预览也只剩一条线。 */
  const [previewTall, setPreviewTall] = useState(false);
  const [stickers, setStickers] = useState<StickerRecord[]>([]);
  /** 表情面板：从输入框抽起来的一层 */
  const [showTray, setShowTray] = useState(false);
  /** 回形针面板：拍照 / 相册 / 文件，一层三选。和表情面板互斥，一次只抽一层。 */
  const [showAttach, setShowAttach] = useState(false);
  /** 消息菜单：当前展开的是哪一块（块索引）。 */
  const [menuIdx, setMenuIdx] = useState<number | null>(null);
  /** 离开聊天页的次数：「想」靠它重新挂载，回来时恢复收起。 */
  const [chatVisit, setChatVisit] = useState(0);
  /** 她找过我：会话 id → 标点时间。只存本机 kv，不写进会话对象（同置顶）。 */
  const [sought, setSought] = useState<Record<string, number>>({});
  const soughtRef = useRef<Record<string, number>>({});
  /** 相册：原生走相机插件的 Photos 源，浏览器退回文件选择。 */
  const albumInputRef = useRef<HTMLInputElement | null>(null);
  /** 可见性判断要读最新的抽屉状态。 */
  const drawerRef = useRef(false);
  /** 一句话的回执（「存进表情箱了」）。她看不到控制台，这种小事也得说一声。 */
  const [toast, setToast] = useState<string | null>(null);
  /** 回形针的「选文件」：现在什么都收，按类型分流（图片 / 文本 / 其它）。 */
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** 防重入：抽文档期间又选了一份，两份 buffer + 两份 pdf.js 文档同时进内存会卡死。 */
  const docBusyRef = useRef(false);
  /** 浏览器里没有相机插件：退回带 capture 的 file input（桌面浏览器会开文件选择）。 */
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  /** 黑塔币页：聊天之外的小模块，v1 只从抽屉进。 */
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
   * B10：启动时应用上次选的主题。
   * bootstrapTheme 会先校验主题包、再按「内置 → 主题 → 用户层」的顺序注入；
   * 若主题包坏了，它自己回滚到内置，不会把 App 卡在没有样式的状态。
   */
  useEffect(() => {
    let cancelled = false;
    void bootstrapTheme().then((snap) => {
      if (cancelled) return;
      setThemes(snap.themes);
      setActiveTheme(snap.activeId);
      if (snap.error) setThemeNote(snap.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 主题操作统一走这里：串行、失败只报一句人话，不拆界面。 */
  const runThemeAction = useCallback(async (action: () => Promise<ThemeSnapshot>) => {
    setThemeBusy(true);
    setThemeNote(null);
    try {
      const snap = await action();
      setThemes(snap.themes);
      setActiveTheme(snap.activeId);
      setThemeNote(snap.error);
    } catch (err) {
      setThemeNote(err instanceof Error ? err.message : String(err));
    } finally {
      setThemeBusy(false);
    }
  }, []);

  // 按会话的背景覆盖（kv）。读不到就当没有，全部走全局。
  useEffect(() => {
    void getKV<Record<string, string>>(SESSION_BACKGROUND_KEY)
      .then((stored) => {
        if (stored && typeof stored === "object" && !Array.isArray(stored)) setSessionBgs(stored);
      })
      .catch(() => undefined);
  }, []);

  /** 上一次的页面栈顶：从聊天页离开一次就加一，「想」回来时重新挂载成收起。 */
  const prevTopRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevTopRef.current === null && pages.top !== null) setChatVisit((v) => v + 1);
    prevTopRef.current = pages.top;
  }, [pages.top]);

  // 换会话 / 离开聊天页时，消息菜单自动收起。
  useEffect(() => {
    setMenuIdx(null);
  }, [session?.id, pages.top]);

  // 真播了才记「上次开屏时间」：被门控跳过的那次不算一次开屏。
  useEffect(() => {
    if (splashGone) return;
    setSettings((s) => ({ ...s, lastSplashAt: Date.now() }));
  }, [splashGone]);

  // 从后台切回不是冷启动：把开屏收掉，别再演一遍。
  // （WebView 被系统杀掉再拉起时算冷启动，那条路由上面的 12 小时门控管。）
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setSplashGone(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  /**
   * 系统返回键（ADR-0002）：页面栈先吃一层；栈空才交还系统。
   * 安卓的返回键在 Activity 层，JS 收不到——这里接 Capacitor App 插件，
   * 没装插件时退到 popstate（浏览器/dev）。
   */
  useEffect(
    () => connectSystemBack(() => pages.read().length > 0 && pages.back()),
    [pages.back, pages.read]
  );

  /**
   * B13「关于」组里的反馈：打开第三方表单（飞书），App 不收集、不经手提交内容。
   * 链接与网站同一行（site/assets/config.js 的 feedback）；万一以后被留空，
   * 退回「已知问题」页，不给死链（设计文档 §16.3）。
   */
  const openFeedback = useCallback(() => {
    const url = FEEDBACK_FORM_URL.trim();
    if (!url) {
      pages.push("issues");
      return;
    }
    void openLink(url).catch((openError) => {
      setError(openError instanceof Error ? openError.message : String(openError));
    });
  }, [pages]);

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
      // 深链统一走 route：通知点进来与点侧栏走的是同一条路
      pages.push(routeFromNotification("coin"));
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
      pages.push(routeFromNotification("broadcast"));
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
    pages.push("onboarding");
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    stickToBottom.current = true;
    setAtBottom(true);
  }, []);

  const onFeedScroll = useCallback(() => {
    // 翻历史时把消息菜单收掉：它属于某一条，不该跟着滚走
    setMenuIdx(null);
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

  /* ------------------------------------------------------ 她找过我（未读点） */

  useEffect(() => {
    drawerRef.current = drawer;
  }, [drawer]);

  // 跨重启保留：跟置顶一样只放 kv，会话对象与备份包一点不动。
  useEffect(() => {
    let alive = true;
    void getKV<Record<string, number>>("sessions.sought")
      .then((value) => {
        if (!alive || !value || typeof value !== "object") return;
        soughtRef.current = value;
        setSought(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const writeSought = useCallback((next: Record<string, number>) => {
    soughtRef.current = next;
    setSought(next);
    void setKV("sessions.sought", next).catch(() => undefined);
  }, []);

  const markSought = useCallback(
    (id: string) => {
      const current = soughtRef.current;
      if (current[id]) return;
      writeSought({ ...current, [id]: Date.now() });
    },
    [writeSought]
  );

  const markSessionRead = useCallback(
    (id: string | null | undefined) => {
      if (!id) return;
      const current = soughtRef.current;
      if (!(id in current)) return;
      const next = { ...current };
      delete next[id];
      writeSought(next);
    },
    [writeSought]
  );

  /** 会话被删了，未读点也得一起收掉——不然左栏那颗红点永远点不灭。 */
  const forgetSought = useCallback(
    (ids: string[]) => {
      const current = soughtRef.current;
      const next = { ...current };
      let changed = false;
      for (const id of ids) {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      }
      if (changed) writeSought(next);
    },
    [writeSought]
  );

  // 恢复备份、换机器之后，未读表里可能留着已经不存在的会话 id：顺手剪掉。
  useEffect(() => {
    if (sessions.length === 0) return;
    const alive = new Set(sessions.map((s) => s.id));
    const stale = Object.keys(sought).filter((id) => !alive.has(id));
    if (stale.length > 0) forgetSought(stale);
  }, [sessions, sought, forgetSought]);

  /**
   * 打开着聊天页、抽屉也关着，当前会话就算读过了。
   * 从后台回来（可见性变化）走下面那条监听。
   */
  useEffect(() => {
    if (!session?.id) return;
    if (pages.top !== null || drawer) return;
    if (document.visibilityState === "hidden") return;
    markSessionRead(session.id);
  }, [session?.id, pages.top, drawer, sought, markSessionRead]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (pages.read().length === 0 && !drawerRef.current) markSessionRead(sessionRef.current?.id);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [markSessionRead]);

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
        if (alive) setPinned(await loadPinnedSessions());

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
            markSessionRead(s.id);
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
    markSessionRead(fresh.id);
    setDrawer(false);
    await refreshList();
  }, [markSessionRead, refreshList]);

  const openSession = useCallback(
    async (id: string) => {
      const s = await loadSession(id);
      if (s) {
        setSession(s);
        markSessionRead(id);
        setDrawer(false);
      }
    },
    [markSessionRead]
  );

  const removeSession = useCallback(
    async (id: string) => {
      await deleteSession(id);
      forgetSought([id]);
      const rest = await listSessions();
      setSessions(rest);
      if (session?.id === id) {
        if (rest.length > 0) {
          const next = await loadSession(rest[0].id);
          setSession(next);
          markSessionRead(next?.id);
        } else {
          const fresh = createSession();
          await putSession(fresh);
          setSession(fresh);
          await refreshList();
        }
      }
    },
    [forgetSought, markSessionRead, refreshList, session?.id]
  );

  /** 重命名：只改标题；改的是当前会话就连页头一起换。 */
  const renameSessionTitle = useCallback(
    async (id: string, title: string) => {
      await renameSession(id, title);
      setSessions(await listSessions());
      if (session?.id === id) {
        setSession((cur) => (cur && cur.id === id ? { ...cur, title: title.trim() || cur.title } : cur));
      }
    },
    [session?.id]
  );

  /** 置顶只是这张顺序表；会话本身不变，备份包也不受影响。 */
  const togglePin = useCallback(
    async (id: string) => {
      const next = pinned.includes(id) ? pinned.filter((x) => x !== id) : [id, ...pinned];
      setPinned(next);
      await savePinnedSessions(next);
    },
    [pinned]
  );

  /** 多选删除：一次删干净，顺带把置顶表里已消失的 id 抹掉。 */
  const removeSessions = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      for (const id of ids) await deleteSession(id);
      forgetSought(ids);
      const rest = await listSessions();
      setSessions(rest);
      const nextPinned = pinned.filter((id) => !ids.includes(id));
      if (nextPinned.length !== pinned.length) {
        setPinned(nextPinned);
        await savePinnedSessions(nextPinned);
      }
      if (session && ids.includes(session.id)) {
        if (rest.length > 0) {
          const next = await loadSession(rest[0].id);
          setSession(next);
          markSessionRead(next?.id);
        } else {
          const fresh = createSession();
          await putSession(fresh);
          setSession(fresh);
          await refreshList();
        }
      }
    },
    [forgetSought, markSessionRead, pinned, refreshList, session]
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
  const { send, stop, busy, mood, moodAt, typing, regenerate, retry, failed } = useChatTurn({
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
    onNeedKey: () => pages.push("settings"),
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
    // 她主动 ping 落进会话的那一刻：你不在聊天页（或在后台）就亮「她找过我」。
    setSession: (next) => {
      setSession(next);
      const notThere =
        document.visibilityState !== "visible" || pages.read().length > 0 || drawerRef.current;
      if (notThere) markSought(next.id);
    },
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

  /** 侧栏四个入口：走页面栈；再点一次同一页就退回去。 */
  const openPage = useCallback(
    (target: "memory" | "broadcast" | "coin") => {
      if (pages.isTop(target)) pages.close(target);
      else pages.push(target);
    },
    [pages]
  );

  /** 回对话：清栈回到底，不新建会话。 */
  const showChat = useCallback(() => {
    pages.reset();
    setDrawer(false);
  }, [pages]);

  /** 从播报里点「让她再多说两句」：关页、回聊天、带引用发一句。 */
  const discussBroadcastItem = useCallback(
    (item: BroadcastItem) => {
      pages.close("broadcast");
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
        markSessionRead(newest.id);
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
    // 未接通：输入区本来就是引导态，这里只把她领到设置，不弹红字。
    if (!settings.apiKey.trim()) {
      pages.push("settings");
      return;
    }
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
  }, [draft, pendingImage, send, settings.apiKey]);

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
   * 相册。
   *
   * 原生用相机插件的 Photos 源（系统相册选择器）；浏览器里没有插件，退回
   * 只收图片的 file input。两种来源最后都进同一条看图管线。
   */
  const takeFromAlbum = useCallback(async () => {
    setShowAttach(false);
    // 聊天这条永远发图：外观页点过「相册自选」又取消时，别把待发状态留在这儿
    setAppearancePick(null);
    if (!isNative()) {
      albumInputRef.current?.click();
      return;
    }
    setImageBusy(true);
    try {
      let shot: { dataUrl?: string };
      try {
        shot = await Camera.getPhoto({
          quality: 85,
          resultType: CameraResultType.DataUrl,
          source: CameraSource.Photos,
          saveToGallery: false,
        });
      } catch (err) {
        // 取消不算错误；权限和「打不开」翻成人话
        const message = cameraFailureText(err);
        if (message) reportError(message.replace(/相机/g, "相册"));
        return;
      }
      if (!shot.dataUrl) {
        reportError("选了照片，但没读到图。");
        return;
      }
      let blob: Blob;
      try {
        blob = dataUrlToBlob(shot.dataUrl);
      } catch (err) {
        reportError("选了照片，但这张图读不出来：" + (err instanceof Error ? err.message : String(err)));
        return;
      }
      await ingestImage(blob, "相册照片");
    } finally {
      setImageBusy(false);
    }
  }, [ingestImage, reportError]);

  /* ------------------------------------------------------------ 外观 · 她的样子 */

  /** 选背景：作用域是全局就改全局，是按会话就写当前这一条（新会话没有条目 → 继承全局）。 */
  const applyBackground = useCallback(
    (value: string) => {
      if (settings.backgroundScope === "session" && session) {
        const next = { ...sessionBgs, [session.id]: value };
        setSessionBgs(next);
        void setKV(SESSION_BACKGROUND_KEY, next);
        return;
      }
      setSettings((s) => ({ ...s, chatBackground: value }));
    },
    [session, sessionBgs, settings.backgroundScope]
  );

  /**
   * 相册/相机来的一张图收成「当前的脸」或聊天背景。
   *
   * 图片先压再存：头像 320、背景 1080——设置是 localStorage，写爆了会静默丢。
   * 压完仍然过大就直说换一张，不做无提示的降级。
   */
  const applyAppearancePhoto = useCallback(
    async (blob: Blob, target: "avatar" | "background") => {
      const maxSide = target === "avatar" ? 320 : 1080;
      const quality = target === "avatar" ? 0.82 : 0.72;
      try {
        const file = new File([blob], target === "avatar" ? "face.jpg" : "background.jpg", {
          type: blob.type || "image/jpeg",
        });
        const { dataUrl } = await compressImage(file, maxSide, quality);
        const limit = target === "avatar" ? 400_000 : 1_400_000;
        if (dataUrl.length > limit) {
          setAppearanceNote(
            "这张压到 " + maxSide + " 像素还有 " + Math.round(dataUrl.length / 1024) + "KB，换一张小点的吧。"
          );
          return;
        }
        setAppearanceNote(null);
        if (target === "avatar") setSettings((s) => ({ ...s, avatar: dataUrl }));
        else applyBackground(dataUrl);
      } catch (err) {
        setAppearanceNote("这张没读进来：" + (err instanceof Error ? err.message : String(err)));
      }
    },
    [applyBackground]
  );

  /**
   * 外观页要一张图。
   *
   * 复用聊天那条相册管线：原生走 Camera 的 Photos 源，浏览器里点已有那个
   * albumInput（不在这里再开一个 file input）。回来时按 appearancePick 分流。
   */
  const pickAppearancePhoto = useCallback(
    async (target: "avatar" | "background") => {
      setAppearanceNote(null);
      setAppearancePick(target);
      if (!isNative()) {
        albumInputRef.current?.click();
        return;
      }
      try {
        let shot: { dataUrl?: string };
        try {
          shot = await Camera.getPhoto({
            quality: 90,
            resultType: CameraResultType.DataUrl,
            source: CameraSource.Photos,
            saveToGallery: false,
          });
        } catch (err) {
          const message = cameraFailureText(err);
          if (message) setAppearanceNote(message.replace(/相机/g, "相册"));
          return;
        }
        if (!shot.dataUrl) {
          setAppearanceNote("选了照片，但没读到图。");
          return;
        }
        await applyAppearancePhoto(dataUrlToBlob(shot.dataUrl), target);
      } catch (err) {
        setAppearanceNote("这张没读进来：" + (err instanceof Error ? err.message : String(err)));
      } finally {
        setAppearancePick(null);
      }
    },
    [applyAppearancePhoto]
  );

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

  /** 落盘后的全量同步进内存与界面：删完列表必须跟着变，不能各存一份。 */
  const applyReadableFiles = useCallback((list: { name: string; text: string }[]) => {
    filesRef.current.clear();
    for (const file of list) filesRef.current.set(file.name, file.text);
    setFileNames([...filesRef.current.keys()]);
  }, []);

  /** 单条删：她读过的文件不该只能增不能减。 */
  const removeReadableFileEntry = useCallback(
    async (name: string) => {
      try {
        applyReadableFiles(await removeReadableFile(name));
        setToast("已删掉「" + name + "」——她读不到了");
      } catch (e) {
        reportError("删不掉：" + (e instanceof Error ? e.message : String(e)));
      }
    },
    [applyReadableFiles, reportError]
  );

  /** 全清：一次把文件库清空。 */
  const clearReadableFilesEntry = useCallback(async () => {
    try {
      applyReadableFiles(await clearReadableFiles());
      setToast("文件都清掉了——她的书桌空了");
    } catch (e) {
      reportError("清不空：" + (e instanceof Error ? e.message : String(e)));
    }
  }, [applyReadableFiles, reportError]);

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
  /** 这条会话自己设过的背景（null = 没设过，继承全局）。 */
  const sessionBackground =
    session && Object.prototype.hasOwnProperty.call(sessionBgs, session.id) ? sessionBgs[session.id] : null;
  /** 现在该画哪张背景：会话覆盖 ?? 全局。"" = 不设。 */
  const chatBackground = backgroundOf(settings, sessionBackground);
  const chatBackgroundKind = backgroundKind(chatBackground);

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
      markSessionRead(sessionId);
      setPendingJump({ sessionId, index });
      setDrawer(false);
    },
    [markSessionRead]
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

  /**
   * 「想」是页边批注，不该占正文——默认收成一行「▸ 想了一下」。
   *
   * 用原生 details/summary：读屏、键盘、手套都能点到，不必再为它挂一层长按。
   * key 带 chatVisit：离开聊天页再回来时重新挂载，自动恢复收起。
   */
  const thoughtNote = (text: string, index: number) => (
    <details
      className="thought"
      data-part="message-thought"
      key={"thought-" + index + "-" + chatVisit}
      style={{ display: "block" }}
    >
      <summary
        style={{
          display: "block",
          cursor: "pointer",
          listStyle: "none",
          color: "var(--accent)",
          fontWeight: 600,
        }}
      >
        ▸ 想了一下
      </summary>
      <p style={{ margin: "6px 0 0" }}>{text}</p>
    </details>
  );

  /** 一条消息的正文：图在气泡里，字是字。 */
  const bodyOf = (b: UserBlock | HertaBlock, index: number) => {
    if (b.kind === "herta" && b.surface === "thought") return thoughtNote(b.text, index);
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
            onOpen={() => pages.push("shot", { pieces: (b.attachments ?? []).map((a) => a.data), name: att.name })}
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
        {actionText && <p className="action" data-part="message-actor">（{actionText}）</p>}
        {bodyText && <p>{bodyText}</p>}
        {b.kind === "herta" && b.surface === "speech" && b.usage && <UsageChip usage={b.usage} />}
      </>
    );
  };

  /** 复制一条消息：原生剪贴板优先，拿不到再退回临时 textarea。 */
  const copyMessage = useCallback(
    async (text: string) => {
      setMenuIdx(null);
      if (!text.trim()) return;
      try {
        await navigator.clipboard.writeText(text);
        flashToast("已复制");
        return;
      } catch {
        /* 某些 WebView 要用户手势才给剪贴板，退回老办法 */
      }
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
        flashToast("已复制");
      } catch {
        reportError("复制失败：这台设备的剪贴板没打开。");
      }
    },
    [flashToast, reportError]
  );

  /** 引用：原文塞进输入条，光标留在后面，接着写就行。 */
  const quoteMessage = useCallback((text: string) => {
    if (!text.trim()) return;
    setDraft((current) => (current.trim() ? "「" + text + "」\n" + current : "「" + text + "」\n"));
    setMenuIdx(null);
    setShowAttach(false);
    setShowTray(false);
    requestAnimationFrame(() => draftRef.current?.focus());
  }, []);

  /**
   * 重新生成这一条。
   *
   * 目标之后如果还有更晚的用户回合，先确认——那会连同后面的对话一起丢掉。
   * 最后一条不弹，长按一下就能重说。
   */
  const regenerateMessage = useCallback(
    async (startIndex: number, target: number) => {
      if (!session) return;
      let lastUser = -1;
      for (let k = session.blocks.length - 1; k >= 0; k -= 1) {
        const block = session.blocks[k];
        if (block.kind === "user" || (block.kind === "sticker" && block.from === "user")) {
          lastUser = k;
          break;
        }
      }
      if (lastUser > target && !window.confirm("重新生成这条，会丢掉它之后的对话。继续？")) return;
      setMenuIdx(null);
      await regenerate(startIndex);
    },
    [regenerate, session]
  );

  /**
   * 一条普通消息：气泡 + 长按菜单 + 常驻「⋯」按钮。
   *
   * 长按是主入口，但读屏与手套用户到不了长按——所以每条消息都留一个点得到的
   * 「⋯」，两个入口打开的是同一份菜单。
   */
  const messageRow = (b: UserBlock | HertaBlock, i: number, thought: HertaBlock | null, avatar: boolean) => {
    const raw = b.text ?? "";
    // 动作旁白（「（转了下椅子）她……」）在界面上是单独一行，复制时也只复制台词。
    const spoken = b.kind === "herta" && b.surface === "speech" ? raw.replace(/^（[^）]*）\s*/, "") : raw;
    const text = spoken.trim() ? spoken : raw;
    const isUser = b.kind === "user";
    const image = b.kind === "user" ? b.attachments?.[0] : undefined;
    const isMenu = menuIdx === i;
    // 重生成的起点：用户消息保留自己，重说它后面那一条；她的消息连同一块「想」一起重说。
    const startIndex = isUser ? i + 1 : thought ? i - 1 : i;
    // 用户发图时，长按归看图（存表情），别和消息菜单抢手势；这时菜单只走 ⋯。
    const canLongPress = !(isUser && (b.attachments?.length ?? 0) > 0);
    const press = canLongPress
      ? longPressProps(() => setMenuIdx((current) => (current === i ? null : i)))
      : null;
    const menuButtonStyle = {
      font: "inherit",
      fontSize: 11,
      lineHeight: 1.5,
      minHeight: 32,
      padding: "6px 12px",
      borderRadius: 999,
      border: "1px solid var(--line)",
      background: "var(--card)",
      color: "var(--ink)",
      cursor: "pointer",
    } as const;
    return (
      <Slot key={i} name="message" region={b.kind}>
      <div data-idx={i} data-part="message">
        <div className={"turn " + b.kind + (b.kind === "herta" ? " " + b.surface : "")}>
          {avatar && <img className="turnAvatar" src={faceSrc(settings)} data-herta-user="face" alt="" />}
          <article
            className={"bubble " + b.kind + (b.kind === "herta" ? " " + b.surface : "")}
            data-part="message-bubble"
            // 右侧要留出常驻的「⋯」按钮：不挤这一下，气泡会把它顶出屏幕
            style={{
              maxWidth: isUser ? "min(76%, calc(100% - 72px))" : "calc(100% - 74px)",
            }}
            {...(press ? press.props : {})}
          >
            {thought && thoughtNote(thought.text, i)}
            {bodyOf(b, i)}
            <span className="bubbleTime" data-part="message-time">{clockOf(b.at)}</span>
          </article>
          {isUser && <span className="userMark">你</span>}
          <button
            type="button"
            aria-label="消息操作"
            aria-haspopup="menu"
            aria-expanded={isMenu}
            onClick={() => setMenuIdx((current) => (current === i ? null : i))}
            style={{
              flex: "none",
              alignSelf: isUser ? "flex-end" : "flex-start",
              marginTop: isUser ? 0 : 4,
              width: 30,
              height: 30,
              padding: 0,
              border: "1px solid var(--line)",
              borderRadius: 999,
              background: "var(--card)",
              color: "var(--muted)",
              fontSize: 13,
              lineHeight: 1,
              cursor: "pointer",
            }}
          >
            ⋯
          </button>
        </div>
        {isMenu && (
          <div
            role="menu"
            aria-label="消息操作"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              margin: "3px 0 0",
              justifyContent: isUser ? "flex-end" : "flex-start",
              padding: isUser ? "0 34px 0 0" : "0 0 0 36px",
            }}
          >
            <button
              type="button"
              role="menuitem"
              style={menuButtonStyle}
              disabled={!text.trim()}
              onClick={() => void copyMessage(text)}
            >
              复制
            </button>
            <button
              type="button"
              role="menuitem"
              style={menuButtonStyle}
              disabled={!text.trim()}
              onClick={() => quoteMessage(text)}
            >
              引用
            </button>
            <button
              type="button"
              role="menuitem"
              style={menuButtonStyle}
              onClick={() => void regenerateMessage(startIndex, i)}
            >
              重新生成这一条
            </button>
            {image && (
              // 图片长按是「存进表情箱」：这里给它一条点得到的替代路径。
              <button
                type="button"
                role="menuitem"
                style={menuButtonStyle}
                onClick={() => {
                  setMenuIdx(null);
                  void saveToBox(image.data, image.name ?? "图", image.mediaType, [], "mine");
                }}
              >
                存进表情箱
              </button>
            )}
          </div>
        )}
      </div>
      </Slot>
    );
  };

  return (
    <div
      className={"app" + (chatBackgroundKind === "none" ? "" : " has-bg")}
      data-part="app"
      data-rail={settings.railCollapsed ? "collapsed" : "expanded"}
    >
      {!splashGone && (
        <Slot name="splash">
          <Splash onDone={hideSplash} />
        </Slot>
      )}

      {/* 聊天背景：一层底图 + 一层光罩（光罩在 CSS 里），消息永远在它上面。
          自定义图走 --herta-user-bg，让用户覆盖层能用 !important 保住它。 */}
      <div
        className="appBg"
        data-part="app-bg"
        data-herta-user="chat-bg"
        data-bg={chatBackgroundKind}
        aria-hidden="true"
        style={
          chatBackgroundKind === "custom"
            ? ({ "--herta-user-bg": 'url("' + chatBackground + '")' } as CSSProperties)
            : undefined
        }
      />

      {/* 桌面端那条侧栏的窄版：会话常驻，入口在底部 */}
      <Slot name="railTopbar" region="rail">
      <aside className="rail" data-part="rail" aria-label="侧栏">
        <button className="railMark" data-part="rail-item" type="button" onClick={() => setDrawer((v) => !v)} aria-label="会话">
          H
        </button>
        <button className="railNew" data-part="rail-item" type="button" onClick={() => void newSession()} aria-label="新对话">
          ＋
        </button>
        <nav className="railNav" aria-label="模块">
          <button
            type="button"
            data-part="rail-item"
            className={pages.canGoBack ? "" : "on"}
            onClick={showChat}
            aria-label={"对话" + (Object.keys(sought).length > 0 ? "（她找过你）" : "")}
          >
            <RailIcon d="M4 5.5h16v10.5H9l-5 4z" />
            {Object.keys(sought).length > 0 && (
              <span
                className="broadcastEntryDot"
                role="img"
                aria-label="她找过你"
                style={{ position: "absolute", top: 7, right: 7 }}
              />
            )}
          </button>
          <button type="button" data-part="rail-item" className={pages.isTop("memory") ? "on" : ""} onClick={() => openPage("memory")} aria-label="记忆">
            <RailIcon d="M8 4h8a2 2 0 0 1 2 2v14l-6-4-6 4V6a2 2 0 0 1 2-2Z" />
          </button>
          <button
            type="button"
            data-part="rail-item"
            className={pages.isTop("broadcast") ? "on" : ""}
            onClick={() => openPage("broadcast")}
            aria-label="播报"
          >
            <RailIcon d="M12 12h.01M8.6 15.4a4.8 4.8 0 0 1 0-6.8M15.4 8.6a4.8 4.8 0 0 1 0 6.8M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
          </button>
          <button type="button" data-part="rail-item" className={pages.isTop("coin") ? "on" : ""} onClick={() => openPage("coin")} aria-label="黑塔币">
            <RailIcon d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 8v8M9 10h4.5a1.5 1.5 0 0 1 0 3H9" />
          </button>
        </nav>
        <div className="railFoot">
          <button
            type="button"
            data-part="rail-item"
            className={pages.isTop("settings") ? "on" : ""}
            onClick={() => (pages.isTop("settings") ? pages.close("settings") : pages.push("settings"))}
            aria-label="设置"
          >
            <RailIcon d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 13a7.9 7.9 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.9 7.9 0 0 0-1.7-1L15 3.5h-4l-.3 2.5a7.9 7.9 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.9 7.9 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.9 7.9 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7.9 7.9 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6Z" />
          </button>
          <button type="button" data-part="rail-item" onClick={() => setDrawer((v) => !v)} aria-label="更多">
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
      </Slot>

      <section className="workspace">
      <Slot name="railTopbar" region="topbar">
      <header className="bar" data-part="topbar">
        <button className="iconBtn" type="button" onClick={() => setDrawer((v) => !v)} aria-label="会话">
          ☰
        </button>
        <div className="topTitle">
          <span className="topName">黑塔</span>
          <span className="topSub" data-part="presence">
            {presenceAt().phase} · {presenceAt().place}
          </span>
        </div>
        <button
          data-part="mood"
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
        <button className="topAvatarBtn" type="button" onClick={() => pages.push("settings")} aria-label="设置">
          <img src={faceSrc(settings)} data-herta-user="face" alt="" />
        </button>
      </header>
      </Slot>

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
          pinned={pinned}
          currentId={session?.id ?? null}
          filter={filter}
          onFilter={setFilter}
          memHits={memHits}
          sessHits={sessHits}
          memories={memories}
          showImport={showImport}
          importText={importText}
          importNote={importNote}
          importBusy={importBusy}
          shareInput={shareInput}
          nowLine={timePhrase() + " · 她在" + presenceAt().place}
          coinPct={coinPct}
          broadcastNo={broadcast.today?.no ?? null}
          broadcastUnread={broadcast.unread}
          sought={Object.keys(sought)}
          actions={{
            newSession: () => void newSession(),
            openSession: (id) => void openSession(id),
            removeSession: (id) => void removeSession(id),
            renameSession: (id, title) => void renameSessionTitle(id, title),
            togglePin: (id) => void togglePin(id),
            removeSessions: (ids) => void removeSessions(ids),
            jump: (sessionId, index) => void jumpTo(sessionId, index),
            openMemoryPage: () => {
              setDrawer(false);
              pages.push("memory");
            },
            openMemory: (record) => {
              setDrawer(false);
              pages.push("memoryDetail", record);
            },
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

      {/*
        整屏页：按栈的顺序渲染。压在下面的那页不卸载——
        关掉上面一层还能回到它原来的位置（设置 → 她能做什么 → 返回）。
      */}
      {pages.stack.map((entry, index) => {
        const key = entry.name + ":" + index;
        switch (entry.name) {
          case "coin":
            return (
              <CoinView
                // base 变了就重挂：设置里改接口地址后要重新拉，不用杀 app
                key={key + ":" + (coinBase || "coin-no-base")}
                base={coinBase}
                identity={settings.coinIdentity}
                onIdentityChange={(next) => setSettings({ ...settings, coinIdentity: next })}
                onClose={() => pages.close("coin")}
                onQuoteChange={(q) => setCoinPct(q ? q.market.changePct : null)}
              />
            );
          case "broadcast":
            return (
              <BroadcastView
                key={key}
                issues={broadcast.issues}
                today={broadcast.today}
                status={broadcast.status}
                error={broadcast.error}
                generating={broadcast.generating}
                config={broadcast.config}
                onClose={() => pages.close("broadcast")}
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
                onRefresh={() => void broadcast.refresh()}
                unconnected={unconnected}
              />
            );
          case "memory":
            return (
              <NmsScreen
                key={key}
                snapshot={nmsSnapshot}
                activationStore={nmsActivation}
                settings={settings}
                voice={voiceState}
                onSettingsChange={(patch) => setSettings({ ...settings, ...patch })}
                onRefresh={() => void refreshMemories()}
                onRewriteVoice={rewriteVoice}
                onChangeVoiceParams={(params) => void changeVoiceParams(params)}
                onRollbackVoice={(version) => void revertVoice(version)}
                memories={memories}
                onRemoveMemory={(name) => void removeMemory(name)}
                onDream={() => void (session && dreamNow(session, true))}
                onDistill={() => void (session && distillNow(session))}
                canDistill={(session?.blocks.length ?? 0) >= 12}
                dreaming={dreaming}
                distilling={distilling}
                distillNote={distillNote}
                onOpenGraph={() => pages.push("memoryGraph")}
                onClose={() => pages.close("memory")}
              />
            );
          case "memoryGraph":
            return (
              <GraphScreen
                key={key}
                snapshot={nmsSnapshot}
                activationStore={nmsActivation}
                onRefresh={() => void refreshMemories()}
                onClose={() => pages.close("memoryGraph")}
              />
            );
          case "memoryDetail": {
            const record = entry.param as MemoryRecord | undefined;
            if (!record) return null;
            return (
              <MemoryViewer
                key={key}
                record={record}
                onClose={() => pages.close("memoryDetail")}
                onDelete={(name) => {
                  pages.close("memoryDetail");
                  void removeMemory(name);
                }}
              />
            );
          }
          case "settings":
            return (
              <SettingsSheet
                key={key}
                settings={settings}
                onChange={(patch) => setSettings({ ...settings, ...patch })}
                onClose={() => pages.close("settings")}
                mood={mood}
                fileNames={fileNames}
                stickers={herStickers}
                onOpenCapabilities={() => pages.push("capabilities")}
                onOpenToolLog={() => pages.push("toolLog")}
                onOpenBackup={() => pages.push("backup")}
                onReplayOnboarding={() => {
                  pages.close("settings");
                  pages.push("onboarding");
                }}
                onOpenDesignSystem={() => pages.push("designSystem")}
                onOpenAppearance={() => pages.push("appearance")}
                onOpenTheme={() => pages.push("theme")}
                onOpenSponsors={() => pages.push("sponsors")}
                onOpenDevs={() => pages.push("devs")}
                onOpenIssues={() => pages.push("issues")}
                onOpenFeedback={openFeedback}
                themeName={themes.find((theme) => theme.id === activeTheme)?.name ?? "内置"}
              />
            );
          case "appearance":
            return (
              <AppearanceScreen
                key={key}
                settings={settings}
                onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
                onClose={() => {
                  setAppearanceNote(null);
                  setAppearancePick(null);
                  pages.close("appearance");
                }}
                sessionId={session?.id ?? null}
                sessionBackground={sessionBackground}
                onBackground={applyBackground}
                onPickPhoto={(target) => void pickAppearancePhoto(target)}
                picking={appearancePick}
                note={appearanceNote}
              />
            );
          case "theme":
            return (
              <ThemeScreen
                key={key}
                version={APP_VERSION}
                activeId={activeTheme}
                themes={themes}
                busy={themeBusy}
                note={themeNote}
                onInstallFile={(file) => {
                  void runThemeAction(async () => {
                    const bytes = new Uint8Array(await file.arrayBuffer());
                    return installThemeFromBytes(bytes);
                  });
                }}
                onInstallUrl={(url) => void runThemeAction(() => installThemeFromUrl(url))}
                onActivate={(id) => void runThemeAction(() => activateTheme(id))}
                onUninstall={(id) => void runThemeAction(() => uninstallTheme(id))}
                onClose={() => pages.close("theme")}
              />
            );
          case "onboarding":
            return (
              <Onboarding
                key={key}
                settings={settings}
                onChange={(patch) => setSettings({ ...settings, ...patch })}
                onOpenCapabilities={() => pages.push("capabilities")}
                onDone={() => {
                  localStorage.setItem("herta.onboarded.v1", "1");
                  pages.close("onboarding");
                }}
              />
            );
          case "toolLog":
            return <ToolLogSheet key={key} onClose={() => pages.close("toolLog")} />;
          case "designSystem":
            return <DesignSystemSheet key={key} onClose={() => pages.close("designSystem")} />;
          case "sponsors":
            return <SponsorsScreen key={key} onClose={() => pages.close("sponsors")} />;
          case "devs":
            return <DevsScreen key={key} onClose={() => pages.close("devs")} />;
          case "issues":
            return (
              <IssuesScreen
                key={key}
                onClose={() => pages.close("issues")}
                onOpenFeedback={openFeedback}
              />
            );
          case "backup":
            return (
              <BackupSheet
                key={key}
                settings={settings}
                onClose={() => pages.close("backup")}
                onRestored={() => {
                  void refreshList();
                  void refreshMemories();
                  void listStickers().then(setStickers);
                  void broadcast.refresh();
                }}
              />
            );
          case "capabilities":
            return (
              <CapabilitiesSheet
                key={key}
                settings={settings}
                onChange={(patch) => setSettings({ ...settings, ...patch })}
                fileNames={fileNames}
                onFile={(file) => ingestReadable(file)}
                onRemoveFile={(name) => void removeReadableFileEntry(name)}
                onClearFiles={() => void clearReadableFilesEntry()}
                stickers={herStickers}
                onAddStickers={(files) => void addStickers(files, "herta")}
                onRemoveSticker={(id) => void removeSticker(id)}
                onClose={() => pages.close("capabilities")}
              />
            );
          case "shot": {
            const shot = entry.param as { pieces: string[]; name?: string } | undefined;
            if (!shot) return null;
            return <ShotViewer key={key} pieces={shot.pieces} name={shot.name} onClose={() => pages.close("shot")} />;
          }
          default:
            return null;
        }
      })}

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

      {unconnected && (
        // 常驻提醒：跳过引导也能随时回到设置。样式借「离线条」那套（本批不动 styles.css）。
        <button
          type="button"
          className="coinOfflineBar"
          style={{ margin: "8px 12px 0", fontFamily: "inherit", fontSize: 12, textAlign: "left", cursor: "pointer" }}
          onClick={() => pages.push("settings")}
        >
          她还没接上，点这里填 Key
        </button>
      )}

      {/* 点聊天区就把附件面板收起来：它是冲着输入框来的，不该一直挂着 */}
      <main className="feed" data-part="feed" ref={feedRef} onScroll={onFeedScroll} onPointerDown={() => setShowAttach(false)}>
        {blocks.length === 0 && (
          <p className="empty" data-part="empty-state">{unconnected ? "她还没接上。填好 Key，她就会开口。" : "她还没开口。说点什么。"}</p>
        )}
        {blocks.length > 0 && (
          <div className="dayLine" data-part="day-divider">
            <span>今天</span>
          </div>
        )}

        {renderBlocks.map(({ b, i, thought }) => {
          if (b.kind === "system") {
            // 文件库事件只在「工具调用记录」里显示，聊天流里不刷屏；
            // 老版本写下的块没有 hidden 标记，按正文再认一遍（见 core 的 READABLE_FILE_EVENT_NOTE）
            if (b.hidden || READABLE_FILE_EVENT_NOTE.test(b.body) || LEGACY_TOOL_NOTE.test(b.body)) return null;
            return (
              <p key={i} className="note" data-part="message-note">
                {b.body}
              </p>
            );
          }
          if (b.kind === "sticker") {
            const rec = stickerById.get(b.stickerId);
            // 库被删了也留一行：历史不该因为一张表情没了就凭空少一段
            if (!rec) {
              return (
                <p key={i} className="note" data-part="message-note">
                  （表情已删：{b.name}）
                </p>
              );
            }
            const collect = () =>
              void saveToBox(rec.data, rec.name, rec.mediaType, rec.tags, b.from === "herta" ? "mine" : "herta");
            const press = longPressProps(collect);
            return (
              <Slot key={i} name="message" region="sticker">
              {/* 表情消息也要两个锚点：message 是容器，message-bubble 是气泡本体。
                  display:contents 让外层不参与 .feed 的 flex 排布。 */}
              <div data-part="message" style={{ display: "contents" }}>
              <article data-idx={i} data-part="message-bubble" className={"bubble stickerBubble " + b.from}>
                <img className="sticker" src={rec.data} alt={rec.name} title={rec.tags.join("、") || rec.name} {...press.props} />
                {/* 长按能收，但读屏/手套到不了长按：底下留一个点得到的同类动作 */}
                <button
                  type="button"
                  data-part="sticker-collect"
                  onClick={collect}
                  style={{
                    display: "block",
                    margin: "6px auto 0",
                    padding: "2px 6px",
                    border: 0,
                    background: "none",
                    color: "var(--muted)",
                    font: "inherit",
                    fontSize: 11,
                    lineHeight: 1.6,
                    cursor: "pointer",
                  }}
                >
                  {b.from === "herta" ? "存进表情箱" : "送给她"}
                </button>
              </article>
              </div>
              </Slot>
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
                  pages.push("broadcast");
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
            return messageRow(b, i, thought, true);
          }
          return messageRow(b, i, null, b.kind === "herta");
        })}
        {typing && <p className="note typing">她正在敲字…</p>}
        {error && (
          <div className="error" role="alert">
            <span>{error}</span>
            {failed && failed.sessionId === session?.id && (
              <button
                type="button"
                onClick={() => void retry()}
                style={{
                  marginLeft: 8,
                  padding: "2px 10px",
                  border: "1px solid currentColor",
                  borderRadius: 999,
                  background: "transparent",
                  color: "inherit",
                  font: "inherit",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                重发
              </button>
            )}
          </div>
        )}
        {toast && <p className="toast">{toast}</p>}
      </main>

      {!atBottom && (
        <button className="jump" onClick={() => scrollToBottom(true)} aria-label="回到最新">
          ↓ 最新
        </button>
      )}

      <Slot name="composer">
      <footer className="composer" data-part="composer">
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
        {/* 浏览器里的相册退路：只收图片；原生走 Camera 插件的 Photos 源 */}
        <input
          ref={albumInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            // 外观页借着同一个相册入口选头像/背景：选了就是换样子，不进聊天
            const target = appearancePick;
            setAppearancePick(null);
            if (!file) return;
            if (target) {
              void applyAppearancePhoto(file, target);
              return;
            }
            void ingestImage(file, file.name || "相册照片");
          }}
        />
        {!unconnected && (
          <div className="composerQuick">
            {!busy && blocks.length > 0 && (
              <button data-part="composer-action" className="composerRetract" onClick={() => void retract()} title="撤回上一轮">
                ↶ 撤回上一轮
              </button>
            )}
            <span>Enter 发送 · 长图自动切段</span>
          </div>
        )}

        {showAttach && (
          <AttachTray
            onCamera={() => void takePhoto()}
            onAlbum={() => void takeFromAlbum()}
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

        {unconnected ? (
          <button
            type="button"
            data-part="composer-action"
            className="composerBar"
            style={{ font: "inherit", fontSize: 13, color: "var(--muted)", textAlign: "left", cursor: "pointer" }}
            onClick={() => pages.push("settings")}
          >
            她还没接上，点这里填 Key —— 接上就能说话了
          </button>
        ) : (
        <div className="composerBar">
          <textarea
            data-part="composer-input"
            ref={draftRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="给黑塔发消息…"
            rows={1}
            // 点正文就把附件面板与消息菜单收起来：它们已经不需要了
            onFocus={() => {
              setShowAttach(false);
              setMenuIdx(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                dispatch();
              }
            }}
          />
          <button
            data-part="composer-action"
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
            data-part="composer-action"
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
            <button data-part="composer-action" className="composerSend stopping" onClick={stop} aria-label="打断">
              <span className="stopMark" />
            </button>
          ) : (
            <button
              data-part="composer-action"
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
        )}
        <div className="composerFoot">
          <span>她的手机 · 本机模型调用</span>
          <span>{settings.model}</span>
        </div>
      </footer>
      </Slot>
      </section>
    </div>
  );
}
