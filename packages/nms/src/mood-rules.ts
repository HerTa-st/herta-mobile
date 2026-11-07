/**
 * 心情判定的自修改状态。
 *
 * 她可以随时改自己的心情判定，但只能改三段：触发描述 / 判定边界 / 优先级。
 * 八种状态名、输出格式（`状态名|触发`）和数值阈值都由代码锁死——校验在 app 层
 * （core 的 validateMoodSections）做，这里只负责存储与版本。
 *
 * 与 voice_state（packages/nms/src/voice.ts）同一套写法：状态存在 NMS meta 的
 * mood_rules（JSON），不新建表；快照只留 5 条，回滚也是"再生成一版"而不是原地改历史。
 */
import type { NmsStore } from "./store.ts";

/** 状态在 NMS meta 里的键。 */
export const MOOD_RULES_META_KEY = "mood_rules";
/** 回滚快照保留条数。 */
export const MOOD_RULES_SNAPSHOT_LIMIT = 5;

/** 她唯一能改的三段。 */
export interface MoodRuleSections {
  /** 触发描述：八种状态各自在什么情况下出现。 */
  triggers: string;
  /** 判定边界：几条互斥情况怎么落。 */
  boundaries: string;
  /** 优先级：一句话同时像多个状态时谁压谁。 */
  priority: string;
}

/** 某一版判定的完整快照（不含 history，避免自我嵌套）。 */
export interface MoodRuleSnapshot {
  version: number;
  sections: MoodRuleSections;
  updatedAt: string;
  reason: string;
  /** 她为什么这么改：引用的具体对话/记忆。可选。 */
  evidence?: string;
}

/** 当前版 + 更早的版本（新的在前）。 */
export interface MoodRulesState extends MoodRuleSnapshot {
  history: MoodRuleSnapshot[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 三段必须都是非空字符串；缺一段就当整块读不懂。 */
function normalizeSections(value: unknown): MoodRuleSections | null {
  if (!isObject(value)) return null;
  const { triggers, boundaries, priority } = value;
  if (typeof triggers !== "string" || !triggers.trim()) return null;
  if (typeof boundaries !== "string" || !boundaries.trim()) return null;
  if (typeof priority !== "string" || !priority.trim()) return null;
  return { triggers, boundaries, priority };
}

/** 读一条快照；结构不对返回 null（坏一条不影响整块状态）。 */
function normalizeSnapshot(value: unknown): MoodRuleSnapshot | null {
  if (!isObject(value)) return null;
  const version = Number(value.version);
  if (!Number.isInteger(version) || version <= 0) return null;
  const sections = normalizeSections(value.sections);
  if (!sections) return null;
  if (typeof value.updatedAt !== "string" || !value.updatedAt) return null;
  if (typeof value.reason !== "string") return null;
  const snapshot: MoodRuleSnapshot = {
    version,
    sections,
    updatedAt: value.updatedAt,
    reason: value.reason,
  };
  if (typeof value.evidence === "string" && value.evidence.trim()) snapshot.evidence = value.evidence;
  return snapshot;
}

function snapshotOf(state: MoodRulesState): MoodRuleSnapshot {
  const snapshot: MoodRuleSnapshot = {
    version: state.version,
    sections: { ...state.sections },
    updatedAt: state.updatedAt,
    reason: state.reason,
  };
  if (state.evidence) snapshot.evidence = state.evidence;
  return snapshot;
}

function pushHistory(state: MoodRulesState): MoodRuleSnapshot[] {
  return [snapshotOf(state), ...state.history].slice(0, MOOD_RULES_SNAPSHOT_LIMIT);
}

/**
 * 一次改判定之后的新状态：首次 version=1，之后 +1，旧版进历史（新的在前，截 5）。
 *
 * 这里不校验三段（那是 app 层的事）：她的话到底能不能用，由调用方先过
 * core 的 validateMoodSections 再进来。
 */
export function applyMoodRevision(
  prev: MoodRulesState | null,
  sections: MoodRuleSections,
  meta: { reason: string; evidence?: string; now?: number }
): MoodRulesState {
  const updatedAt = new Date(meta.now ?? Date.now()).toISOString();
  const evidence = typeof meta.evidence === "string" && meta.evidence.trim() ? meta.evidence : undefined;
  if (!prev) {
    const first: MoodRulesState = {
      version: 1,
      sections: { ...sections },
      updatedAt,
      reason: meta.reason,
      history: [],
    };
    if (evidence) first.evidence = evidence;
    return first;
  }
  const next: MoodRulesState = {
    version: prev.version + 1,
    sections: { ...sections },
    updatedAt,
    reason: meta.reason,
    history: pushHistory(prev),
  };
  if (evidence) next.evidence = evidence;
  return next;
}

/**
 * 回到某个历史版本：用旧快照的三段生成**新**版本，当前版进历史。
 * 找不到那一版就抛错——调用方（runner）自己吞掉。
 */
export function rollbackMoodRules(prev: MoodRulesState, version: number): MoodRulesState {
  const hit = prev.history.find((item) => item.version === version);
  if (!hit) throw new Error("mood rules: 没有 v" + version + " 的快照");
  return {
    version: prev.version + 1,
    sections: { ...hit.sections },
    updatedAt: new Date().toISOString(),
    reason: "rollback:v" + version,
    history: pushHistory(prev),
  };
}

/** 读状态；没有/损坏/结构不对都当没有，不抛。 */
export async function readMoodRules(store: NmsStore): Promise<MoodRulesState | null> {
  const raw = await store.getMeta(MOOD_RULES_META_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const current = normalizeSnapshot(parsed);
  if (!current) return null;
  const history: MoodRuleSnapshot[] = Array.isArray((parsed as { history?: unknown }).history)
    ? ((parsed as { history: unknown[] }).history
        .map((item) => normalizeSnapshot(item))
        .filter((item): item is MoodRuleSnapshot => item !== null)
        .slice(0, MOOD_RULES_SNAPSHOT_LIMIT))
    : [];
  return { ...current, history };
}

export async function writeMoodRules(store: NmsStore, state: MoodRulesState): Promise<void> {
  await store.setMeta(MOOD_RULES_META_KEY, JSON.stringify(state));
}
