/**
 * 记忆网络视图（只做 network 这一块）。
 *
 * 头部统计 + tier chips + 画布 + 节点详情卡；列表/设置由别的组件负责。
 * 数据来自本地 NmsStore.snapshot()，形状见 types.ts 的 NmsSnapshotInput。
 * 画布的 CSS 由本组件自带的 <style> 注入（不依赖 styles.css，也不改现有文件）。
 *
 * 接入方式：
 *   const store = useMemo(() => createActivationStore(), []);
 *   // nms recall 之后：store.ingest({ seq, nodes: [{ id, activation }] });
 *   <NetworkView snapshot={snapshot} activationStore={store} />
 */

import { useEffect, useMemo, useState } from "react";
import { buildActivationModel } from "./activation.ts";
import type { NmsActivationStore } from "./activation.ts";
import { NETWORK_CANVAS_LIMITS, NMS_TIER_THEME, NetworkCanvas } from "./network-canvas.tsx";
import { TIER_ORDER, ageDays, countSnapshotTiers, normalizeSnapshot } from "./normalize.ts";
import type {
  NmsActivationModel,
  NmsActivationSnapshot,
  NmsCanvasNode,
  NmsSnapshotInput,
  NmsTier,
} from "./types.ts";

export interface NetworkViewProps {
  /** NmsStore.snapshot() 的结果；null/undefined 时显示空态。 */
  snapshot?: NmsSnapshotInput | null;
  /** 直接给编译好的激活模型（测试/受控场景）。 */
  activationModel?: NmsActivationModel | null;
  /** 或者给进程内 store，本组件负责订阅并编译激活模型。 */
  activationStore?: NmsActivationStore | null;
  /** 受控选中键（NmsCanvasNode.key）；不传则组件自己管。 */
  selectedKey?: string | null;
  onSelect?: (node: NmsCanvasNode | null) => void;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  /** 可选：全屏模式下给一个关闭按钮。 */
  onClose?: () => void;
  compact?: boolean;
  /**
   * 是否由本组件处理刘海/手势条 safe-area。
   * 放在已经带 padding 的 .app / .viewer 里时传 false，避免双层留白。
   */
  safeArea?: boolean;
  title?: string;
  /** chips 形态：multi = 三档开关（小窗）；single = 全部 / ep / sem / note 四选一（全屏页）。 */
  tierMode?: "multi" | "single";
  /** 详情卡形态：compact = 要点两行；full = 全文 + 它连着的几条（全屏页）。 */
  detailMode?: "compact" | "full";
  /** full 详情卡的正文：snapshot 不带 body，由外部从 store 取好后传进来。 */
  detailBody?: string | null;
  /** full 详情卡最多列几条邻接，默认 5。 */
  neighborLimit?: number;
  /** 小窗里的「看全图」入口。 */
  onExpand?: () => void;
}

const EMPTY_TIER_FILTER: Record<NmsTier, boolean> = { ep: true, sem: true, note: true };

