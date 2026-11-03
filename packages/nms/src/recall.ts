/**
 * 召回 / 状态 / 快照：手机端 UI 与提示词共用的读路径。
 *
 * 单 persona（herta）、单分区；算法与 DSH 版 memory-api.recallMemory 保持一致：
 * 激活排序 → MMR 折近重复 → token 预算 → recall/reinforce 写回。
 */
import type { NmsStore } from "./store.ts";
import type { NmsNode, NmsSnapshot, NmsStats, NmsTier } from "./types.ts";
import {
  MMR_CLUSTER_SIMILARITY,
  MMR_MIN_SHARED_KEYWORDS,
  diversifyCandidates,
  estimateTokens,
  rankCandidates,
} from "./model.ts";

export interface NmsRecallOptions {
  store: NmsStore;
  query?: string;
  tier?: NmsTier | null;
  limit?: number;
  now?: number;
  budgetTokens?: number;
}

export interface NmsRecallRow {
  id: number;
  tier: NmsTier;
  workspace: string;
  title: string;
  gist: string;
  activation: number;
  similarity: number;
  effectiveWeight: number;
  weight: number;
  recalls: number;
  lastRecallAt: string;
}

export interface NmsRecallResult {
  ok: boolean;
  error: string;
  query: string;
  tier: string;
  total: number;
  returned: number;
  budgetTokens: number;
  usedTokens: number;
  results: NmsRecallRow[];
}

const TIERS: ReadonlySet<string> = new Set(["ep", "sem", "note"]);

function resultTokens(row: NmsRecallRow): number {
  return estimateTokens(row.title + " " + row.gist) + 8;
}

/**
 * 召回。失败 fail-soft，不抛。
 */
export async function recallMemories(options: NmsRecallOptions): Promise<NmsRecallResult> {
  const empty: NmsRecallResult = {
    ok: false,
    error: "",
    query: typeof options.query === "string" ? options.query : "",
    tier: options.tier ?? "",
    total: 0,
    returned: 0,
    budgetTokens: 0,
    usedTokens: 0,
    results: [],
  };
  if (options.store === null || options.store === undefined) {
    return { ...empty, error: "记忆库不可用" };
  }
  try {
    const now = options.now ?? Date.now();
    const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 6)));
    const nodes = await options.store.listNodes({});
    const edges = await options.store.allEdges();
    const tier = options.tier !== null && options.tier !== undefined && TIERS.has(options.tier) ? options.tier : null;
    const ranked = rankCandidates({
      nodes,
      edges,
      query: typeof options.query === "string" ? options.query : "",
      tier,
      limit: Math.max(24, limit * 6),
      now,
    });
    const pool = ranked.query.trim() === "" ? ranked.results : ranked.results.filter((item: { activation: number }) => item.activation > 0);
    const selected = diversifyCandidates(pool, {
      limit,
      clusterSimilarity: MMR_CLUSTER_SIMILARITY,
      minSharedKeywords: MMR_MIN_SHARED_KEYWORDS,
    });
    const budget = Math.max(0, Math.floor(options.budgetTokens ?? 4200));
    const results: NmsRecallRow[] = [];
    let used = 0;
    for (const item of selected as Array<{ node: NmsNode; activation: number; similarity: number; effectiveWeight: number }>) {
      const row: NmsRecallRow = {
        id: item.node.id,
        tier: item.node.tier,
        workspace: item.node.workspace ?? "",
        title: item.node.title,
        gist: item.node.gist,
        activation: item.activation,
        similarity: item.similarity,
        effectiveWeight: item.effectiveWeight,
        weight: Math.round(item.node.weight * 1e4) / 1e4,
        recalls: item.node.recalls,
        lastRecallAt: item.node.lastRecallAt ?? "",
      };
      const tokens = resultTokens(row);
      if (results.length > 0 && used + tokens > budget) break;
      results.push(row);
      used += tokens;
    }
    const ids = results.map((row) => row.id);
    if (ids.length > 0) {
      await options.store.recall(ids, { now });
      if (ids.length > 1) await options.store.reinforce(ids);
    }
    return {
      ok: true,
      error: "",
      query: typeof options.query === "string" ? options.query : "",
      tier: tier ?? "",
      total: ranked.candidates,
      returned: results.length,
      budgetTokens: budget,
      usedTokens: used,
      results,
    };
  } catch (error) {
    return { ...empty, error: "召回失败：" + String(error instanceof Error ? error.message : error) };
  }
}

export async function memoryStatus(store: NmsStore, options: { now?: number } = {}): Promise<{ ok: boolean; stats: NmsStats | null; error: string }> {
  try {
    const stats = await store.stats({ now: options.now ?? Date.now() });
    return { ok: true, stats, error: "" };
  } catch (error) {
    return { ok: false, stats: null, error: "读取统计失败：" + String(error instanceof Error ? error.message : error) };
  }
}

export async function memorySnapshot(store: NmsStore, options: { now?: number } = {}): Promise<{ ok: boolean; snapshot: NmsSnapshot | null; error: string }> {
  try {
    const snapshot = await store.snapshot({ now: options.now ?? Date.now() });
    return { ok: true, snapshot, error: "" };
  } catch (error) {
    return { ok: false, snapshot: null, error: "快照失败：" + String(error instanceof Error ? error.message : error) };
  }
}
