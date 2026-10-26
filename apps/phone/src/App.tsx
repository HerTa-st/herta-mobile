import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Block, Session } from "@herta/protocol";
import {
  REVIEW_POLICY,
  appendBlocks,
  buildReviewMessages,
  buildStaticPrefix,
  createSession,
  decideReview,
  listOpenings,
  memoryTitle,
  parseNarrative,
  parseSupervisorVerdict,
  pickOpening,
  parseImportBundle,
  pickSeeds,
  planImport,
  retractLastTurn,
  runDreamPass,
  serializeRecord,
  trimForContext,
  vetoHints,
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
  const abort = useRef<AbortController | null>(null);
  const dreamingRef = useRef(false);

  useEffect(() => saveSettings(settings), [settings]);

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
            scene: { env: promptAssets.envSet, guide: promptAssets.hertaGuide, lang: "zh" },
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

  /** 导入：校验 → 去重 → 只写新的。永远不覆盖已有会话。 */
  const runImport = useCallback(async () => {
    const parsed = parseImportBundle(importText);
    if (!parsed.ok) {
      setImportNote("没导进来：" + parsed.error);
      return;
    }
    const existing = new Set((await listSessions()).map((s) => s.id));
    const plan = planImport(parsed.bundle, existing);
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
    }
  }, [importText, refreshList]);

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
      const prefix = buildStaticPrefix({ assets: promptAssets, seeds });
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
          </div>

          <div className="imp">
            <button className="impToggle" onClick={() => setShowImport((v) => !v)}>
              {showImport ? "收起导入" : "导入 DeepSeek 对话"}
            </button>
            {showImport && (
              <>
                <p className="impHelp">
                  在电脑上用油猴脚本导出 JSON，把内容贴进来（或选文件）。导入的是原文归档，不会直接变成她的记忆——
                  记忆要经过做梦。
                </p>
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

      <main className="feed">
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
