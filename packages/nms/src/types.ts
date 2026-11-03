/**
 * NMS 移动内核的公共类型。
 *
 * 与 DSH 版 dsh-neural-memory 的 store 形状保持一致；手机端只保留核心五表，
 * 单 persona（herta），workspace 固定 null。
 */

export type NmsTier = "ep" | "sem" | "note";

export interface NmsHistoryEntry {
  at?: string;
  kind?: string;
  [key: string]: unknown;
}

export interface NmsNode {
  id: number;
  tier: NmsTier;
  persona: string;
  workspace: string | null;
  title: string;
  gist: string;
  body: string;
  weight: number;
  recalls: number;
  createdAt: string;
  lastRecallAt: string | null;
  forgotten: boolean;
  archived: boolean;
  mergedInto: number | null;
  consolidatedCount: number;
  lastConsolidatedAt: string | null;
  semanticizedAt: string | null;
  history: NmsHistoryEntry[];
}

export interface NmsNodeInput {
  tier?: NmsTier;
  persona?: string;
  workspace?: string | null;
  title: string;
  gist?: string;
  body?: string;
  weight?: number;
  recalls?: number;
  createdAt?: string;
  lastRecallAt?: string | null;
  now?: number;
}

export interface NmsNodeFilter {
  tier?: NmsTier | NmsTier[];
  persona?: string;
  workspace?: string | null;
  includeArchived?: boolean;
  includeForgotten?: boolean;
  limit?: number;
}

export interface NmsNodePatch {
  title?: string;
  gist?: string;
  body?: string;
  weight?: number;
  recalls?: number;
  lastRecallAt?: string | null;
  forgotten?: boolean;
  archived?: boolean;
  mergedInto?: number | null;
  consolidatedCount?: number;
  lastConsolidatedAt?: string | null;
  semanticizedAt?: string | null;
  history?: NmsHistoryEntry[];
}

export interface NmsEdge {
  a: number;
  b: number;
  strength: number;
  kind: string;
}

export interface NmsPendingTurn {
  id: number;
  sessionId: string;
  persona: string;
  workspace: string | null;
  userText: string;
  assistantText: string;
  turn: number | null;
  createdAt: string;
  consumedAt: string | null;
}

export interface NmsPendingTurnInput {
  sessionId: string;
  userText?: string;
  assistantText?: string;
  turn?: number | null;
  persona?: string;
  workspace?: string | null;
  now?: number;
}

export interface NmsDreamRun {
  id: number;
  startedAt: string;
  endedAt: string | null;
  kind: string;
  stats: Record<string, unknown>;
}

export interface NmsTierCounts {
  ep: number;
  sem: number;
  note: number;
}

export interface NmsStats {
  nodes: {
    total: number;
    active: number;
    archived: number;
    forgotten: number;
    merged: number;
    byTier: NmsTierCounts;
    byWorkspace: Record<string, number>;
  };
  edges: { total: number; avgStrength: number };
  pending: { total: number; unconsumed: number; sessions: number };
  dreams: { count: number; lastAt: string | null; lastKind: string | null };
  halfLifeDays: number;
  generatedAt: string;
}

export interface NmsSnapshotNode {
  id: number;
  tier: NmsTier;
  persona: string;
  workspace: string | null;
  title: string;
  gist: string;
  weight: number;
  effectiveWeight: number;
  recalls: number;
  createdAt: string;
  lastRecallAt: string | null;
}

export interface NmsSnapshot {
  schemaVersion: number;
  generatedAt: string;
  stats: NmsStats;
  nodes: NmsSnapshotNode[];
  edges: NmsEdge[];
}

/** 旧手机端记忆；迁移时使用的结构，避免 packages/nms 反向依赖 @herta/core。 */
export interface LegacyMemoryRecord {
  name: string;
  body: string;
  createdAt: string;
  sessionId?: string;
  tag?: string;
  weight?: number;
  recalls?: number;
  lastRecallAt?: string;
  links?: string[];
  gist?: string;
  deepenNote?: string;
  forgotten?: boolean;
}

export interface LegacyDreamState {
  voice: { text: string; updatedAt: string; basis: number } | null;
  cursors: Record<string, number>;
  made: number;
  skipped: number;
  lastNote: string | null;
  lastConsolidatedCount: number | null;
  lastConsolidationAt: number | null;
  forgottenTotal: number;
}

export interface NmsMigrationResult {
  migrated: number;
  notes: number;
  episodes: number;
  edges: number;
  legacyVoiceKept: boolean;
}
