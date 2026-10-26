import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Block, ChatDelta, ImportBundle, Session } from "@herta/protocol";
import {
  REVIEW_POLICY,
  appendBlocks,
  buildReviewMessages,
  buildStaticPrefix,
  buildVoiceRevisionPrompt,
  buildMoodPrompt,
  buildPresenceNote,
  cleanVoiceText,
  consolidateMemories,
  DEFAULT_MOOD,
  moodStyleNote,
  parseMood,
  presenceAt,
  timePhrase,
  createSession,
  distillSession,
  effectiveWeight,
  extractJson,
  forgetMemories,
  shouldConsolidate,
  shouldForget,
  decideReview,
  listOpenings,
  memoryTitle,
  parseNarrative,
  parseSupervisorVerdict,
  pickOpening,
  parseImportBundle,
  parseSharedConversation,
  pickSeeds,
  planImport,
  retractLastTurn,
  shareIdFromInput,
  SHARE_API,
  runDreamPass,
  runToolLoop,
  searchMemories,
  searchSessions,
  serializeRecord,
  trimForContext,
  vetoHints,
  voiceTextOf,
  type ChatMessage,
  type DreamState,
  type MemoryRecord,
  type Opening,
} from "@herta/core";
import { BrowserAssetSource } from "./assets-browser.ts";
import { MemoryGraph } from "./MemoryGraph.tsx";
import { buildTools } from "./devtools.ts";
import { IdbMemoryStore } from "./memory-idb.ts";
import { deleteSession, listSessions, loadSession, putSession, type SessionMeta } from "./storage.ts";
import { loadSettings, saveSettings, type Settings } from "./settings.ts";
import { pickTransport } from "./transport.ts";
import { loadPromptCode } from "./prompts.ts";
import { playVoice, stopVoice } from "./voice.ts";

const assets = new BrowserAssetSource();
const transport = pickTransport();
const memoryStore = new IdbMemoryStore();

/** 把一条流拼成整段正文。工具调用那些增量不算正文。 */
async function collect(gen: AsyncGenerator<ChatDelta>): Promise<string> {
  let out = "";
  for await (const d of gen) if (d.type === "text") out += d.text;
  return out;
}