const NETWORK_CSS = `
.nmsnet-root {
  --nmsnet-safe-top: env(safe-area-inset-top, 0px);
  --nmsnet-safe-bottom: env(safe-area-inset-bottom, 0px);
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
  color: var(--ink, #2f3a45);
  font: 15px/1.6 -apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
}
.nmsnet-root.no-safe {
  --nmsnet-safe-top: 0px;
  --nmsnet-safe-bottom: 0px;
}
.nmsnet-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex: 0 0 auto;
  padding: calc(8px + var(--nmsnet-safe-top)) 16px 6px;
}
.nmsnet-head-main { flex: 1; min-width: 0; }
.nmsnet-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--ink, #2f3a45);
}
.nmsnet-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--accent, #6fa8ad);
  box-shadow: 0 0 8px rgba(111, 168, 173, 0.45);
}
.nmsnet-sub {
  margin: 3px 0 0;
  font-size: 11px;
  color: var(--muted, #8a97a3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nmsnet-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding-top: 2px;
}
.nmsnet-btn {
  font: inherit;
  font-size: 12px;
  line-height: 1.2;
  padding: 7px 12px;
  border-radius: 999px;
  border: 1px solid var(--line, #dde7ea);
  background: var(--card, #ffffff);
  color: var(--ink-soft, #55636f);
  cursor: pointer;
}
.nmsnet-btn:active { background: #f4f9fa; }
.nmsnet-btn:disabled { opacity: 0.5; }
.nmsnet-lod {
  font-size: 10px;
  line-height: 1.4;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid rgba(111, 168, 173, 0.35);
  background: rgba(111, 168, 173, 0.1);
  color: var(--accent, #6fa8ad);
  white-space: nowrap;
}
.nmsnet-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  flex: 0 0 auto;
  padding: 0 16px 8px;
}
.nmsnet-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--line, #dde7ea);
  background: var(--card, #ffffff);
  color: var(--ink-soft, #55636f);
  font: inherit;
  font-size: 12px;
  line-height: 1.3;
  cursor: pointer;
  transition: opacity 0.12s, background 0.12s, border-color 0.12s;
}
.nmsnet-chip i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
.nmsnet-chip b { color: var(--ink, #2f3a45); font-weight: 600; }
.nmsnet-chip.on {
  color: var(--ink, #2f3a45);
  border-color: rgba(111, 168, 173, 0.45);
  background: rgba(111, 168, 173, 0.1);
}
.nmsnet-chip:not(.on) { opacity: 0.45; }
.nmsnet-chip:active { background: #f4f9fa; }
.nmsnet-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.nmsnet-canvas-wrap {
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  background:
    radial-gradient(70% 55% at 50% 38%, rgba(111, 168, 173, 0.12), transparent 70%),
    radial-gradient(55% 45% at 82% 80%, rgba(221, 111, 146, 0.07), transparent 65%),
    linear-gradient(165deg, #f7fbfb 0%, #eef6f7 100%);
}
.nmsnet-canvas { outline: none; }
.nmsnet-canvas-wrap.compact .nmsnet-tip { display: none; }
.nmsnet-tip {
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid rgba(150, 180, 190, 0.35);
  background: rgba(255, 255, 255, 0.97);
  color: var(--ink, #2f3a45);
  font-size: 11px;
  line-height: 1.45;
  white-space: nowrap;
  box-shadow: 0 6px 18px rgba(90, 120, 130, 0.16);
}
.nmsnet-tip-sub { margin-top: 1px; color: var(--muted, #8a97a3); font-size: 10px; }
.nmsnet-legend {
  position: absolute;
  left: 12px;
  bottom: calc(12px + var(--nmsnet-safe-bottom));
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 10px;
  color: var(--muted, #8a97a3);
  pointer-events: none;
  z-index: 2;
}
.nmsnet-legend-row { display: flex; align-items: center; gap: 6px; }
.nmsnet-legend-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.nmsnet-legend-line {
  width: 16px;
  height: 1px;
  background: linear-gradient(90deg, rgba(111, 168, 173, 0.12), rgba(111, 168, 173, 0.7));
}
.nmsnet-hint {
  position: absolute;
  right: 12px;
  bottom: calc(12px + var(--nmsnet-safe-bottom));
  font-size: 10px;
  line-height: 1.6;
  color: var(--muted, #8a97a3);
  text-align: right;
  pointer-events: none;
  z-index: 2;
}
.nmsnet-detail {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: calc(10px + var(--nmsnet-safe-bottom));
  z-index: 4;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid var(--line, #dde7ea);
  background: rgba(255, 255, 255, 0.97);
  box-shadow: 0 12px 32px rgba(90, 120, 130, 0.18);
  backdrop-filter: blur(8px);
}
.nmsnet-detail-head { display: flex; align-items: center; gap: 8px; }
.nmsnet-detail-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.2px;
  color: var(--ink, #2f3a45);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nmsnet-tag {
  flex: none;
  padding: 1px 7px;
  border-radius: 6px;
  border: 1px solid currentColor;
  font-size: 10px;
  line-height: 1.6;
}
.nmsnet-tag.ep { color: #3fa8a1; }
.nmsnet-tag.sem { color: #8a72d6; }
.nmsnet-tag.note { color: #dd6f92; }
.nmsnet-detail-close {
  flex: none;
  padding: 4px 2px 4px 8px;
  border: 0;
  background: none;
  color: var(--muted, #8a97a3);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.nmsnet-detail-meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 6px;
  font-size: 11px;
  color: var(--muted, #8a97a3);
}
.nmsnet-bar {
  height: 4px;
  margin-top: 8px;
  border-radius: 2px;
  background: rgba(111, 168, 173, 0.16);
  overflow: hidden;
}
.nmsnet-bar i { display: block; height: 100%; border-radius: 2px; background: var(--accent, #6fa8ad); }
.nmsnet-detail-links {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: baseline;
  margin-top: 8px;
  font-size: 11px;
  color: var(--ink-soft, #55636f);
}
.nmsnet-detail-links b { color: var(--ink, #2f3a45); font-weight: 600; }
.nmsnet-detail.full {
  max-height: 56%;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}
.nmsnet-detail-text {
  margin: 8px 0 2px;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--ink, #2f3a45);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.nmsnet-detail-nb {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--line, #dde7ea);
}
.nmsnet-detail-nb > span { font-size: 10px; color: var(--muted, #8a97a3); }
.nmsnet-detail-nb button {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: 1px solid rgba(111, 168, 173, 0.3);
  border-radius: 9px;
  background: rgba(111, 168, 173, 0.08);
  padding: 7px 9px;
  font: inherit;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--ink, #2f3a45);
}
.nmsnet-detail-nb button em {
  margin-left: auto;
  flex: none;
  font-style: normal;
  font-size: 9.5px;
  color: var(--muted, #8a97a3);
}
.nmsnet-detail-body {
  flex-basis: 100%;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted, #8a97a3);
}
.nmsnet-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px;
  text-align: center;
  color: var(--muted, #8a97a3);
}
.nmsnet-empty-title { font-size: 14px; font-weight: 600; color: var(--ink-soft, #55636f); }
.nmsnet-empty-desc { max-width: 320px; font-size: 12px; line-height: 1.7; }
.nmsnet-root.compact .nmsnet-sub,
.nmsnet-root.compact .nmsnet-chips { display: none; }
`;

