/**
 * 手机端 NMS 控制面：单例 store 的生命周期、首启迁移、浅睡与读快照。
 *
 * UI/钩子只通过这里拿 store，不直接 new 连接；这样迁移只跑一次，测试也能复位。
 */
import { Capacitor } from "@capacitor/core";
import type { DreamState, MemoryStore } from "@herta/core";
import {
  createMobileNmsStore,
  migrateLegacyMemories,
  readFrozenVoice,
  recallMemories,
  runLightSleep,
} from "@herta/nms";
import type { NmsEdge, NmsMigrationResult, NmsNode, NmsSnapshot, NmsStore } from "@herta/nms";

let store: NmsStore | null = null;
let opening: Promise<NmsStore> | null = null;
let initialized = false;

export interface NmsInitResult {
  store: NmsStore;
  migration: NmsMigrationResult;
  snapshot: NmsSnapshot;
}

/** 取/建单例 store（只 open，不迁移）。 */
export async function getNmsStore(): Promise<NmsStore> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error("NMS SQLite 仅在 Android 原生可用（Web 开发时回退旧记忆只读）");
  }
  if (store !== null) return store;
  if (opening === null) {
    const created = createMobileNmsStore();
    opening = (async () => {
      await created.open();
      store = created;
      return created;
    })().finally(() => {
      opening = null;
    });
  }
  return opening;
}

/**
 * 首启初始化：打开 store → 迁移旧记忆/冻结语气 → 浅睡 → 快照。
 * 幂等：迁移函数自己按 meta 标记跳过。
 */
export async function initializeNms(options: {
  legacy: MemoryStore;
  dreamState: DreamState | null;
  now?: number;
}): Promise<NmsInitResult> {
  const active = await getNmsStore();
  // 不清理手机里已有的任何记忆：新包只是不再预装，老用户的旧库原样迁移。
  const records = await options.legacy.list();
  const state = options.dreamState ?? (await options.legacy.state());
  const migration = await migrateLegacyMemories(active, records, state, { now: options.now });
  if (!initialized) {
    initialized = true;
    try {
      await runLightSleep(active, { now: options.now });
    } catch (error) {
      console.log("[nms] 首启浅睡失败（继续）：" + String(error instanceof Error ? error.message : error));
    }
  }
  return { store: active, migration, snapshot: await active.snapshot({ now: options.now }) };
}

export interface NmsPromptRecall {
  seeds: string[];
  events: Array<{ id: number; activation: number }>;
}

/** 提示词用：按本轮 user 文本召回，写回 recall/reinforce；events 给网络视图点亮。 */
export async function recallNmsPromptSeeds(query: string, limit: number): Promise<NmsPromptRecall> {
  if (!Capacitor.isNativePlatform()) return { seeds: [], events: [] };
  const active = await getNmsStore();
  const result = await recallMemories({ store: active, query, limit, budgetTokens: 4200 });
  if (!result.ok) return { seeds: [], events: [] };
  return {
    seeds: result.results.map((row) => "- " + row.title + " —— " + row.gist),
    events: result.results.map((row) => ({ id: row.id, activation: row.activation })),
  };
}

export interface NmsBackupDump {
  nodes: NmsNode[];
  edges: NmsEdge[];
}

/** 备份用：完整节点（含 body/history/归档状态）+ 边。 */
export async function exportNmsBackup(): Promise<NmsBackupDump | null> {
  if (!Capacitor.isNativePlatform()) return null;
  const active = await getNmsStore();
  const nodes = await active.listNodes({ includeArchived: true, includeForgotten: true });
  const edges = await active.allEdges();
  return { nodes, edges };
}

/** 恢复 NMS：只在新库为空时导入，返回是否写入。 */
export async function restoreNmsBackup(raw: unknown): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const dump = raw as Partial<NmsBackupDump>;
  if (!Array.isArray(dump.nodes) || !Array.isArray(dump.edges)) return false;
  const active = await getNmsStore();
  if ((await active.countNodes()) > 0) return false;

  const idMap = new Map<number, number>();
  for (const node of dump.nodes) {
    const created = await active.insertNode({
      tier: node.tier,
      persona: node.persona,
      workspace: node.workspace,
      title: node.title,
      gist: node.gist,
      body: node.body,
      weight: node.weight,
      recalls: node.recalls,
      createdAt: node.createdAt,
      lastRecallAt: node.lastRecallAt,
    });
    idMap.set(node.id, created.id);
    await active.updateNode(created.id, {
      forgotten: node.forgotten,
      archived: node.archived,
      consolidatedCount: node.consolidatedCount,
      lastConsolidatedAt: node.lastConsolidatedAt,
      semanticizedAt: node.semanticizedAt,
      history: node.history,
    });
  }
  for (const edge of dump.edges) {
    const a = idMap.get(edge.a);
    const b = idMap.get(edge.b);
    if (a === undefined || b === undefined || a === b) continue;
    await active.insertEdge(a, b, { strength: edge.strength, kind: edge.kind });
  }
  // 备份同时带了旧 MemoryRecord；恢复后不要再让增量迁移把它们重复导一遍。
  await active.setMeta("legacy_migrated", "1");
  return true;
}

/** 读快照（UI 刷新用）。 */
export async function readNmsSnapshot(now?: number): Promise<NmsSnapshot> {
  return (await getNmsStore()).snapshot({ now });
}

/** 手动浅睡。 */
export async function runManualLightSleep(now?: number): Promise<{ ok: boolean; stats: unknown; error: string }> {
  try {
    const active = await getNmsStore();
    const stats = await runLightSleep(active, { now });
    return { ok: true, stats, error: "" };
  } catch (error) {
    return { ok: false, stats: null, error: String(error instanceof Error ? error.message : error) };
  }
}

/** 撤回一轮：删掉该轮 pending。 */
export async function deleteNmsTurn(sessionId: string, turn: number): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const active = await getNmsStore();
  await active.deletePendingTurn(sessionId, turn);
}

/** 旧 UI 的「删记忆」映射成归档（NMS 不物理删）。 */
export async function archiveNmsNode(id: number): Promise<void> {
  await (await getNmsStore()).updateNode(id, { archived: true });
}

/** 冻结语气（旧 DreamState.voice 的只读副本）。 */
export async function readNmsFrozenVoice(): Promise<{ text: string; updatedAt: string; basis: number } | null> {
  return readFrozenVoice(await getNmsStore());
}

/** 仅供测试：关闭并复位单例。 */
export async function resetNmsControllerForTest(): Promise<void> {
  initialized = false;
  const active = store;
  store = null;
  opening = null;
  if (active !== null) {
    try {
      await active.close();
    } catch {
      /* 已关闭 */
    }
  }
}
