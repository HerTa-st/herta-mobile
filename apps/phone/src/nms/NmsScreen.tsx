/**
 * NMS 记忆页：网络 / 列表 / 设置三个 tab。
 *
 * 网络视图直接复用 nms/network/NetworkView（桌面移植）；列表与设置用手机原生组件。
 * 数据全部来自本地 NmsStore.snapshot()，不依赖 /nms/api。
 */
import { useMemo, useState } from "react";
import type { NmsSnapshot } from "@herta/nms";
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
  onSettingsChange(patch: Partial<Settings>): void;
  onRefresh(): void;
  onClose(): void;
}

type Tab = "network" | "list" | "settings";

export function NmsScreen({ snapshot, activationStore, settings, onSettingsChange, onRefresh, onClose }: NmsScreenProps) {
  const [tab, setTab] = useState<Tab>("network");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<"deep" | "light" | "">("");
  const [note, setNote] = useState("");

  const nodes = snapshot?.nodes ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q.length === 0 ? nodes : nodes.filter((node) => (node.title + " " + node.gist).toLowerCase().includes(q));
    return [...list].sort((a, b) => b.effectiveWeight - a.effectiveWeight);
  }, [nodes, query]);

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
    <div className="nmsPage">
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
                <span>只读</span>
              </div>
              <p>旧 DreamState.voice 冻结在这里；NMS 自动语气是下一步。</p>
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
            {filtered.length === 0 ? <p className="nmsEmpty">还没有记忆。睡一觉之后，新的情景会出现在这里。</p> : null}
          </div>
        ) : null}

        {tab === "settings" ? (
          <div className="nmsSettingGroup">
            <label className="nmsCheck">
              <input
                type="checkbox"
                checked={settings.nmsDeepSleepEnabled}
                onChange={(e) => onSettingsChange({ nmsDeepSleepEnabled: e.target.checked })}
              />
              <span>NMS 深睡（有网 + Key 时，空闲后整理情景为语义）</span>
            </label>
            <label className="nmsField">
              每晚调用上限（0 = 关，默认 8）
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
              <button type="button" onClick={onRefresh}>刷新快照</button>
            </div>
            {note ? <p className="nmsNote">{note}</p> : null}
            <div className="nmsMeta">
              <div>节点 {stats?.nodes.total ?? 0} · 连接 {stats?.edges.total ?? 0}</div>
              <div>情景 {tierCounts.ep} / 语义 {tierCounts.sem} / 语气 {tierCounts.note}</div>
              <div>待加工轮次 {stats?.pending.unconsumed ?? 0}</div>
              <div>语气：冻结（旧 DreamState.voice 只读）</div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
