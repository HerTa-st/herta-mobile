/**
 * 本地快照 -> 画布数据。
 *
 * 对应桌面 client 的 normalizeSnapshot（C:372-481）与 viewData 的连续索引
 * （C:2360-2398）：先按 tier 过滤，再按快照顺序重排 id，最后把边的原始 id
 * 换成索引并建 links/nb。画布不会直接碰 store，也不依赖 HTTP 快照。
 */

import { assignPositions } from "./layout.ts";
import type {
  NmsCanvasData,
  NmsCanvasEdge,
  NmsCanvasNode,
  NmsCanvasStats,
  NmsNodeId,
  NmsSnapshotEdge,
  NmsSnapshotInput,
  NmsSnapshotNode,
  NmsTier,
} from "./types.ts";

export const HALF_LIFE_DAYS = 90;

/** 展示顺序，和桌面 TIER_ORDER 一致。 */
export const TIER_ORDER: readonly NmsTier[] = ["ep", "sem", "note"];

export interface NormalizeOptions {
  /** 关掉的层级不进入画布；默认三层全开。 */
  tierFilter?: Partial<Record<NmsTier, boolean>>;
  /** 计算有效权重的时间基点；默认 Date.now()。 */
  now?: number;
  /** 半衰期，默认取快照 stats.halfLifeDays，再退到 90 天。 */
  halfLifeDays?: number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function text(value: unknown, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value);
}

/** 宽容旧数据里的 tier/kind 拼写；未知返回 null（画布再退回 ep）。 */
export function normalizeTier(raw: unknown): NmsTier | null {
  const value = text(raw).toLowerCase();
  if (value === "ep" || value === "episode" || value === "episodic" || value === "情景") return "ep";
  if (value === "sem" || value === "semantic" || value === "语义") return "sem";
  if (value === "note" || value === "tone" || value === "voice" || value === "relationship" || value === "语气") {
    return "note";
  }
  return null;
}

function emptyTierCounts(): Record<NmsTier, number> {
  return { ep: 0, sem: 0, note: 0 };
}

/** 头部 chips 用：统计整个快照（而不是过滤后的画布）。 */
export function countSnapshotTiers(nodes: readonly NmsSnapshotNode[]): Record<NmsTier, number> {
  const counts = emptyTierCounts();
  for (const node of nodes) {
    if (node.archived === true || node.forgotten === true) continue;
    const tier = normalizeTier(node.tier);
    if (tier) counts[tier] += 1;
  }
  return counts;
}

const DAY_MS = 86400000;

/** 距 now 的天数；解析不了返回 null（而不是 0，避免把坏时间当成刚发生）。 */
export function daysSince(iso: unknown, now: number): number | null {
  const ms = typeof iso === "string" && iso.length > 0 ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (now - ms) / DAY_MS);
}

/** 详情卡的「已形成 N 天」。 */
export function ageDays(iso: unknown, now: number): number | null {
  const days = daysSince(iso, now);
  return days === null ? null : Math.floor(days);
}

/**
 * 记忆衰减：从 lastRecallAt 起按半衰期指数衰减。
 * 没有 lastRecallAt（或坏时间）就退回基础权重；桌面实现同式。
 */
export function effectiveWeight(
  weight: number,
  lastRecallAt: string | null | undefined,
  now: number,
  halfLifeDays: number,
): number {
  const base = clamp01(Number.isFinite(weight) ? weight : 0);
  const life = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : HALF_LIFE_DAYS;
  const elapsed = daysSince(lastRecallAt, now);
  if (elapsed === null || elapsed <= 0) return base;
  return clamp01(base * Math.pow(0.5, elapsed / life));
}

function countCanvasTiers(nodes: readonly NmsCanvasNode[]): Record<NmsTier, number> {
  const counts = emptyTierCounts();
  for (const node of nodes) counts[node.tier] += 1;
  return counts;
}

