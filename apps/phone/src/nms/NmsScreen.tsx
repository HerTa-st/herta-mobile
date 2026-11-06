/**
 * NMS 记忆页：网络 / 列表 / 设置三个 tab。
 *
 * 网络视图直接复用 nms/network/NetworkView（桌面移植）；列表与设置用手机原生组件。
 * 数据全部来自本地 NmsStore.snapshot()，不依赖 /nms/api。
 */
import { useEffect, useMemo, useState } from "react";
import { normalizeVoiceSchema } from "@herta/nms";
import type { NmsSnapshot, VoiceParams, VoiceState } from "@herta/nms";
import type { MemoryRecord } from "@herta/core";
import { memoryTitle } from "@herta/core";
import type { Settings } from "../settings.ts";
import type { NmsActivationStore } from "./network/activation.ts";
import { NetworkView } from "./network/network-view.tsx";
import { TIER_ORDER } from "./network/normalize.ts";
import { NMS_TIER_THEME } from "./network/network-canvas.tsx";
import { runMobileDeepSleep } from "./deep-sleep-runner.ts";
import { runManualLightSleep } from "./controller.ts";
import "../styles/nms.css";

export interface NmsScreenProps {
  snapshot: NmsSnapshot | null;
  activationStore: NmsActivationStore;
  settings: Settings;
  voice: VoiceState | null;
  onSettingsChange(patch: Partial<Settings>): void;
  onRefresh(): void;
  onRewriteVoice(): Promise<boolean>;
  onChangeVoiceParams(params: VoiceParams): void;
  onRollbackVoice(version: number): void;
  /** 她记住的文件（抽屉搬过来的：删除 / 整理 / 做梦都在这页）。 */
  memories: MemoryRecord[];
  onRemoveMemory(name: string): void;
  onDream(): void;
  onDistill(): void;
  canDistill: boolean;
  dreaming: boolean;
  distilling: boolean;
  distillNote: string | null;
  onClose(): void;
}

type Tab = "network" | "list" | "settings";

