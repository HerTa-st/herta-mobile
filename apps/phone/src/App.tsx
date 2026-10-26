import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Block, ImportBundle, Session } from "@herta/protocol";
import {
  createSession,
  effectiveWeight,
  listOpenings,
  memoryTitle,
  parseImportBundle,
  parseSharedConversation,
  pickOpening,
  planImport,
  presenceAt,
  retractLastTurn,
  searchMemories,
  searchSessions,
  shareIdFromInput,
  shouldConsolidate,
  shouldForget,
  SHARE_API,
  timePhrase,
  type MemoryRecord,
  type Opening,
} from "@herta/core";
import { BrowserAssetSource } from "./assets-browser.ts";
import { Drawer } from "./components/Drawer.tsx";
import { GraphView } from "./components/GraphView.tsx";
import { MemoryViewer } from "./components/MemoryViewer.tsx";
import { SettingsSheet } from "./components/SettingsSheet.tsx";
import { useChatTurn } from "./hooks/useChatTurn.ts";
import { captionImage, compressImage } from "./vision.ts";
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
import { loadSettings, saveSettings, type Settings } from "./settings.ts";
import { pickTransport } from "./transport.ts";
import { loadPromptCode } from "./prompts.ts";
import { synthesize } from "./tts.ts";
import { playVoice, stopVoice } from "./voice.ts";

