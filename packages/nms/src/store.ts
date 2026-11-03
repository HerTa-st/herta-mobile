/**
 * NmsStore：移动端异步 store 契约。
 *
 * 对应 DSH NMS store.js 的移动面子集；Capacitor SQLite 的桥是异步的，
 * 所有方法都返回 Promise。引擎层（浅睡/深睡/召回/UI）只依赖这个接口，
 * 这样测试可以用内存实现，真机用 sqlite-store。
 */
import type {
  NmsDreamRun,
  NmsEdge,
  NmsNode,
  NmsNodeFilter,
  NmsNodeInput,
  NmsNodePatch,
  NmsPendingTurn,
  NmsPendingTurnInput,
  NmsSnapshot,
  NmsStats,
} from "./types.ts";
import type { NmsHistoryEntry } from "./types.ts";

export interface NmsStore {
  readonly schemaVersion: number;

  open(): Promise<void>;
  close(): Promise<void>;

  // nodes / edges
  listNodes(filter?: NmsNodeFilter): Promise<NmsNode[]>;
  getNode(id: number): Promise<NmsNode | null>;
  insertNode(input: NmsNodeInput): Promise<NmsNode>;
  updateNode(id: number, patch: NmsNodePatch): Promise<NmsNode | null>;
  appendNodeHistory(id: number, entry: NmsHistoryEntry, options?: { limit?: number }): Promise<void>;
  mergeNodeInto(mainId: number, otherId: number): Promise<{ moved: number; dropped: number }>;
  countMerged(): Promise<number>;
  insertEdge(from: number, to: number, options?: { strength?: number; kind?: string }): Promise<NmsEdge>;
  allEdges(options?: { minStrength?: number }): Promise<NmsEdge[]>;
  neighbors(id: number, options?: { minStrength?: number; includeArchived?: boolean }): Promise<Array<{ node: NmsNode; strength: number; kind: string }>>;

  // 代谢（零 LLM）
  recall(ids: number[], options?: { now?: number; reinforceNode?: number }): Promise<NmsNode[]>;
  reinforce(ids: number[], options?: { delta?: number }): Promise<Array<{ a: number; b: number; strength: number }>>;
  applyDecay(options?: { now?: number; halfLifeDays?: number; floor?: number; persona?: string }): Promise<{ decayed: number; halfLifeDays: number; floor: number }>;
  dedupeByTitle(options?: { now?: number; persona?: string }): Promise<{ archived: number; archivedIds: number[] }>;
  pruneEdges(options?: { minStrength?: number }): Promise<{ pruned: number; minStrength: number }>;
  dreamLight(options?: { now?: number; persona?: string }): Promise<Record<string, unknown>>;

  // pending turns（聊天回合 → 深睡素材）
  insertPendingTurn(input: NmsPendingTurnInput): Promise<number>;
  /** 撤回一轮时删掉对应的 pending；返回实际删除行数。 */
  deletePendingTurn(sessionId: string, turn: number): Promise<number>;
  listPendingTurns(options?: { limit?: number; sessionId?: string }): Promise<NmsPendingTurn[]>;
  consumePendingTurns(ids: number[], options?: { now?: number }): Promise<number>;
  pendingTurnStats(): Promise<{ total: number; unconsumed: number; sessions: number }>;

  // dream 账本
  recordDreamRun(input: { kind?: string; startedAt: string; endedAt?: string | null; stats?: Record<string, unknown> }): Promise<number>;
  lastDreamRun(options?: { kind?: string }): Promise<NmsDreamRun | null>;
  dreamRuns(options?: { limit?: number; kind?: string }): Promise<NmsDreamRun[]>;

  // meta
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;

  // 快照 / 统计
  stats(options?: { now?: number }): Promise<NmsStats>;
  snapshot(options?: { now?: number }): Promise<NmsSnapshot>;
  countNodes(): Promise<number>;
  sizeBytes(): Promise<number>;
}

export class NmsStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NmsStoreError";
    this.code = code;
  }
}