/**
 * 把 store snapshot 转成画布数据。
 *
 * - tier 过滤在这里完成，所以画布拿到的 nodes 已经连续（id = 下标）；
 * - 边端点只认原始 id（字符串化后匹配），过滤掉的端点整条边丢弃；
 * - links/nb 由边重建；边按无向处理，重复的 (a,b) 只保留一条。
 */
export function normalizeSnapshot(
  input: NmsSnapshotInput | null | undefined,
  options: NormalizeOptions = {},
): NmsCanvasData {
  const root: NmsSnapshotInput = input ?? { nodes: [] };
  const rawNodes: readonly NmsSnapshotNode[] = Array.isArray(root.nodes) ? root.nodes : [];
  const rawEdges: readonly NmsSnapshotEdge[] = Array.isArray(root.edges) ? root.edges : [];
  const now = finiteNumber(options.now) ?? Date.now();
  const halfLifeDays =
    finiteNumber(options.halfLifeDays) ?? finiteNumber(root.stats?.halfLifeDays) ?? HALF_LIFE_DAYS;
  const filter = options.tierFilter ?? {};

  const nodes: NmsCanvasNode[] = [];
  const byRef = new Map<string, NmsCanvasNode>();

  rawNodes.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    if (raw.archived === true || raw.forgotten === true) return;
    const tier = normalizeTier(raw.tier) ?? "ep";
    if (filter[tier] === false) return;

    const rawId: NmsNodeId = raw.id === undefined || raw.id === null ? index : raw.id;
    const key = String(rawId);
    const weight = clamp01(finiteNumber(raw.weight) ?? 0.5);
    const lastRecallAt = text(raw.lastRecallAt);
    const suppliedEffective = finiteNumber(raw.effectiveWeight);
    const gist = text(raw.gist);
    const node: NmsCanvasNode = {
      id: nodes.length,
      rawId,
      key,
      tier,
      workspace: raw.workspace === null || raw.workspace === undefined ? null : String(raw.workspace),
      title: text(raw.title).trim() || "未命名记忆",
      gist,
      body: text(raw.body) || gist,
      weight,
      effectiveWeight:
        suppliedEffective === null
          ? effectiveWeight(weight, lastRecallAt, now, halfLifeDays)
          : clamp01(suppliedEffective),
      recalls: Math.max(0, finiteNumber(raw.recalls) ?? 0),
      createdAt: text(raw.createdAt),
      lastRecallAt,
      x: Number.NaN,
      y: Number.NaN,
      z: Number.NaN,
      links: [],
      nb: {},
    };
    nodes.push(node);
    byRef.set(key, node);
  });

  // 过滤会改变 id，但位置只依赖 key，所以布局在重排后仍然稳定。
  assignPositions(nodes);

  const edges: NmsCanvasEdge[] = [];
  const seen = new Set<string>();
  for (const raw of rawEdges) {
    if (!raw || typeof raw !== "object") continue;
    const from = byRef.get(String(raw.a));
    const to = byRef.get(String(raw.b));
    if (!from || !to || from === to) continue;
    const pair = from.id < to.id ? from.id + ":" + to.id : to.id + ":" + from.id;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const loose = raw as { strength?: unknown; s?: unknown; weight?: unknown };
    const strength =
      finiteNumber(loose.strength) ?? finiteNumber(loose.s) ?? finiteNumber(loose.weight) ?? 0.3;
    edges.push({ a: from.id, b: to.id, s: clamp01(strength) });
  }

  for (const node of nodes) {
    node.nb = {};
    node.links = [];
  }
  for (const edge of edges) {
    const a = nodes[edge.a];
    const b = nodes[edge.b];
    if (!a || !b) continue;
    a.nb[b.id] = 1;
    b.nb[a.id] = 1;
    a.links.push(b.id);
    b.links.push(a.id);
  }

  const stats: NmsCanvasStats = {
    counts: countCanvasTiers(nodes),
    total: nodes.length,
    edges: edges.length,
    halfLifeDays,
  };

  return { nodes, edges, stats };
}