const assets = new BrowserAssetSource();
const transport = pickTransport();
const memoryStore = new IdbMemoryStore();

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [session, setSession] = useState<Session | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
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
  } = useMemory(settings, { onError: setError });
  const [showSettings, setShowSettings] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [opening, setOpening] = useState<Opening | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importNote, setImportNote] = useState<string | null>(null);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [pendingJump, setPendingJump] = useState<{ sessionId: string; index: number } | null>(null);
  const [pendingImage, setPendingImage] = useState<{ mediaType: string; data: string; name: string; caption: string } | null>(
    null
  );
  const [imageBusy, setImageBusy] = useState(false);
  const [stickers, setStickers] = useState<StickerRecord[]>([]);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [viewing, setViewing] = useState<MemoryRecord | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  const [shareInput, setShareInput] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const dreamingRef = useRef(false);
  /** 用户手动选给她读的文件：工具只能读这里，不能自己翻磁盘。 */
  const filesRef = useRef(new Map<string, string>());
  const feedRef = useRef<HTMLElement | null>(null);
  /** 用户是不是"贴着底部"。他往上一翻就松手，不再跟着新消息跑。 */
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => saveSettings(settings), [settings]);

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

  /* 开场独白只在「空会话」上出现，且换会话时重新挑一篇。 */
  useEffect(() => {
    if (!session || session.blocks.length > 0) {
      setOpening(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const [a, v] = await Promise.all([assets.promptAssets(), assets.voice()]);
        const picked = pickOpening(listOpenings(a.openings ?? {}, v));
        if (alive) setOpening(picked);
      } catch {
        /* 素材没进来就不开场，别把启动挡住 */
      }
    })();
    return () => {
      alive = false;
      stopVoice();
    };
  }, [session?.id, session?.blocks.length]);


  const newSession = useCallback(async () => {
    const fresh = createSession();
    await putSession(fresh);
    setSession(fresh);
    setOpening(null);
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

  /** 一个回合的全过程都在这里：判心情、算行踪、带工具说话、复核、落库。 */
  const { send, stop, busy, mood } = useChatTurn({
    settings,
    session,
    setSession,
    persist,
    memories,
    dreamState,
    files: filesRef.current,
    stickers,
    onError: setError,
    onNeedKey: () => setShowSettings(true),
  });

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

  /** 往表情库里加图：压到 512，文件名当标签。 */
  const addStickers = useCallback(async (files: FileList) => {
    for (const file of Array.from(files)) {
      try {
        const { dataUrl, mediaType } = await compressImage(file, 512, 0.85);
        await putSticker({
          id: crypto.randomUUID(),
          name: file.name.replace(/\.[^.]+$/, ""),
          tags: [],
          data: dataUrl,
          mediaType,
          createdAt: new Date().toISOString(),
        });
      } catch (e) {
        setError("这张表情没加进去：" + (e instanceof Error ? e.message : String(e)));
      }
    }
    setStickers(await listStickers());
  }, []);

  const removeSticker = useCallback(async (id: string) => {
    await deleteSticker(id);
    setStickers(await listStickers());
  }, []);

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
          text
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
    setDraft("");
    setPendingImage(null);
    void send(text, img ? [{ mediaType: img.mediaType, data: img.data, name: img.name }] : undefined);
  }, [draft, pendingImage, send]);

  const blocks = useMemo(() => session?.blocks ?? [], [session]);

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
  const showOpening = blocks.length === 0 && opening !== null;

  return (
    <div className="app">
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
          mood={mood}
          fileNames={fileNames}
          stickers={stickers}
          onAddStickers={(files) => void addStickers(files)}
          onRemoveSticker={(id) => void removeSticker(id)}
          onFile={(file) => {
            void file.text().then((text) => {
              filesRef.current.set(file.name, text);
              setFileNames([...filesRef.current.keys()]);
            });
          }}
        />
      )}

      <main className="feed" ref={feedRef} onScroll={onFeedScroll}>
        {showOpening && opening && (
          <article className="bubble herta speech opening">
            <p>{opening.speech}</p>
            {opening.audio && (
              <button className="play" onClick={() => void playVoice(opening.audio as string)}>
                ▶ 听这一段
              </button>
            )}
          </article>
        )}
        {blocks.length === 0 && !opening && <p className="empty">她还没开口。说点什么。</p>}

        {blocks.map((b, i) =>
          b.kind === "system" ? (
            <p key={i} className="note">
              {b.body}
            </p>
          ) : (
            <article key={i} data-idx={i} className={"bubble " + b.kind + (b.kind === "herta" ? " " + b.surface : "")}>
              {b.kind === "user" && b.attachments && b.attachments.length > 0 && (
                <img className="shot" src={b.attachments[0].data} alt={b.attachments[0].name ?? "图"} />
              )}
              {b.kind === "herta" && b.attachments && b.attachments.length > 0 && (
                <img className="sticker" src={b.attachments[0].data} alt={b.attachments[0].name ?? "表情"} />
              )}
              {b.kind === "herta" && b.surface === "speech" && settings.ttsEnabled && (
                <button className="say" onClick={() => void speakBlock(b.text)} title="用她的声音念出来">
                  ▶ 念
                </button>
              )}
              {b.kind === "herta" && b.surface === "thought" ? (
                <details>
                  <summary>想法</summary>
                  <p>{b.text}</p>
                </details>
              ) : (
                <p>{b.text}</p>
              )}
            </article>
          )
        )}
        {error && <p className="error">{error}</p>}
      </main>

      {!atBottom && (
        <button className="jump" onClick={() => scrollToBottom(true)} aria-label="回到最新">
          ↓ 最新
        </button>
      )}

      <footer className="composer">
        {pendingImage && (
          <div className="shotPreview">
            <img src={pendingImage.data} alt="待发送的图" />
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
                const { dataUrl, mediaType } = await compressImage(file);
                let caption = "";
                if (settings.visionModel) {
                  caption = await captionImage(
                    transport,
                    { apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.visionModel },
                    dataUrl
                  );
                }
                setPendingImage({ mediaType, data: dataUrl, name: file.name, caption });
              } catch (err) {
                setError("这张图没看明白：" + (err instanceof Error ? err.message : String(err)));
              } finally {
                setImageBusy(false);
              }
            })();
          }}
        />
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="跟她说点什么"
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              dispatch();
            }
          }}
        />
        <button
          className="ghost"
          onClick={() => imageInputRef.current?.click()}
          disabled={imageBusy}
          title="给她看一张图"
        >
          {imageBusy ? "…" : "🖼"}
        </button>
        <button className="ghost" onClick={() => void retract()} disabled={busy || blocks.length === 0} title="撤回上一轮">
          ↶
        </button>
        {busy ? (
          <button onClick={stop}>打断</button>
        ) : (
          <button onClick={dispatch} disabled={!draft.trim() && !pendingImage}>
            说
          </button>
        )}
      </footer>
    </div>
  );
}