function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function NmsScreen({
  snapshot,
  activationStore,
  settings,
  voice,
  onSettingsChange,
  onRefresh,
  onRewriteVoice,
  onChangeVoiceParams,
  onRollbackVoice,
  memories,
  onRemoveMemory,
  onDream,
  onDistill,
  canDistill,
  dreaming,
  distilling,
  distillNote,
  onClose,
}: NmsScreenProps) {
  const [tab, setTab] = useState<Tab>("network");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<"deep" | "light" | "">("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  /** 连点 ± 时先改本地，600ms 后再落一版（避免每一下都造一个快照）。 */
  const [draftParams, setDraftParams] = useState<VoiceParams | null>(null);
  const [note, setNote] = useState("");
  const voiceSchema = useMemo(() => normalizeVoiceSchema(), []);

  const nodes = snapshot?.nodes ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q.length === 0 ? nodes : nodes.filter((node) => (node.title + " " + node.gist).toLowerCase().includes(q));
    return [...list].sort((a, b) => b.effectiveWeight - a.effectiveWeight);
  }, [nodes, query]);

  async function rewriteVoiceNow() {
    if (voiceBusy) return;
    setVoiceBusy(true);
    setNote("重写语气中：她重读最近几篇记忆…");
    try {
      const ok = await onRewriteVoice();
      setNote(ok ? "语气重写好了" : "语气没写成：看上面那条提示");
      onRefresh();
    } finally {
      setVoiceBusy(false);
    }
  }

  useEffect(() => {
    setDraftParams(null);
  }, [voice?.version]);

  function changeParam(key: string, value: number | string) {
    const baseParams = draftParams ?? voice?.params;
    if (!voice || !baseParams) return;
    const next = { ...baseParams, [key]: value };
    setDraftParams(next);
    onChangeVoiceParams(next);
  }

  async function runDeep() {
    setBusy("deep");
    setNote("深睡中：pending → 语义化 → 建边…");
    try {
      const result = await runMobileDeepSleep({ settings });
      setNote(result.ok ? "深睡完成" : "深睡未完成：" + result.error);
      onRefresh();
    } finally {
      setBusy("");
    }
  }

  async function runLight() {
    setBusy("light");
    setNote("浅睡中：去重 / 衰减 / 剪边…");
    try {
      const result = await runManualLightSleep();
      setNote(result.ok ? "浅睡完成" : "浅睡失败：" + result.error);
      onRefresh();
    } finally {
      setBusy("");
    }
  }

  const stats = snapshot?.stats;
  const tierCounts = stats?.nodes.byTier ?? { ep: 0, sem: 0, note: 0 };
  const topNodes = [...filtered].slice(0, 5);
  const lastSleep = stats?.dreams.lastAt
    ? new Date(stats.dreams.lastAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
    : "--";

  return (
    <div className="nmsPage" data-part="panel">
      <header className="nmsHead">
        <div className="nmsTitle">
          <b>记忆</b>
          <span>NMS · {stats?.nodes.total ?? nodes.length} 节点 · {stats?.edges.total ?? 0} 边</span>
        </div>
        <div className="nmsTabs" role="tablist">
          {(["network", "list", "settings"] as Tab[]).map((key) => (
            <button
              key={key}
              type="button"
              className={"nmsTab" + (tab === key ? " on" : "")}
              onClick={() => setTab(key)}
            >
              {key === "network" ? "网络" : key === "list" ? "列表" : "设置"}
            </button>
          ))}
        </div>
        <button type="button" className="nmsClose" onClick={onClose} aria-label="关闭记忆">
          ✕
        </button>
      </header>

      <div className="nmsScroll">
        {tab === "network" ? (
          <>
            <section className="nmsNetCard">
              <div className="nmsNetWrap">
                <NetworkView snapshot={snapshot} activationStore={activationStore} onRefresh={onRefresh} safeArea={false} />
              </div>
              <div className="nmsStats">
                <div><b>{stats?.nodes.active ?? 0}</b><span>活跃</span></div>
                <div><b>{stats?.nodes.archived ?? 0}</b><span>已压缩</span></div>
                <div><b>{tierCounts.ep} / {tierCounts.sem} / {tierCounts.note}</b><span>情景 / 语义 / 语气</span></div>
                <div><b>{lastSleep}</b><span>上次睡眠</span></div>
              </div>
            </section>

            <div className="nmsSleepRow">
              <button type="button" onClick={() => void runLight()} disabled={busy !== ""}>
                {busy === "light" ? "浅睡中…" : "浅睡"}
              </button>
              <button type="button" className="nmsSleepPrimary" onClick={() => void runDeep()} disabled={busy !== "" || !settings.nmsDeepSleepEnabled}>
                {busy === "deep" ? "深睡中…" : "深睡"}
              </button>
              <span>cap {settings.nmsNightCap} / 晚</span>
            </div>
            {note ? <p className="nmsNote">{note}</p> : null}

            <section className="nmsListCard">
              <div className="nmsCardHead">
                <h3>最近被想起</h3>
                <button type="button" onClick={() => setTab("list")}>列表 →</button>
              </div>
              {topNodes.length > 0 ? (
                topNodes.map((node) => (
                  <div key={node.id} className="nmsNodeRow">
                    <span className={"nmsTier " + node.tier}>{NMS_TIER_THEME[node.tier].name}</span>
                    <span className="nmsNodeMain">
                      <b>{node.title}</b>
                      <small>{node.gist}</small>
                    </span>
                    <span className="nmsNodeWeight">
                      {node.effectiveWeight.toFixed(2)}
                      <i><em style={{ width: Math.round(node.effectiveWeight * 100) + "%" }} /></i>
                    </span>
                  </div>
                ))
              ) : (
                <p className="nmsEmpty">记忆库还是空的。睡一觉之后，新的情景会出现在这里。</p>
              )}
            </section>

            <div className="nmsVoiceCard">
              <div className="nmsCardHead">
                <h3>她写字的样子</h3>
                <span>{voice ? "v" + voice.version : "还没生成"}</span>
              </div>
              {voice ? (
                <p className="nmsVoiceExcerpt">{voice.profile}</p>
              ) : (
                <p className="nmsVoiceExcerpt">
                  还没生成过。深睡出新记忆后会自己重写，也可以在「设置」里点一次；在那之前用的是冻结的旧语气。
                </p>
              )}
              <button type="button" className="nmsCardAction" onClick={() => setTab("settings")}>
                去「语气」重写
              </button>
            </div>
            <p className="nmsHint">深睡只在有 Key、有网、前台或保活时 opportunistic 跑；cap {settings.nmsNightCap}/晚。</p>
          </>
        ) : null}

        {tab === "list" ? (
          <div className="nmsListTab">
            <input
              className="nmsSearch"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜节点标题 / 要点…"
            />
            {TIER_ORDER.map((tier) => {
              const list = filtered.filter((node) => node.tier === tier);
              if (list.length === 0) return null;
              return (
                <section key={tier} className="nmsTierGroup">
                  <h3>{NMS_TIER_THEME[tier].name} · {list.length}</h3>
                  {list.map((node) => (
                    <div key={node.id} className="nmsNodeCard">
                      <div className="nmsNodeTop">
                        <strong>{node.title}</strong>
                        <span>{node.effectiveWeight.toFixed(2)}</span>
                      </div>
                      {node.gist ? <p>{node.gist}</p> : null}
                    </div>
                  ))}
                </section>
              );
            })}
            {filtered.length === 0 ? <p className="nmsEmpty" data-part="empty-state">还没有记忆。睡一觉之后，新的情景会出现在这里。</p> : null}

            <section className="nmsTierGroup">
              <h3>她记住的文件 · {memories.filter((m) => !m.forgotten).length}</h3>
              {memories.filter((m) => !m.forgotten).length === 0 ? (
                <p className="nmsEmpty">还没有。聊几轮、睡一觉，或者回聊天页点「把这段对话整理成记忆」。</p>
              ) : (
                [...memories]
                  .filter((m) => !m.forgotten)
                  .reverse()
                  .map((m) => (
                    <div key={m.name} className="nmsNodeCard">
                      <div className="nmsNodeTop">
                        <strong>{memoryTitle(m)}</strong>
                        <button
                          type="button"
                          className="nmsNodeDelete"
                          style={{ border: 0, background: "none", padding: 0, font: "inherit", fontSize: 9, color: "var(--muted)", cursor: "pointer" }}
                          onClick={() => onRemoveMemory(m.name)}
                          aria-label={"删掉「" + memoryTitle(m) + "」"}
                        >
                          删掉
                        </button>
                      </div>
                      <p>{(m.body ?? "").slice(0, 80)}{(m.body ?? "").length > 80 ? "…" : ""}</p>
                    </div>
                  ))
              )}
            </section>
          </div>
        ) : null}

        {tab === "settings" ? (
          <>
          <section className="nmsSettingGroup">
            <div className="nmsCardHead">
              <h3>梦境</h3>
              <span>上次 {lastSleep}</span>
            </div>
            <label className="nmsCheck">
              <input
                type="checkbox"
                checked={settings.autoDream}
                onChange={(e) => onSettingsChange({ autoDream: e.target.checked })}
              />
              <span>我走开之后她自己做梦（关掉就只有下面这几个手动按钮）</span>
            </label>
            <label className="nmsCheck">
              <input
                type="checkbox"
                checked={settings.nmsDeepSleepEnabled}
                onChange={(e) => onSettingsChange({ nmsDeepSleepEnabled: e.target.checked })}
              />
              <span>深睡（有网 + Key 时，空闲后整理情景为语义；每晚会调模型）</span>
            </label>
            <label className="nmsField">
              深睡每晚调用上限（0 = 关，默认 8）
              <input
                type="number"
                min={0}
                max={40}
                disabled={!settings.nmsDeepSleepEnabled}
                value={settings.nmsNightCap}
                onChange={(e) => onSettingsChange({ nmsNightCap: Math.max(0, Math.min(40, Number(e.target.value) || 0)) })}
              />
            </label>
            <div className="nmsActions">
              <button type="button" onClick={() => void runDeep()} disabled={busy !== "" || !settings.nmsDeepSleepEnabled}>
                {busy === "deep" ? "深睡中…" : "立即深睡"}
              </button>
              <button type="button" onClick={() => void runLight()} disabled={busy !== ""}>
                {busy === "light" ? "浅睡中…" : "立即浅睡"}
              </button>
              <button
                type="button"
                onClick={() => void onDistill()}
                disabled={dreaming || distilling || !canDistill}
              >
                {distilling ? "正在整理…" : "把这段对话整理成记忆"}
              </button>
              <button type="button" onClick={onRefresh}>刷新快照</button>
            </div>
            {distillNote ? <p className="nmsNote">{distillNote}</p> : null}
            {note ? <p className="nmsNote">{note}</p> : null}
            <div className="nmsMeta">
              <div>节点 {stats?.nodes.total ?? 0} · 连接 {stats?.edges.total ?? 0}</div>
              <div>情景 {tierCounts.ep} / 语义 {tierCounts.sem} / 语气 {tierCounts.note}</div>
              <div>待加工轮次 {stats?.pending.unconsumed ?? 0}</div>
              <div>{voice ? "语气：自动 v" + voice.version : "语气：冻结（还没生成过）"}</div>
            </div>
          </section>

          <section className="nmsSettingGroup nmsVoiceGroup">
            <div className="nmsCardHead">
              <h3>语气</h3>
              <span>{voice ? "v" + voice.version + " · " + shortTime(voice.updatedAt) : "还没生成"}</span>
            </div>
            <label className="nmsCheck">
              <input
                type="checkbox"
                checked={settings.moodEnabled}
                disabled={settings.cheapMode}
                onChange={(e) => onSettingsChange({ moodEnabled: e.target.checked })}
              />
              <span>判心情（每轮一次极便宜的调用）{settings.cheapMode ? "——省 token 下不判" : ""}</span>
            </label>
            <label className="nmsCheck">
              <input
                type="checkbox"
                checked={settings.reviewEnabled}
                disabled={settings.cheapMode}
                onChange={(e) => onSettingsChange({ reviewEnabled: e.target.checked })}
              />
              <span>说完先让她自己复核（关掉每轮省一次调用）{settings.cheapMode ? "——省 token 下不复核" : ""}</span>
            </label>
            <label className="nmsCheck">
              <input
                type="checkbox"
                checked={settings.replyPacing}
                onChange={(e) => onSettingsChange({ replyPacing: e.target.checked })}
              />
              <span>她会看时机回话（有时不接、有时慢半拍；聊得越久回得越快）</span>
            </label>
            <p className="nmsVoiceText">
              {voice
                ? voice.profile
                : "还没生成过。现在用的是 NMS 移植时冻结的旧语气；深睡有新记忆后会自己重写，也可以现在点一次。"}
            </p>
            {voice ? (
              <div className="nmsParams">
                {Object.entries(voiceSchema.nodes).map(([key, node]) => (
                  <div className="nmsParamRow" key={key}>
                    <span className="nmsParamLabel">{node.label}</span>
                    {node.type === "number" ? (
                      <>
                        <button
                          type="button"
                          className="nmsParamBtn"
                          aria-label={node.label + "减一档"}
                          onClick={() => changeParam(key, Number((draftParams ?? voice.params)[key]) - node.step)}
                        >
                          −
                        </button>
                        <b className="nmsParamValue">{String((draftParams ?? voice.params)[key])}</b>
                        <button
                          type="button"
                          className="nmsParamBtn"
                          aria-label={node.label + "加一档"}
                          onClick={() => changeParam(key, Number((draftParams ?? voice.params)[key]) + node.step)}
                        >
                          ＋
                        </button>
                        <em className="nmsParamRange">/ {node.max}</em>
                      </>
                    ) : (
                      <select
                        className="nmsParamSelect"
                        value={String((draftParams ?? voice.params)[key])}
                        aria-label={node.label}
                        onChange={(e) => changeParam(key, e.target.value)}
                      >
                        {node.values.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.value === "name" ? settings.userName.trim() || "名字" : option.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="nmsActions">
              <button
                type="button"
                disabled={voiceBusy || nodes.length === 0}
                onClick={() => void rewriteVoiceNow()}
              >
                {voiceBusy ? "重写中…" : "重写语气（约 1–2k token）"}
              </button>
            </div>
            {nodes.length === 0 ? <p className="nmsHint">还没有记忆可读；先聊几轮、睡一觉，再来重写。</p> : null}
            {voice && voice.history.length > 0 ? (
              <details className="nmsVoiceHistory">
                <summary>最近 {voice.history.length} 版 · 可以回滚</summary>
                {voice.history.map((snapshotVoice) => (
                  <div className="nmsVoiceSnap" key={snapshotVoice.version}>
                    <span>
                      v{snapshotVoice.version} · {shortTime(snapshotVoice.updatedAt)}
                    </span>
                    <p>{snapshotVoice.profile}</p>
                    <button type="button" onClick={() => onRollbackVoice(snapshotVoice.version)}>
                      回到这版
                    </button>
                  </div>
                ))}
              </details>
            ) : null}
            <p className="nmsHint">深睡跑完、这次真有新记忆时才自动重写；省 token 模式下不跑。</p>
          </section>
          </>
        ) : null}
      </div>
    </div>
  );
}