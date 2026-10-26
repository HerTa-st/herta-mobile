import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Block } from "@herta/protocol";
import {
  REVIEW_POLICY,
  buildReviewMessages,
  buildStaticPrefix,
  decideReview,
  parseSupervisorVerdict,
  parseTagged,
  serializeRecord,
  vetoHints,
  type ChatMessage,
} from "@herta/core";
import { listOpenings, pickOpening, type Opening } from "@herta/core";
import { BrowserAssetSource } from "./assets-browser.ts";
import { playVoice, stopVoice } from "./voice.ts";
import { loadPromptCode } from "./prompts.ts";
import { loadSettings, saveSettings, type Settings } from "./settings.ts";
import { pickTransport } from "./transport.ts";

const assets = new BrowserAssetSource();
const transport = pickTransport();

const at = () => new Date().toISOString();

/** 把一条流拼成整段：复核必须看完整句，不能看半截。 */
async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const piece of gen) out += piece;
  return out;
}

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [opening, setOpening] = useState<Opening | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => saveSettings(settings), [settings]);

  // 每次打开都是一个新的开场：桌面版也是这个规矩。
  // 只在挂载时跑一次——重渲染不该让她重说一遍。
  useEffect(() => {
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
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (!settings.apiKey) {
      setError("先填 API Key。她不会替你保管，只存在这台手机上。");
      setShowSettings(true);
      return;
    }
    setError(null);
    setBusy(true);
    setDraft("");

    const userBlock: Block = { kind: "user", text, at: at() };
    const history: Block[] = [...blocks, userBlock];
    setBlocks(history);

    const ctl = new AbortController();
    abort.current = ctl;

    const base = {
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      signal: ctl.signal,
    };

    try {
      const promptAssets = await assets.promptAssets();
      const prefix = buildStaticPrefix({ assets: promptAssets, seeds: [] });
      const mainMessages: ChatMessage[] = [
        { role: "system", content: prefix },
        { role: "user", content: serializeRecord(history, { maxBlocks: settings.contextBlocks }) },
      ];

      // 第一趟：她说。边流边显示，但不解析——半截标签解析出来是错的。
      let raw = "";
      for await (const piece of transport.stream({ ...base, messages: mainMessages, maxTokens: 2048 })) {
        raw += piece;
        const live = parseTagged(raw, "speech");
        if (live) setBlocks([...history, { kind: "herta", surface: "speech", text: live, at: at() }]);
      }

      let thought = parseTagged(raw, "thought");
      let speech = parseTagged(raw, "speech");
      const out: Block[] = [...history];
      if (thought) out.push({ kind: "herta", surface: "thought", text: thought, at: at() });

      // 第二趟：她自己回头看这句话。这是桌面版最像她的一环。
      const code = await loadPromptCode();
      const hints = vetoHints(promptAssets.hints, null);
      for (let attempt = 0; attempt < REVIEW_POLICY.maxRetries; attempt += 1) {
        const verdictRaw = await collect(
          transport.stream({
            ...base,
            messages: buildReviewMessages(
              {
                feianFewShots: [],
                lang: "zh",
                currentState: "默认",
                recentRecord: history,
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

        out.push({ kind: "system", label: "系统", body: "复核打回：" + (verdict.reason ?? ""), at: at() });
        setBlocks([...out, { kind: "herta", surface: "speech", text: speech, at: at() }]);

        const redo = await collect(
          transport.stream({
            ...base,
            messages: [...mainMessages, { role: "user", content: hints.respeak || hints.veto }],
            maxTokens: 2048,
          })
        );
        thought = parseTagged(redo, "thought") || thought;
        speech = parseTagged(redo, "speech") || speech;
      }

      out.push({ kind: "herta", surface: "speech", text: speech, at: at() });
      setBlocks(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBlocks(history);
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }, [blocks, busy, draft, settings]);

  const stop = useCallback(() => abort.current?.abort(), []);
  const visible = useMemo(() => blocks, [blocks]);

  return (
    <div className="app">
      <header className="bar">
        <span className="title">Herta</span>
        <span className={"tag " + (transport.name === "native" ? "ok" : "warn")}>
          {transport.name === "native" ? "原生通道" : "浏览器通道"}
        </span>
        <button className="link" onClick={() => setShowSettings((v) => !v)}>
          设置
        </button>
      </header>

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
            带多少条历史
            <input
              type="number"
              value={settings.contextBlocks}
              onChange={(e) => setSettings({ ...settings, contextBlocks: Number(e.target.value) || 24 })}
            />
          </label>
        </div>
      )}

      <main className="feed">
        {visible.length === 0 && opening && (
          <article className="bubble herta speech opening">
            <p>{opening.speech}</p>
            {opening.audio && (
              <button className="play" onClick={() => void playVoice(opening.audio as string)}>
                ▶ 听这一段
              </button>
            )}
          </article>
        )}
        {visible.length === 0 && !opening && <p className="empty">她还没开口。说点什么。</p>}
        {visible.map((b, i) =>
          b.kind === "system" ? (
            <p key={i} className="note">{b.body}</p>
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
        {busy ? <button onClick={stop}>打断</button> : <button onClick={() => void send()} disabled={!draft.trim()}>说</button>}
      </footer>
    </div>
  );
}