/** 工具名 → 说人话的标签，给聊天里的"系统"块用。 */
const TOOL_LABEL: Record<string, string> = {
  now: "看了时间",
  clipboard: "动了剪贴板",
  calc: "算了一下",
  web_search: "上网查了",
  device: "看了手机状态",
  read_file: "读了文件",
};

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [session, setSession] = useState<Session | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [opening, setOpening] = useState<Opening | null>(null);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [dreamState, setDreamState] = useState<DreamState | null>(null);
  const [dreaming, setDreaming] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importNote, setImportNote] = useState<string | null>(null);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [mood, setMood] = useState<string>(DEFAULT_MOOD);
  const [filter, setFilter] = useState("");
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [pendingJump, setPendingJump] = useState<{ sessionId: string; index: number } | null>(null);
  const [viewing, setViewing] = useState<MemoryRecord | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  const [maintaining, setMaintaining] = useState<string | null>(null);
  const [shareInput, setShareInput] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [distillNote, setDistillNote] = useState<string | null>(null);
  const distillingRef = useRef(false);
  const abort = useRef<AbortController | null>(null);
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
        if (alive) {
          setMemories(await memoryStore.list());
          setDreamState(await memoryStore.state());
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

  const removeMemory = useCallback(async (name: string) => {
    await memoryStore.remove(name);
    setMemories(await memoryStore.list());
  }, []);

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

  /** 语气重写：读她最近的记忆，写一段「我说话是什么样」。做梦和消化共用这一个实现。 */
  const reviseVoiceImpl = useCallback(
    async (records: MemoryRecord[], previous: string | null) => {
      const { system, user } = buildVoiceRevisionPrompt(records, previous);
      const raw = await collect(
        transport.stream({
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          maxTokens: 800,
        })
      );
      return cleanVoiceText(raw);
    },
    [settings.apiKey, settings.baseUrl, settings.model]
  );

  /**
   * 做梦。`force` 是手动点按钮时给的：绕过"材料够不够 / 隔了多久"两道门槛，
   * 但拦不住"值不值得记"——那道门是她自己的判断，不该被按钮跳过。
   */
  const dreamNow = useCallback(
    async (target: Session, force = false) => {
      if (dreamingRef.current || !settings.apiKey) return;
      if (!target.blocks.length) return;
      dreamingRef.current = true;
      setDreaming(true);
      try {
        const [promptAssets, code] = await Promise.all([assets.promptAssets(), loadPromptCode()]);
        const outcome = await runDreamPass(
          {
            store: memoryStore,
            prompts: code,
            scene: { env: buildPresenceNote(presenceAt(), timePhrase()), lang: "zh" },
        // 攒够记忆就让她重读自己、重写语气笔记——这是"语气会变"的唯一来源
        reviseVoice: reviseVoiceImpl,
            chat: ({ system, user, maxTokens }) =>
              collect(
                transport.stream({
                  apiKey: settings.apiKey,
                  baseUrl: settings.baseUrl,
                  model: settings.model,
                  messages: system
                    ? [
                        { role: "system", content: system },
                        { role: "user", content: user },
                      ]
                    : [{ role: "user", content: user }],
                  maxTokens,
                })
              ),
            now: () => Date.now(),
          },
          {
            sessionId: target.id,
            blocks: target.blocks,
            config: force ? { minNewBlocks: 2, minGapMs: 0 } : undefined,
          }
        );
        if (outcome.kind === "made") {
          setMemories(await memoryStore.list());
        }
        setDreamState(await memoryStore.state());
      } catch (e) {
        setError("做梦失败：" + (e instanceof Error ? e.message : String(e)));
      } finally {
        dreamingRef.current = false;
        setDreaming(false);
      }
    },
    [reviseVoiceImpl, settings.apiKey, settings.baseUrl, settings.model]
  );

  /**
   * 把一整段长对话消化成记忆。
   * 与做梦的区别：不问她"值不值得记"——你已经明确说了要记，那道门就不该拦。
   */
  const distillNow = useCallback(
    async (target: Session) => {
      if (distillingRef.current || !settings.apiKey) return;
      if (target.blocks.length < 12) {
        setDistillNote("这段太短了，直接点「让她做梦」就行。");
        return;
      }
      distillingRef.current = true;
      setDistilling(true);
      setDistillNote("开始整理…");
      try {
        const [promptAssets, code] = await Promise.all([assets.promptAssets(), loadPromptCode()]);
        const chunks = Math.min(12, Math.max(2, Math.round(target.blocks.length / 40)));
        const out = await distillSession(
          {
            store: memoryStore,
            prompts: code,
            scene: { env: buildPresenceNote(presenceAt(), timePhrase()), lang: "zh" },
            chat: ({ system, user, maxTokens }) =>
              collect(
                transport.stream({
                  apiKey: settings.apiKey,
                  baseUrl: settings.baseUrl,
                  model: settings.model,
                  messages: system
                    ? [
                        { role: "system", content: system },
                        { role: "user", content: user },
                      ]
                    : [{ role: "user", content: user }],
                  maxTokens,
                })
              ),
            now: () => Date.now(),
            reviseVoice: reviseVoiceImpl,
          },
          {
            sessionId: target.id,
            blocks: target.blocks,
            config: { chunks, minBlocksPerChunk: 6 },
          },
          (done, total, note) => setDistillNote(note + "（" + done + "/" + total + "）")
        );
        setMemories(await memoryStore.list());
        setDreamState(await memoryStore.state());
        setDistillNote(
          "整理完了：写了 " +
            out.made.length +
            " 则记忆" +
            (out.failed ? "，" + out.failed + " 段没写成" : "") +
            (out.voiceUpdated ? "，语气笔记也重写了" : "")
        );
      } catch (e) {
        setDistillNote("没整理成：" + (e instanceof Error ? e.message : String(e)));
      } finally {
        distillingRef.current = false;
        setDistilling(false);
      }
    },
    [reviseVoiceImpl, settings.apiKey, settings.baseUrl, settings.model]
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

  /**
   * 记忆的日常维护：到 20 条整理一次（关联 / 简化 / 加深），到 50 条忘掉最轻的 10 条。
   * 两个动作都只在跨过阈值时发生，平时什么都不做。
   */
  const maintainMemories = useCallback(async () => {
    if (maintaining) return;
    try {
      const state = await memoryStore.state();
      const records = await memoryStore.list();
      const active = records.filter((r) => !r.forgotten);

      if (shouldForget(active.length)) {
        setMaintaining("记忆太多了，正在忘掉最轻的十条…");
        const victims = await forgetMemories(memoryStore, Date.now());
        const st = await memoryStore.state();
        await memoryStore.saveState({
          ...st,
          forgottenTotal: (st.forgottenTotal ?? 0) + victims.length,
          lastNote: "忘掉了 " + victims.length + " 条（最轻的）",
        });
      }

      const latest = await memoryStore.state();
      if (shouldConsolidate(active.length, latest.lastConsolidatedCount ?? null)) {
        setMaintaining("记忆攒到 " + active.length + " 条了，正在整理…");
        const code = await loadPromptCode();
        const out = await consolidateMemories(
          {
            store: memoryStore,
            chat: ({ system, user, maxTokens }) =>
              collect(
                transport.stream({
                  apiKey: settings.apiKey,
                  baseUrl: settings.baseUrl,
                  model: settings.model,
                  messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                  ],
                  maxTokens,
                })
              ),
            now: () => Date.now(),
          },
          extractJson
        );
        const st = await memoryStore.state();
        await memoryStore.saveState({
          ...st,
          lastConsolidatedCount: active.length,
          lastNote: "整理了 " + out.touched + " 条：" + out.plan.links.length + " 条关联，" +
            out.plan.simplify.length + " 条简化，" + out.plan.deepen.length + " 条加深",
        });
      }

      setMemories(await memoryStore.list());
      setDreamState(await memoryStore.state());
    } catch (e) {
      setDistillNote("记忆维护没做完：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setMaintaining(null);
    }
  }, [maintaining, settings.apiKey, settings.baseUrl, settings.model]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy || !session) return;
    if (!settings.apiKey) {
      setError("先填 API Key。她不会替你保管，只存在这台手机上。");
      setShowSettings(true);
      return;
    }
    setError(null);
    setBusy(true);
    setDraft("");

    const userBlock: Block = { kind: "user", text, at: new Date().toISOString() };
    const history = appendBlocks(session, [userBlock]);
    setSession(history);
    void persist(history);

    const ctl = new AbortController();
    abort.current = ctl;

    const base = {
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      signal: ctl.signal,
    };

    let raw = "";
    try {
      const promptAssets = await assets.promptAssets();
      // 这一轮用哪几篇记忆：开局定死，想 / 说 / 复核共用同一批（否则三趟看到的她不一样）。
      const pool = memories.map((m) => ({ file: m.name, body: m.body }));
      const seeds = pickSeeds(pool, text, settings.memorySeeds);
      const context = trimForContext(history.blocks, settings.contextBlocks);

      // 先判心情：一次十几个 token 的调用，换来她这一轮的语气基线不一样。
      // 判定失败就按默认走——心情不该成为整轮对话的单点故障。
      let thisMood = DEFAULT_MOOD;
      if (settings.moodEnabled) {
        try {
          const pack = await assets.mood();
          if (pack) {
            const p = buildMoodPrompt(pack, serializeRecord(trimForContext(history.blocks, 12), { maxBlocks: 0 }));
            const answer = await collect(
              transport.stream({
                ...base,
                messages: [
                  { role: "system", content: p.system },
                  { role: "user", content: p.user },
                ],
                maxTokens: 12,
              })
            );
            thisMood = parseMood(answer, pack.moods);
          }
        } catch {
          thisMood = DEFAULT_MOOD;
        }
        setMood(thisMood);
      }

      const styleNote = settings.moodEnabled ? moodStyleNote(promptAssets, thisMood) : null;
      // 她此刻在哪：按钟点算，同一天同一时段固定，隔天才换。
      const presenceNote = buildPresenceNote(presenceAt(), timePhrase());
      const prefix = buildStaticPrefix({
        assets: promptAssets,
        seeds,
        voiceText: voiceTextOf(dreamState),
        presence: presenceNote,
        extraNotes: styleNote ? ["〔旁注：" + styleNote + "〕"] : [],
      });
      const mainMessages: ChatMessage[] = [
        { role: "system", content: prefix },
        // 已经按整轮边界截过了，序列化层不要再截一次——那会从她话中间切开。
        { role: "user", content: serializeRecord(context, { maxBlocks: 0 }) },
      ];

      // 带上她的手：她可以在这一轮里自己决定查时间、搜网、算一段、读文件。
      const tools = buildTools({
        transport,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        files: filesRef.current,
      });
      const toolNotes: Block[] = [];

      const loop = await runToolLoop(
        {
          tools,
          stream: (r) =>
            transport.stream({
              apiKey: settings.apiKey,
              baseUrl: settings.baseUrl,
              model: settings.model,
              messages: r.messages,
              tools: r.tools,
              maxTokens: r.maxTokens,
              signal: ctl.signal,
            }),
          onText: (piece) => {
            raw += piece;
            const live = parseNarrative(raw).speech;
            if (!live) return;
            setSession({
              ...history,
              blocks: [
                ...history.blocks,
                ...toolNotes,
                { kind: "herta", surface: "speech", text: live, at: new Date().toISOString() },
              ],
            });
          },
          onToolResult: (result) => {
            const note: Block = {
              kind: "system",
              label: "系统",
              body:
                "（" +
                (TOOL_LABEL[result.name] ?? "用了 " + result.name) +
                "：" +
                String(result.content).replace(/\s+/g, " ").slice(0, 140) +
                "）",
              at: new Date().toISOString(),
            };
            toolNotes.push(note);
            setSession({ ...history, blocks: [...history.blocks, ...toolNotes] });
          },
        },
        mainMessages
      );
      raw = loop.text;

      const parsed = parseNarrative(raw);
      let thought = parsed.thought;
      let speech = parsed.speech;

      const code = settings.reviewEnabled ? await loadPromptCode() : null;
      const hints = vetoHints(promptAssets.hints, null);
      let withRedos = history;

      for (let attempt = 0; code && attempt < REVIEW_POLICY.maxRetries; attempt += 1) {
        const verdictRaw = await collect(
          transport.stream({
            ...base,
            messages: buildReviewMessages(
              {
                feianFewShots: [],
                lang: "zh",
                currentState: thisMood,
                recentRecord: trimForContext(history.blocks, 12),
                currentTurnThought: thought,
                candidateSpeech: speech,
              },
              code
            ),
            maxTokens: 400,
          })
        );
        const verdict = parseSupervisorVerdict(verdictRaw);
        if (decideReview(verdict, attempt, speech) === "pass") break;

        withRedos = appendBlocks(withRedos, [
          {
            kind: "system",
            label: "系统",
            body: "她打回了上一句：" + (verdict.reason ?? ""),
            at: new Date().toISOString(),
          },
        ]);

        const redo = await collect(
          transport.stream({
            ...base,
            messages: [...mainMessages, { role: "user", content: hints.respeak || hints.veto }],
            maxTokens: 2048,
          })
        );
        const again = parseNarrative(redo);
        thought = again.thought || thought;
        // 重说没给出完整的「说」就别拿旧的顶上去——那正是被打回的那句。
        speech = again.speech || speech;
      }

      const tail: Block[] = [
        // 先把这一轮她用过的工具记下来：她"查过什么"本身也是上下文
        ...toolNotes,
      ];
      if (thought) tail.push({ kind: "herta", surface: "thought", text: thought, at: new Date().toISOString() });
      if (speech) tail.push({ kind: "herta", surface: "speech", text: speech, at: new Date().toISOString() });

      const final = appendBlocks(withRedos, tail);
      setSession(final);
      await persist(final);

      // 说完才做梦：材料是这一轮结束后的整条会话，不等用户再操作。
      void dreamNow(final);
    } catch (e) {
      if (ctl.signal.aborted) {
        // 打断不是错误：留下已经说出口的半句，别把红字糊她脸上。
        const partial = parseNarrative(raw).speech;
        const kept = partial ? appendBlocks(history, [{ kind: "herta", surface: "speech", text: partial, at: new Date().toISOString() }]) : history;
        setSession(kept);
        await persist(kept);
      } else {
        setError(e instanceof Error ? e.message : String(e));
        setSession(history);
        await persist(history);
      }
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }, [busy, draft, dreamNow, memories, persist, session, settings]);

  const stop = useCallback(() => abort.current?.abort(), []);

  const retract = useCallback(async () => {
    if (!session || busy) return;
    const cut = retractLastTurn(session);
    setSession(cut);
    await persist(cut);
  }, [busy, persist, session]);

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
        <div className="drawer">
          <button className="new" onClick={() => void newSession()}>
            ＋ 新的对话
          </button>
          <p className="nowLine">
            {timePhrase()} · 她在{presenceAt().place}
          </p>
          <input
            className="filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜记忆和对话…"
          />
          {filter.trim() ? (
            <div className="results">
              <p className="rsum">
                {filter.trim()} · 记忆 {memHits.length} · 对话 {sessHits.length}
              </p>
              {memHits.map((h) => {
                const rec = memories.find((m) => m.name === h.name);
                return (
                  <button
                    key={"m" + h.name}
                    className="rhit"
                    onClick={() => {
                      if (rec) setViewing(rec);
                      setDrawer(false);
                    }}
                  >
                    <span className="rt">{h.title}</span>
                    <span className="rs">{h.snippet}</span>
                  </button>
                );
              })}
              {sessHits.map((h) =>
                (h.hits.length > 0 ? h.hits : [{ index: 0, snippet: "标题命中" }]).map((hit, k) => (
                  <button
                    key={"s" + h.sessionId + k}
                    className="rhit"
                    onClick={() => void jumpTo(h.sessionId, hit.index)}
                  >
                    <span className="rt">
                      {h.title}
                      <em>第 {hit.index + 1} 块</em>
                    </span>
                    <span className="rs">{hit.snippet}</span>
                  </button>
                ))
              )}
              {memHits.length === 0 && sessHits.length === 0 && <p className="rsum">没找到。</p>}
            </div>
          ) : (
          <ul>
            {sessions.map((s) => (
              <li key={s.id} className={s.id === session?.id ? "on" : ""}>
                  <button className="row" onClick={() => void openSession(s.id)}>
                    <span className="st">{s.title}</span>
                    <span className="sm">{s.origin === "import" ? "导入" : s.blocks + " 块"}</span>
                  </button>
                  <button className="del" onClick={() => void removeSession(s.id)} aria-label="删除">
                    ✕
                  </button>
                </li>
              ))}
            {sessions.length === 0 && <li className="none">还没有别的对话</li>}
          </ul>
          )}

          <div className="mem">
            <div className="memHead">
              <span>记忆 {memories.filter((m) => !m.forgotten).length} 篇</span>
              {dreamState?.forgottenTotal ? <span className="sm">已忘 {dreamState.forgottenTotal}</span> : null}
              <button className="mgraph" onClick={() => setShowGraph(true)} disabled={memories.length === 0}>
                星图
              </button>
            </div>
            {maintaining && <p className="memNote">{maintaining}</p>}
            {dreamState?.lastNote && <p className="memNote">{dreamState.lastNote}</p>}
            <button className="dream" onClick={() => void (session && dreamNow(session, true))} disabled={dreaming || distilling}>
              {dreaming ? "她正在想…" : "让她做梦"}
            </button>
            <button
              className="dream"
              onClick={() => void (session && distillNow(session))}
              disabled={dreaming || distilling || (session?.blocks.length ?? 0) < 12}
            >
              {distilling ? "正在整理这段对话…" : "把这段对话整理成记忆"}
            </button>
            {distillNote && <p className="memNote">{distillNote}</p>}
            <ul className="memList">
              {[...memories]
                .filter((m) => !m.forgotten)
                .reverse()
                .map((m) => (
                <li key={m.name}>
                  <span className="mw">{effectiveWeight(m, Date.now()).toFixed(2)}</span>
                  <button className="mt" onClick={() => setViewing(m)} title={memoryTitle(m)}>
                    {memoryTitle(m)}
                  </button>
                  {(m.links?.length ?? 0) > 0 && <span className="ml">↔{m.links?.length}</span>}
                  <button className="mx" onClick={() => void removeMemory(m.name)} aria-label="删掉这条记忆">
                    ✕
                  </button>
                </li>
              ))}
              {memories.length === 0 && <li className="none">记忆库是空的</li>}
            </ul>
            {dreamState?.voice ? (
              <details className="voice">
                <summary>她写字的样子（{dreamState.voice.basis} 篇记忆之后）</summary>
                <p>{dreamState.voice.text}</p>
              </details>
            ) : (
              <p className="memNote">她还没写过自己说话的样子——攒够三篇记忆就会写第一版。</p>
            )}
          </div>

          <div className="imp">
            <button className="impToggle" onClick={() => setShowImport((v) => !v)}>
              {showImport ? "收起导入" : "导入 DeepSeek 对话"}
            </button>
            {showImport && (
              <>
                <p className="impHelp">
                  最省事的是**分享链接**：在 DeepSeek 里打开那条对话 → 分享 → 创建链接 → 把链接贴到下面。
                  接口是公开的，不需要登录，链接用完可以在 DeepSeek 里删掉。
                </p>
                <div className="shareRow">
                  <input
                    value={shareInput}
                    onChange={(e) => setShareInput(e.target.value)}
                    placeholder="https://chat.deepseek.com/share/…"
                  />
                  <button onClick={() => void importFromLink()} disabled={importBusy || !shareInput.trim()}>
                    {importBusy ? "取…" : "取"}
                  </button>
                </div>
                <p className="impHelp">也可以用油猴脚本导出 JSON，把内容贴进来（或选文件）。</p>
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void file.text().then((t) => {
                      setImportText(t);
                      setImportNote("读到了 " + file.name + "，点下面「导进来」");
                    });
                  }}
                />
                <textarea
                  className="impBox"
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder='{"format":"herta-import","version":1,...}'
                  rows={4}
                />
                <button className="impGo" onClick={() => void runImport()} disabled={!importText.trim()}>
                  导进来
                </button>
                {importNote && <p className="impNote">{importNote}</p>}
              </>
            )}
          </div>
        </div>
      )}

      {showGraph && (
        <div className="viewer graph" role="dialog" aria-label="记忆星图">
          <header className="vh">
            <span className="vt">记忆星图 · {graph.nodes.length} 条</span>
            <button className="vx" onClick={() => setShowGraph(false)}>
              关闭
            </button>
          </header>
          <MemoryGraph
            nodes={graph.nodes}
            edges={graph.edges}
            onOpen={(name) => {
              const rec = memories.find((m) => m.name === name);
              if (rec) setViewing(rec);
            }}
          />
          <p className="glegend">
            圆越大 = 权重越高。线 = 她自己串的关联。**拖动会拉开，松手会荡回去**；双指缩放，空白处拖动平移；点圆看全文。
          </p>
        </div>
      )}

      {viewing && (
        <div className="viewer" role="dialog" aria-label="记忆全文">
          <header className="vh">
            <span className="vt">{memoryTitle(viewing)}</span>
            <button className="vx" onClick={() => setViewing(null)}>
              关闭
            </button>
          </header>
          <p className="vmeta">
            {viewing.createdAt ? new Date(viewing.createdAt).toLocaleDateString("zh-CN") : "更早"}
            {viewing.sessionId ? " · 从对话里长出来的" : " · 自带的种子"}
            {viewing.tag ? " · " + viewing.tag : ""}
          </p>
          <pre className="vbody">{viewing.body}</pre>
          <footer className="vf">
            <button
              className="vdel"
              onClick={() => {
                const name = viewing.name;
                setViewing(null);
                void removeMemory(name);
              }}
            >
              删掉这条
            </button>
          </footer>
        </div>
      )}

      {showSettings && (
        <div className="sheet">
          <label>
            API Key
            <input
              type="password"
              value={settings.apiKey}
              onChange={(e) => setSettings({ ...settings, apiKey: e.target.value.trim() })}
              placeholder="sk-..."
            />
          </label>
          <label>
            Base URL
            <input value={settings.baseUrl} onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value.trim() })} />
          </label>
          <label>
            模型
            <input value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value.trim() })} />
          </label>
          <label>
            带多少块历史
            <input
              type="number"
              value={settings.contextBlocks}
              onChange={(e) => setSettings({ ...settings, contextBlocks: Number(e.target.value) || 24 })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.moodEnabled}
              onChange={(e) => setSettings({ ...settings, moodEnabled: e.target.checked })}
            />
            <span>每轮先判心情（现在是：{mood}）</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.reviewEnabled}
              onChange={(e) => setSettings({ ...settings, reviewEnabled: e.target.checked })}
            />
            <span>说完先让她自己复核（关掉每轮省一次调用）</span>
          </label>
          <label>
            给她读的文件
            <input
              type="file"
              accept=".txt,.md,.json,.csv,.log,text/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void file.text().then((text) => {
                  filesRef.current.set(file.name, text);
                  setFileNames([...filesRef.current.keys()]);
                });
              }}
            />
          </label>
          <p className="memNote">
            {fileNames.length > 0 ? "她能读：" + fileNames.join("、") : "还没给她文件。只能读你在这里选的，不能自己翻手机。"}
          </p>
        </div>
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
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="跟她说点什么"
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="ghost" onClick={() => void retract()} disabled={busy || blocks.length === 0} title="撤回上一轮">
          ↶
        </button>
        {busy ? <button onClick={stop}>打断</button> : <button onClick={() => void send()} disabled={!draft.trim()}>说</button>}
      </footer>
    </div>
  );
}
