/**
 * 浅睡（零 LLM）：去重 → 衰减 → 剪连接 → 记账。
 *
 * 算法逐字移植自 dsh-neural-memory/src/host/store.js 的
 * dedupeByTitle / applyDecay / pruneEdges / dreamLight：
 *
 *   · 去重 dedupeByTitle：同一 (tier, persona, workspace) 下归一化标题相同的节点，
 *     保留**有效权重**最高的那条（同分按 id 升序），其余 archived=1（不删）。
 *   · 衰减 applyDecay：把有效权重材料化进 weight ——
 *       w' = max(floor, w · 2^(-Δ/halfLife))，Δ 自 lastRecallAt ?? createdAt 起算。
 *     指数衰减无记忆性：w(t2) = w(t1)·2^(-Δ/hl)，所以「材料化 + 重置衰减基线」
 *     与连续衰减在数学上等价（地板值除外）。地板默认 0.05，不让活记忆归零。
 *   · 剪连接 pruneEdges：strength < 0.12，或任一端已归档/已遗忘的连接直接删。
 *   · dreamLight：去重 → 衰减 → 剪边 → 写 dream_runs + meta.last_dream_at。
 *
 * 手机端 store 是异步的（Capacitor SQLite 桥），SQL 在 sqlite-store 里实现；
 * 本文件只做编排与记账，不重复写 SQL。阈值在这里**显式传入**，保证与 DSH 默认值
 * （90 天半衰期 / 地板 0.05 / 剪边 0.12）一致，不依赖 store 的默认参数。
 *
 * 分区语义（与源实现一致）：给 persona = **分区浅睡**，只去重/衰减该分区；
 * 连接清理可能跨分区，留给全局浅睡（此时 prunedEdges=0），不替别的分区做决定。
 *
 * TODO(P2): 把 DSH test/store.test.js 里的浅睡测试向量（90 天衰减 / 同标题去重 /
 * 弱边剪除）移植到 packages/nms/test，用内存 async store 跑；当前只保证编译与逐字对照。
 */
import type { NmsStore } from "./store.ts";

/** 浅睡最后运行时间在 meta 表里的键（与 DSH 同名，便于备份/诊断对齐）。 */
export const LAST_LIGHT_RUN_META_KEY = "last_dream_at";

/**
 * 浅睡阈值（与 DSH store.js 的常量一致）：
 * DECAY_HALF_LIFE_DAYS=90、DECAY_WEIGHT_FLOOR=0.05、EDGE_PRUNE_STRENGTH=0.12。
 *
 * ARCHIVE_WEIGHT_FLOOR / ARCHIVE_AGE_DAYS 在 DSH 里只声明、当前浅睡并未执行
 * （源实现没有调用点），这里同样只记值、不参与 runLightSleep，留作后续归档策略。
 */
export const LIGHT_SLEEP_DEFAULTS = Object.freeze({
  /** 90 天半衰期：两周忘掉约 10%，三个月忘掉一半。 */
  halfLifeDays: 90,
  /** 衰减地板：活记忆的权重不会被衰减到 0。 */
  decayFloor: 0.05,
  /** 剪边阈值。 */
  edgePruneStrength: 0.12,
  /** 归档阈值（保留值，当前未执行）。 */
  archiveWeightFloor: 0.08,
  /** 归档年龄（天，保留值，当前未执行）。 */
  archiveAgeDays: 365,
});

export type LightSleepOptions = {
  /** 时间源（测试注入）；默认 Date.now()。 */
  now?: number;
  /** 给定 = 只处理该 persona 分区；不传 = 全局（含剪边）。 */
  persona?: string;
};

/** 一次浅睡的 stats（写进 dream_runs.stats，同时原样返回）。 */
export type LightSleepRunStats = {
  kind: "light";
  startedAt: string;
  endedAt: string;
  /** 分区浅睡时是 persona，全局是 null。 */
  persona: string | null;
  /** 被同标题去重归档的节点数。 */
  archived: number;
  archivedIds: number[];
  /** 权重被材料化改写的节点数。 */
  decayed: number;
  /** 剪掉的边数（分区浅睡恒为 0）。 */
  prunedEdges: number;
  nodesBefore: number;
  nodesAfter: number;
  edgesBefore: number;
  edgesAfter: number;
};

export type LightSleepStats = LightSleepRunStats & { runId: number };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 活动节点计数（与 DSH countActive / countActivePersona 同口径：archived=0 且 forgotten=0）。 */
async function countActiveNodes(store: NmsStore, persona: string | undefined): Promise<number> {
  const nodes = await store.listNodes(persona === undefined ? {} : { persona });
  return nodes.filter((node) => !node.archived && !node.forgotten).length;
}

/**
 * 跑一次浅睡。
 *
 * 顺序与 DSH dreamLight 完全一致：dedupeByTitle → applyDecay → pruneEdges → 记账。
 * 与 DSH 一样**不吞异常**：store 写失败时抛给调用方（App 的浅睡 tick 自己 catch，
 * 失败不阻塞 UI）。返回值 = 写进 dream_runs.stats 的同一份 stats + runId。
 */
export async function runLightSleep(store: NmsStore, options: LightSleepOptions = {}): Promise<LightSleepStats> {
  const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const persona = options.persona;
  const startedAt = iso(now);

  const before = {
    nodes: await countActiveNodes(store, persona),
    edges: (await store.allEdges()).length,
  };

  // 1) 同标题去重（可能在统计前后改变活动节点数）。
  const dedupe = await store.dedupeByTitle({ now, persona });
  // 2) 时间衰减（材料化 + 重置基线）。
  const decay = await store.applyDecay({
    now,
    persona,
    halfLifeDays: LIGHT_SLEEP_DEFAULTS.halfLifeDays,
    floor: LIGHT_SLEEP_DEFAULTS.decayFloor,
  });
  // 3) 剪边：分区浅睡跳过（避免替别的分区做决定），与 DSH 一致。
  const prune =
    persona === undefined
      ? await store.pruneEdges({ minStrength: LIGHT_SLEEP_DEFAULTS.edgePruneStrength })
      : { pruned: 0, minStrength: LIGHT_SLEEP_DEFAULTS.edgePruneStrength };

  const after = {
    nodes: await countActiveNodes(store, persona),
    edges: (await store.allEdges()).length,
  };
  const endedAt = iso(Math.max(now, Date.now()));

  const runStats: LightSleepRunStats = {
    kind: "light",
    startedAt,
    endedAt,
    persona: persona ?? null,
    archived: dedupe.archived,
    archivedIds: dedupe.archivedIds,
    decayed: decay.decayed,
    prunedEdges: prune.pruned,
    nodesBefore: before.nodes,
    nodesAfter: after.nodes,
    edgesBefore: before.edges,
    edgesAfter: after.edges,
  };

  const runId = await store.recordDreamRun({ kind: "light", startedAt, endedAt, stats: runStats });
  await store.setMeta(LAST_LIGHT_RUN_META_KEY, startedAt);
  return { ...runStats, runId };
}
