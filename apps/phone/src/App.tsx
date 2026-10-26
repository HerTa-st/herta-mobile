import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Block, ImportBundle, Session } from "@herta/protocol";
import {
  REVIEW_POLICY,
  appendBlocks,
  buildReviewMessages,
  buildStaticPrefix,
  buildVoiceRevisionPrompt,
  cleanVoiceText,
  createSession,
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
import { IdbMemoryStore } from "./memory-idb.ts";
import { deleteSession, listSessions, loadSession, putSession, type SessionMeta } from "./storage.ts";
import { loadSettings, saveSettings, type Settings } from "./settings.ts";
import { pickTransport } from "./transport.ts";
import { loadPromptCode } from "./prompts.ts";
import { playVoice, stopVoice } from "./voice.ts";

const assets = new BrowserAssetSource();
const transport = pickTransport();
const memoryStore = new IdbMemoryStore();

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const piece of gen) out += piece;
  return out;
}

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
  const [filter, setFilter] = useState("");
  const [shareInput, setShareInput] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const dreamingRef = useRef(false);
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
        // 记忆库：第一次启动时把随包的 13 篇废案种子搬进来。
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
            scene: { env: promptAssets.envSet, lang: "zh" },
        // 攒够记忆就让她重读自己、重写语气笔记——这是"语气会变"的唯一来源
        reviseVoice: async (records, previous) => {
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
    [settings.apiKey, settings.baseUrl, settings.model]
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
      const prefix = buildStaticPrefix({ assets: promptAssets, seeds, voiceText: voiceTextOf(dreamState) });
      const mainMessages: ChatMessage[] = [
        { role: "system", content: prefix },
        // 已经按整轮边界截过了，序列化层不要再截一次——那会从她话中间切开。
        { role: "user", content: serializeRecord(context, { maxBlocks: 0 }) },
      ];

      for await (const piece of transport.stream({ ...base, messages: mainMessages, maxTokens: 2048 })) {
        raw += piece;
        const live = parseNarrative(raw).speech;
        if (live) {
          setSession({
            ...history,
            blocks: [...history.blocks, { kind: "herta", surface: "speech", text: live, at: new Date().toISOString() }],
          });
        }
      }

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
                currentState: "默认",
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

      const tail: Block[] = [];
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
          <input
            className="filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={sessions.length > 8 ? "找对话…" : ""}
          />
          <ul>
            {sessions
              .filter((s) => !filter.trim() || s.title.includes(filter.trim()))
              .map((s) => (
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

          <div className="mem">
            <div className="memHead">
              <span>记忆 {memories.length} 篇</span>
              {dreamState?.made ? <span className="sm">自己造的 {dreamState.made}</span> : null}
            </div>
            {dreamState?.lastNote && <p className="memNote">{dreamState.lastNote}</p>}
            <button className="dream" onClick={() => void (session && dreamNow(session, true))} disabled={dreaming}>
              {dreaming ? "她正在想…" : "让她做梦"}
            </button>
            <ul className="memList">
              {memories
                .slice(-8)
                .reverse()
                .map((m) => (
                  <li key={m.name}>{memoryTitle(m)}</li>
                ))}
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
              checked={settings.reviewEnabled}
              onChange={(e) => setSettings({ ...settings, reviewEnabled: e.target.checked })}
            />
            <span>说完先让她自己复核（关掉每轮省一次调用）</span>
          </label>
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
            <article key={i} className={"bubble " + b.kind + (b.kind === "herta" ? " " + b.surface : "")}>
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
