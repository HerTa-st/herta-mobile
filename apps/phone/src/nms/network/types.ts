/**
 * NMS 网络视图的数据契约。
 *
 * 输入是 packages/nms 的 `NmsStore.snapshot()`（见 packages/nms/src/types.ts 的
 * NmsSnapshot）；这里只声明画布需要的列，用可选字段容忍旧快照与测试数据。
 * 画布内部一律用 0..n-1 的连续索引作节点 id，原始 id 留在 `rawId` 里给激活事件
 * 和选中回调用；边也只存索引。
 */

export type NmsTier = "ep" | "sem" | "note";

export type NmsNodeId = string | number;

/** 本地快照里的节点（NmsSnapshotNode 的结构子集）。 */
export interface NmsSnapshotNode {
  id: NmsNodeId;
  tier: NmsTier | string;
  workspace?: string | null;
  title?: string;
  gist?: string;
  /** 正文只在节点详情卡里用；snapshot 默认不带，缺省时退回 gist。 */
  body?: string;
  weight?: number;
  /** store 已经按半衰期算过时直接采用；否则 normalize 现场算。 */
  effectiveWeight?: number;
  recalls?: number;
  createdAt?: string;
  lastRecallAt?: string | null;
  archived?: boolean;
  forgotten?: boolean;
}

/** 本地快照里的边；a/b 是原始节点 id（store 保证 a < b）。 */
export interface NmsSnapshotEdge {
  a: NmsNodeId;
  b: NmsNodeId;
  strength: number;
  kind?: string;
}

/** 只读取半衰期与统计；兼容 NmsSnapshot["stats"] 的嵌套形状。 */
export interface NmsSnapshotStatsInput {
  halfLifeDays?: number;
  total?: number;
  counts?: Partial<Record<NmsTier, number>>;
  nodes?: { total?: number; byTier?: Partial<Record<NmsTier, number>> };
  edges?: number | { total?: number };
}

export interface NmsSnapshotInput {
  nodes: NmsSnapshotNode[];
  edges?: NmsSnapshotEdge[];
  stats?: NmsSnapshotStatsInput;
}

/** 画布节点：id 是过滤后的连续索引。 */
export interface NmsCanvasNode {
  /** 0..n-1，数组下标即 id。 */
  id: number;
  /** 本地 store 的原始 id，给激活事件与外部回调用。 */
  rawId: NmsNodeId;
  /** 稳定键（= String(rawId)），选中态与激活模型都用它。 */
  key: string;
  tier: NmsTier;
  workspace: string | null;
  title: string;
  gist: string;
  body: string;
  /** store 里的基础权重（未做时间衰减），决定节点半径。 */
  weight: number;
  /** 按 lastRecallAt + 半衰期算出的有效权重，决定 LOD 排序与详情卡。 */
  effectiveWeight: number;
  recalls: number;
  createdAt: string;
  lastRecallAt: string;
  x: number;
  y: number;
  z: number;
  /** 相邻节点索引（无向，重复边会重复出现）。 */
  links: number[];
  /** 邻接表，BFS 用 O(1) 判断。 */
  nb: Record<number, number>;
}

export interface NmsCanvasEdge {
  a: number;
  b: number;
  s: number;
}

export interface NmsCanvasStats {
  /** 过滤后可见节点的三级计数。 */
  counts: Record<NmsTier, number>;
  total: number;
  edges: number;
  halfLifeDays: number;
}

export interface NmsCanvasData {
  nodes: NmsCanvasNode[];
  edges: NmsCanvasEdge[];
  stats: NmsCanvasStats;
}

/* ------------------------------------------------------------------ 激活 */

/** `nms_recall` 触发的点亮事件里的一条种子节点。 */
export interface NmsActivationNodeRef {
  id: NmsNodeId;
  activation: number;
}

/** 同进程 ingest 的原始事件（原先来自 SSE /nms/api/events）。 */
export interface NmsActivationEvent {
  seq?: string | number | null;
  at?: string;
  query?: string;
  nodes: NmsActivationNodeRef[];
}

/** store 内部保存的事件：receivedAtMs 用于时间衰减。 */
export interface NmsActivationEventRecord {
  seq?: string | number | null;
  at?: string;
  query: string;
  nodes: NmsActivationNodeRef[];
  receivedAtMs: number;
}

export interface NmsActivationSnapshot {
  version: number;
  enabled: boolean;
  pulseMs: number;
  retainMs: number;
  events: NmsActivationEventRecord[];
}

/** 扩散完的每事件亮度：key -> 0..1。 */
export interface NmsActivationLevelEvent {
  atMs: number;
  levels: Map<string, number>;
}

export interface NmsActivationModel {
  version: number;
  enabled: boolean;
  pulseMs: number;
  retainMs: number;
  events: NmsActivationLevelEvent[];
}