export function NetworkView({
  snapshot,
  activationModel = null,
  activationStore = null,
  selectedKey: controlledSelectedKey,
  onSelect,
  loading = false,
  error = null,
  onRefresh,
  onClose,
  compact = false,
  safeArea = true,
  title = "记忆网络",
  tierMode = "multi",
  detailMode = "compact",
  detailBody = null,
  neighborLimit = 5,
  onExpand,
}: NetworkViewProps) {
  const [tierFilter, setTierFilter] = useState<Record<NmsTier, boolean>>(() => ({
    ...EMPTY_TIER_FILTER,
  }));
  /** 四选一档位：全屏页一次只看一层，「全部」= 三层。 */
  const [singleTier, setSingleTier] = useState<NmsTier | "all">("all");
  const [internalSelectedKey, setInternalSelectedKey] = useState<string | null>(null);
  const [storeSnapshot, setStoreSnapshot] = useState<NmsActivationSnapshot | null>(() =>
    activationStore ? activationStore.getSnapshot() : null,
  );

  useEffect(() => {
    if (!activationStore) {
      setStoreSnapshot(null);
      return undefined;
    }
    setStoreSnapshot(activationStore.getSnapshot());
    return activationStore.subscribe(() => {
      setStoreSnapshot(activationStore.getSnapshot());
    });
  }, [activationStore]);

  // 快照一般是整体替换的；把 nodes/edges/stats 的引用拆出来做依赖，
  // 父组件即使每次新建一个 wrapper（{...snapshot}），也不会让画布重排/重建。
  const snapshotNodes = snapshot?.nodes;
  const snapshotEdges = snapshot?.edges;
  const snapshotStats = snapshot?.stats;

  const activeTierFilter = useMemo<Partial<Record<NmsTier, boolean>>>(() => {
    if (tierMode !== "single" || singleTier === "all") return tierFilter;
    return { ep: singleTier === "ep", sem: singleTier === "sem", note: singleTier === "note" };
  }, [tierMode, singleTier, tierFilter]);

  const data = useMemo(
    () => normalizeSnapshot(snapshot, { tierFilter: activeTierFilter }),
    [snapshotNodes, snapshotEdges, snapshotStats, activeTierFilter],
  );

  const counts = useMemo(() => countSnapshotTiers(snapshotNodes ?? []), [snapshotNodes]);
  const totalNodes = snapshotNodes?.length ?? 0;
  const totalEdges = snapshotEdges?.length ?? 0;
  const visibleCount = data.nodes.length;
  const lod = visibleCount > NETWORK_CANVAS_LIMITS.lodNodeThreshold;
  const allTiersOn = TIER_ORDER.every((tier) => activeTierFilter[tier] !== false);

  const model = useMemo<NmsActivationModel | null>(() => {
    if (activationModel) return activationModel;
    if (!storeSnapshot) return null;
    return buildActivationModel(storeSnapshot, data);
  }, [activationModel, storeSnapshot, data]);

  const selectedKey = controlledSelectedKey !== undefined ? controlledSelectedKey : internalSelectedKey;
  const selectedNode = useMemo(() => {
    if (selectedKey === null) return null;
    return data.nodes.find((node) => node.key === selectedKey) ?? null;
  }, [data, selectedKey]);
  const selectedAge = selectedNode ? ageDays(selectedNode.createdAt, Date.now()) : null;
  const detailText = selectedNode
    ? detailBody && detailBody.length > 0
      ? detailBody
      : selectedNode.body || selectedNode.gist
    : "";
  /** 它连着的几条：按有效权重排序，重复边只出现一次。 */
  const neighbors = useMemo(() => {
    if (!selectedNode) return [] as NmsCanvasNode[];
    const seen = new Set<number>();
    const out: NmsCanvasNode[] = [];
    for (const index of selectedNode.links) {
      if (seen.has(index)) continue;
      seen.add(index);
      const node = data.nodes[index];
      if (node) out.push(node);
    }
    out.sort((a, b) => b.effectiveWeight - a.effectiveWeight);
    return out.slice(0, neighborLimit);
  }, [selectedNode, data, neighborLimit]);

  function handleSelect(node: NmsCanvasNode | null): void {
    if (controlledSelectedKey === undefined) setInternalSelectedKey(node ? node.key : null);
    if (onSelect) onSelect(node);
  }

  function toggleTier(tier: NmsTier): void {
    setTierFilter((previous) => {
      const next = { ...previous };
      next[tier] = !next[tier];
      return next;
    });
  }

  const summary =
    totalNodes +
    " 条记忆 · " +
    totalEdges +
    " 条连接" +
    (allTiersOn ? "" : " · 显示 " + visibleCount + "/" + totalNodes) +
    (lod ? " · 精简视图" : "") +
    (error && totalNodes > 0 ? " · 刷新失败" : "");

  const lodTitle =
    "精简视图：只画权重最高的 " +
    NETWORK_CANVAS_LIMITS.lodTopLabels +
    " 个节点标签与强度最高的 " +
    NETWORK_CANVAS_LIMITS.lodTopEdges +
    " 条边；点 chips 过滤或选中节点查看细节";

  const hasData = totalNodes > 0;
  const emptyTitle = hasData
    ? "当前层级过滤下没有节点"
    : loading
      ? "正在读取记忆网络…"
      : error
        ? "读取失败"
        : "记忆库还是空的";
  const emptyDesc = hasData
    ? tierMode === "single"
      ? "点上方「全部」或别的层级再看看。"
      : "点上方情景 / 语义 / 语气 chips 重新打开层级。"
    : loading
      ? "本地 store 打开后就会显示。"
      : error
        ? error
        : "睡一觉之后，新的情景记忆会出现在这里。";
  // 后台刷新时保留画布，只有真没数据才切空态。
  const showCanvas = hasData && visibleCount > 0;

  return (
    <div className={"nmsnet-root" + (compact ? " compact" : "") + (safeArea ? "" : " no-safe")}>
      <style>{NETWORK_CSS}</style>
      <header className="nmsnet-head">
        <div className="nmsnet-head-main">
          <h2 className="nmsnet-title">
            <span className="nmsnet-dot" aria-hidden="true" />
            {title}
          </h2>
          <p className="nmsnet-sub" title={summary}>
            {summary}
          </p>
        </div>
        <div className="nmsnet-head-actions">
          {lod ? (
            <span className="nmsnet-lod" title={lodTitle}>
              {"精简视图 · " + visibleCount}
            </span>
          ) : null}
          {onExpand ? (
            <button type="button" className="nmsnet-btn" onClick={onExpand}>
              看全图
            </button>
          ) : null}
          {onRefresh ? (
            <button type="button" className="nmsnet-btn" onClick={onRefresh} disabled={loading}>
              {loading ? "读取中…" : "刷新"}
            </button>
          ) : null}
          {onClose ? (
            <button type="button" className="nmsnet-btn" onClick={onClose}>
              关闭
            </button>
          ) : null}
        </div>
      </header>

      <div className="nmsnet-chips" role="group" aria-label="记忆层级筛选">
        {tierMode === "single" ? (
          <>
            <button
              type="button"
              className={"nmsnet-chip" + (singleTier === "all" ? " on" : "")}
              aria-pressed={singleTier === "all"}
              title={"显示全部记忆（共 " + String(totalNodes) + " 条）"}
              onClick={() => setSingleTier("all")}
            >
              全部
              <b>{totalNodes}</b>
            </button>
            {TIER_ORDER.map((tier) => {
              const theme = NMS_TIER_THEME[tier];
              const on = singleTier === tier;
              return (
                <button
                  key={tier}
                  type="button"
                  className={"nmsnet-chip" + (on ? " on" : "")}
                  aria-pressed={on}
                  title={"只看" + theme.name + "记忆（共 " + String(counts[tier]) + " 条）"}
                  onClick={() => setSingleTier(tier)}
                >
                  <i style={{ background: theme.color }} aria-hidden="true" />
                  {theme.name}
                  <b>{counts[tier]}</b>
                </button>
              );
            })}
          </>
        ) : (
          TIER_ORDER.map((tier) => {
            const theme = NMS_TIER_THEME[tier];
            const on = tierFilter[tier];
            return (
              <button
                key={tier}
                type="button"
                className={"nmsnet-chip" + (on ? " on" : "")}
                aria-pressed={on}
                title={
                  (on ? "隐藏" : "显示") + theme.name + "记忆（共 " + String(counts[tier]) + " 条）"
                }
                onClick={() => toggleTier(tier)}
              >
                <i style={{ background: theme.color }} aria-hidden="true" />
                {theme.name}
                <b>{counts[tier]}</b>
              </button>
            );
          })
        )}
      </div>

      <div className="nmsnet-stage">
        {showCanvas ? (
          <NetworkCanvas
            data={data}
            activationModel={model}
            selectedKey={selectedKey}
            onSelect={handleSelect}
            visible
            compact={compact}
          >
            {compact ? null : (
              <div className="nmsnet-legend" aria-hidden="true">
                {TIER_ORDER.map((tier) => {
                  const theme = NMS_TIER_THEME[tier];
                  return (
                    <div className="nmsnet-legend-row" key={"legend-" + tier}>
                      <span className="nmsnet-legend-dot" style={{ background: theme.color }} />
                      {theme.name + "记忆"}
                    </div>
                  );
                })}
                <div className="nmsnet-legend-row">
                  <span className="nmsnet-legend-line" />
                  关联强度
                </div>
              </div>
            )}
            {compact ? null : (
              <div className="nmsnet-hint" aria-hidden="true">
                {lod ? "精简视图" : "单指旋转 · 双指缩放"}
                <br />
                {lod ? "点 chips 过滤或选中节点" : "点节点看详情"}
              </div>
            )}
            {selectedNode ? (
              <div
                className={"nmsnet-detail" + (detailMode === "full" ? " full" : "")}
                role="dialog"
                aria-label="记忆节点详情"
              >
                <div className="nmsnet-detail-head">
                  <span className="nmsnet-detail-title" title={selectedNode.title}>
                    {selectedNode.title}
                  </span>
                  <span className={"nmsnet-tag " + selectedNode.tier}>
                    {NMS_TIER_THEME[selectedNode.tier].name}
                  </span>
                  <button
                    type="button"
                    className="nmsnet-detail-close"
                    onClick={() => handleSelect(null)}
                  >
                    关闭
                  </button>
                </div>
                <div className="nmsnet-detail-meta">
                  <span>{selectedNode.workspace || "人格层"}</span>
                  <span>{"有效权重 " + selectedNode.effectiveWeight.toFixed(2)}</span>
                  {selectedAge === null ? null : <span>{"已形成 " + selectedAge + " 天"}</span>}
                </div>
                <div className="nmsnet-bar">
                  <i style={{ width: Math.round(selectedNode.effectiveWeight * 100) + "%" }} />
                </div>
                {detailMode === "full" ? (
                  <>
                    <p className="nmsnet-detail-text">{detailText}</p>
                    <div className="nmsnet-detail-links">
                      <span>
                        关联 <b>{selectedNode.links.length}</b> 条
                      </span>
                      <span>
                        被想起 <b>{selectedNode.recalls}</b> 次
                      </span>
                    </div>
                    {neighbors.length > 0 ? (
                      <div className="nmsnet-detail-nb" aria-label="它连着的记忆">
                        <span>它连着的几条</span>
                        {neighbors.map((node) => (
                          <button
                            key={node.key}
                            type="button"
                            onClick={() => handleSelect(node)}
                            title={node.title}
                          >
                            {node.title}
                            <em>{NMS_TIER_THEME[node.tier].name}</em>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="nmsnet-detail-links">
                    <span>
                      关联 <b>{selectedNode.links.length}</b> 条
                    </span>
                    <span>
                      被想起 <b>{selectedNode.recalls}</b> 次
                    </span>
                    {selectedNode.body && selectedNode.body !== selectedNode.gist ? (
                      <span className="nmsnet-detail-body">{selectedNode.body}</span>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}
          </NetworkCanvas>
        ) : (
          <div className="nmsnet-empty">
            <div className="nmsnet-empty-title">{emptyTitle}</div>
            <div className="nmsnet-empty-desc">{emptyDesc}</div>
            {error && onRefresh ? (
              <button type="button" className="nmsnet-btn" onClick={onRefresh}>
                重试
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
