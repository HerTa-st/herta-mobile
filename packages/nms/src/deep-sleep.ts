/**
 * 深睡：把情景记忆夜里重加工一遍（零 LLM 的调度 + 注入式 LLM 调用）。
 *
 * 六阶段（顺序固定，可被预算打断后从游标续跑）：
 *   1. pending       —— 消费手机端 pending_turns（两阶段：worthiness → generation）
 *   2. hygiene       —— 语义卫生：确定性去重 + LLM 分批 keep/archive/merge_into
 *   3. merge         —— 近重复合并：文本相似度先筛候选，LLM 判「是不是同一段经历」，再 LLM 合并
 *   4. semanticize   —— 语义化：把具体情景提炼成 0–1 条 sem 节点，并建 ep→sem 的 derived 边
 *   5. reconsolidate —— 再巩固：高频/高权重的旧情景重写 gist（原文进 history，不删）
 *   6. connect       —— 建边：同 persona+workspace 的相似节点补 assoc 边 + 共语义桥接
 *
 * 移植自 dsh-neural-memory/src/host/deep-sleep.js（逐字对照），差异只有三处：
 *   · store 全部异步：每个 store 调用都 await；原先同步的小函数（readDeepCursor /
 *     readMergeDecisions / rememberMergeDecision / countActiveSemantics / deepSleepStatus /
 *     existingTitles / linkDerived / stageConnect）改成 async 并逐层 await；
 *   · 不搬 dream-bootstrap / sessions.jsonl：pending 阶段只消费手机端 pending_turns。
 *     dream-bootstrap 里的四个纯函数（extractJsonObject / parseWorthiness / parseGenerated /
 *     dedupeKey）内联在本文件 —— 它们不依赖 node 内置，但原文件 import 了 node:fs，不能搬；
 *   · 不搬 persona/voice：单 persona（herta），node.persona 只作为分区字段参与比对。
 *
 * 设计约束（与源实现一致）：
 *   · 纯逻辑 + 注入 caller（async ({stage,system,user,maxTokens,timeoutMs}) => string|null）；
 *   · 任何单步失败只记录并继续，**不抛给宿主**；
 *   · nightCallCap 限制本次 LLM 调用数（1 个单元 0–2 次）；游标存 meta 的 deep_sleep_cursor；
 *   · 不跑真实 API —— 手机端由 transport.stream + collect 包成 caller。
 *
 * TODO(P2): 把 dsh-neural-memory/test/deep-sleep.test.js 的纯函数与六阶段用例移植到
 * packages/nms/test（内存 async store），当前只保证编译与逻辑逐字对照。
 */
import { normalizeTitle, similarity, tokenize } from "./model.ts";
import type { NmsStore } from "./store.ts";
import type { NmsEdge, NmsNode, NmsNodePatch, NmsPendingTurn } from "./types.ts";

/** 深睡进度在 meta 表里的键。 */
export const DEEP_CURSOR_META_KEY = "deep_sleep_cursor";
export const LAST_DEEP_RUN_META_KEY = "deep_sleep_last_run_at";

/** 阶段名（顺序即执行顺序）。 */
export const DEEP_STAGES = Object.freeze([
  "pending",
  "hygiene",
  "merge",
  "semanticize",
  "reconsolidate",
  "connect",
] as const);

export type DeepStage = (typeof DEEP_STAGES)[number];

/** 内部用：可被 string 索引的阶段名表（indexOf/includes 不要求字面量）。 */
const STAGE_NAMES: readonly string[] = DEEP_STAGES;

/** 默认参数（与 DSH 一致）。 */
export const DEEP_SLEEP_DEFAULTS = Object.freeze({
  nightCallCap: 20,
  nightCallCapMax: 200,
  /** 近重复合并的候选门（同 workspace / 跨 workspace）。 */
  mergeSimilaritySameWorkspace: 0.5,
  mergeSimilarityCrossWorkspace: 0.3,
  mergePairLimit: 10,
  /** 语义化：每批最多看几条 ep（一次 LLM 调用），每批最多产出 1 条 sem。 */
  semanticizeLimit: 10,
  /**
   * 语义层软上限：达到后不再新建节点只连边（默认放宽到 300，靠 prompt/去重控质量）。
   * 它只是保险丝，不是质量手段。
   */
  semCap: 300,
  /** 候选语义与既有 sem 的相似度：>=0.75 视为重复（只连边），>=0.9 视为同一事实（合并进既有节点）。 */
  semanticDedupeSimilarity: 0.75,
  semanticMergeSimilarity: 0.9,
  /** 一条新语义至少要被本批几条 episode 支持（或被既有 sem 命中）。 */
  semanticSupportMin: 2,
  /** 语义卫生：确定性去重阈值 + LLM 分批参数。 */
  hygieneDedupSimilarity: 0.85,
  hygieneBatchSize: 12,
  hygieneMaxCalls: 20,
  hygienePromptSemLimit: 40,
  /** 再巩固：资格与上限。 */
  reconsolidateLimit: 5,
  reconsolidateMinAgeDays: 7,
  reconsolidateMinWeight: 0.7,
  reconsolidateMinRecalls: 2,
  maxBodyChars: 1200,
  mergeBodyMaxChars: 1600,
  /** 建边。 */
  connectSimilarity: 0.5,
  connectFallbackSimilarity: 0.3,
  connectMinEdges: 5,
  connectLimit: 12,
  bridgePerSemantic: 6,
  bridgeStrengthFactor: 0.8,
  /** 单次待消费轮次上限。 */
  pendingRowLimit: 200,
  pendingRowsPerChunk: 3,
  /** dream_runs stats 里最多保留多少条 pending 拒绝原因（验收排查用，防 stats 膨胀）。 */
  pendingRejectionLimit: 20,
  /** pending 生成 prompt 里 user/assistant 文本各自的上限（3 行 × 4000 字太长，会稀释指令）。 */
  pendingPromptTextLimit: 6000,
  /** pending 入库后确定性建边：top N + 相似度阈值（不调 LLM）。 */
  pendingLinkTopN: 5,
  pendingLinkSimilarity: 0.15,
  /**
   * 输出上限与超时。
   *
   * 真实模型是 reasoning 模型：思考 token 会先吃掉预算（dream-bootstrap 2026-10-30
   * 实测：300 上限时 18 块里有 6 块在吐文本前就以 max-tokens 结束）。所以这里给足：
   * 判定类 ≥1200，生成类 ≥3000。
   */
  judgeMaxTokens: 1200,
  /* hygiene 一次判 12 条 sem，reasoning 模型在 1200 预算下会在吐 JSON 前 max-tokens
   * 结束（2026-10-30 真实库实测：19 批里 13 批失败）——判定类也要给足。 */
  hygieneMaxTokens: 4000,
  mergeMaxTokens: 3000,
  semanticMaxTokens: 3000,
  reconsolidateMaxTokens: 1500,
  callTimeoutMs: 60_000,
  maxErrors: 20,
});

/** 合并判定在 meta 里的键。key = "a:b"（a<b），value = {verdict, at}。 */
export const MERGE_DECISIONS_META_KEY = "merge_decisions";
/** 决策表上限（按 at 保留最新的）。 */
export const MERGE_DECISIONS_LIMIT = 800;

// ── 类型 ──────────────────────────────────────────────────────────────────────

/** 深睡调用器：由宿主把 chat（transport.stream + collect）适配成这个形状。 */
export type DeepSleepCaller = (args: {
  stage: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}) => Promise<string | null>;

export type DeepSleepOptions = {
  store?: NmsStore | null;
  caller?: DeepSleepCaller | null;
  /** 本次 LLM 调用上限（0–200，默认 20）。 */
  nightCallCap?: number;
  /** 只统计候选，不调 LLM、不写库。 */
  dryRun?: boolean;
  /** 时间源（测试注入）。 */
  now?: number;
};

export type DeepSleepCursor = {
  stage: string;
  hygieneDoneIds: Array<number | string>;
  semanticizeDoneIds: Array<number | string>;
  reconsolidateDoneIds: Array<number | string>;
  connectDone: boolean;
  runCount: number;
  updatedAt: string | null;
};

export type DeepSleepCursorPublic = {
  stage: string;
  hygieneDone: number;
  semanticizeDone: number;
  reconsolidateDone: number;
  connectDone: boolean;
  runCount: number;
  updatedAt: string | null;
};

export type MergeDecision = { verdict: string; at: string };
export type MergeDecisions = Record<string, MergeDecision>;

export type DeepSleepPendingRejection = {
  sessionId: string;
  turn: number | null;
  turns: Array<number | null>;
  reason: string;
};

export type DeepSleepPendingBreakdown = {
  consumed: number;
  inserted: number;
  rejected: number;
  duplicates: number;
  firstRejectionReason: string;
  rejectionReasons: DeepSleepPendingRejection[];
  linkedEdges: number;
};

export type DeepSleepDryRunCounts = {
  pendingTurns: number;
  mergePairs: number;
  semanticizeCandidates: number;
  reconsolidateCandidates: number;
  connectPairs: number;
};

/** 一次深睡的 stats（写进 dream_runs.stats，同时原样返回；永不抛）。 */
export type DeepSleepStats = {
  ok: boolean;
  kind: "deep";
  dryRun: boolean;
  error: string;
  detail: string;
  callsUsed: number;
  callCap: number;
  merged: number;
  mergeRejected: number;
  mergeRejectedRun: number;
  mergeDecided: number;
  semanticized: number;
  semanticNodesCreated: number;
  derivedEdges: number;
  semanticCandidatesRejected: number;
  semCapBlocked: number;
  semArchived: number;
  semMerged: number;
  hygieneCalls: number;
  hygieneBatches: number;
  reconsolidated: number;
  edgesAdded: number;
  bridgesAdded: number;
  pendingConsumed: number;
  pendingInserted: number;
  pendingDuplicates: number;
  pendingRejected: number;
  /** 被拒 pending 的原因摘要（最多 pendingRejectionLimit 条；deepSleepStatus 会带上）。 */
  pendingRejections: DeepSleepPendingRejection[];
  /** pending 入库时确定性建的 assoc 边数（纯本地，零 LLM 调用）。 */
  pendingLinkedEdges: number;
  duplicates: number;
  badJson: number;
  budgetExhausted: boolean;
  dryRunCounts: DeepSleepDryRunCounts | null;
  cursorBefore: DeepSleepCursorPublic | null;
  cursor: DeepSleepCursorPublic | null;
  errors: string[];
  startedAt: string;
  endedAt: string | null;
  runId: number;
  // 跑完（或 dryRun）后补的字段。
  hygieneDone?: number;
  semCount?: number;
  semCap?: number;
  pending?: DeepSleepPendingBreakdown;
};

/** 计划函数只依赖这些字段（便于用测试向量里的「半个节点」直接跑）。 */
export type NmsPlanNode = {
  id: number;
  title?: string | null;
  gist?: string | null;
  persona?: string | null;
  workspace?: string | null;
  tier?: string;
  archived?: boolean;
  forgotten?: boolean;
  mergedInto?: number | null;
  weight?: number;
  recalls?: number;
  createdAt?: string | null;
  lastConsolidatedAt?: string | null;
};

/** 文本相似度只依赖 title/gist（允许传测试向量里的「半个节点」）。 */
export type ComparableNode = { title?: string | null; gist?: string | null };

/** 提示词里描述一条记忆需要的字段。 */
export type NmsPromptNode = {
  title: string;
  gist?: string | null;
  body?: string | null;
  workspace?: string | null;
  createdAt?: string | null;
  recalls: number;
};

// ── 行/节点小工具 ─────────────────────────────────────────────────────────────

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function clip(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function messageOf(error: unknown): string {
  return String(error !== null && typeof error === "object" && "message" in error ? (error as { message: unknown }).message : error);
}

function daysSince(iso: string | null | undefined, now: number): number {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, (now - at) / 86_400_000);
}

function pushError(stats: DeepSleepStats, message: string): void {
  if (stats.errors.length < DEEP_SLEEP_DEFAULTS.maxErrors) stats.errors.push(message);
}

/** 节点可比较文本（标题 + 要点）。 */
export function comparableText(node: ComparableNode | null | undefined): string {
  return String(node?.title ?? "") + " " + String(node?.gist ?? "");
}

/** 两条记忆的文本相似度（CJK bigram + 英文词的余弦）。 */
export function memorySimilarity(a: ComparableNode | null | undefined, b: ComparableNode | null | undefined): number {
  return similarity(tokenize(comparableText(a)), tokenize(comparableText(b)));
}

// ── dream-bootstrap 的纯函数（内联：原文件 import 了 node:fs，不能搬）──────────

/** 生成阶段的截断边界（原 BOOTSTRAP_DEFAULTS 的相关字段）。 */
const GENERATION_LIMITS = Object.freeze({
  maxTitleChars: 60,
  maxGistChars: 120,
  maxBodyChars: 1200,
  maxTags: 4,
  minWeight: 0.2,
  maxWeight: 0.95,
  defaultWeight: 0.5,
});

function clipString(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

const FENCE = String.fromCharCode(96).repeat(3);

/**
 * 从模型输出里取出第一个 JSON 对象（容忍代码围栏与前后废话）。
 * 原样移植自 dream-bootstrap.js。
 */
export function extractJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text.length === 0) return null;
  // 去掉模型最常见的多余包裹：三反引号围栏（可能带 json 语言标记）。
  if (text.startsWith(FENCE)) {
    text = text.slice(FENCE.length);
    if (text.slice(0, 4).toLowerCase() === "json") text = text.slice(4);
  }
  if (text.endsWith(FENCE)) text = text.slice(0, -FENCE.length);
  text = text.trim();

  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 解析 worthiness 输出（原 parseWorthiness：worthy 必须是 boolean，否则 null）。 */
export function parseWorthiness(raw: unknown): { worthy: boolean; reason: string; occasion: string } | null {
  const parsed = extractJsonObject(raw);
  if (parsed === null) return null;
  if (typeof parsed.worthy !== "boolean") return null;
  return {
    worthy: parsed.worthy === true,
    reason: clipString(parsed.reason, 200),
    occasion: clipString(parsed.occasion, 200),
  };
}

export type GeneratedMemory =
  | { ok: true; title: string; gist: string; body: string; tier: "ep"; weight: number; tags: string[] }
  | { ok: false; error: string };

/**
 * 解析 generation 输出并清洗成可入库的形状。
 * 原样移植自 dream-bootstrap.js 的 parseGenerated（默认 limits 同 BOOTSTRAP_DEFAULTS）。
 */
export function parseGenerated(
  raw: unknown,
  limits: { maxTitleChars?: number; maxGistChars?: number; maxBodyChars?: number } = {},
): GeneratedMemory {
  const maxTitle = limits.maxTitleChars ?? GENERATION_LIMITS.maxTitleChars;
  const maxGist = limits.maxGistChars ?? GENERATION_LIMITS.maxGistChars;
  const maxBody = limits.maxBodyChars ?? GENERATION_LIMITS.maxBodyChars;
  const parsed = extractJsonObject(raw);
  if (parsed === null) return { ok: false, error: "输出不是合法 JSON 对象" };
  if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
    return { ok: false, error: "模型声明无可写内容：" + clipString(parsed.error, 120) };
  }
  const title = clipString(parsed.title, maxTitle).trim();
  if (title.length === 0) return { ok: false, error: "缺少 title" };
  const bodyRaw = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (bodyRaw.length === 0) return { ok: false, error: "缺少 body" };
  const gist = clipString(parsed.gist, maxGist).trim();
  const weightHint = Number(parsed.weightHint);
  const weight = Number.isFinite(weightHint)
    ? clampNumber(weightHint, GENERATION_LIMITS.minWeight, GENERATION_LIMITS.maxWeight, GENERATION_LIMITS.defaultWeight)
    : GENERATION_LIMITS.defaultWeight;
  const tags: string[] = [];
  if (Array.isArray(parsed.tags)) {
    for (const tag of parsed.tags) {
      if (typeof tag !== "string") continue;
      const clean = clipString(tag, 20).trim();
      if (clean.length > 0 && !tags.includes(clean)) tags.push(clean);
      if (tags.length >= GENERATION_LIMITS.maxTags) break;
    }
  }
  return {
    ok: true,
    title,
    gist: gist.length > 0 ? gist : title,
    body: clipString(bodyRaw, maxBody),
    tier: "ep",
    weight,
    tags,
  };
}

/** 去重键：persona + workspace + 归一化标题（原 dedupeKey）。 */
export function dedupeKey({ persona, workspace, title }: { persona?: string | null; workspace?: string | null; title: string }): string {
  return [persona ?? "", workspace ?? "", normalizeTitle(String(title ?? ""))].join("\u0000");
}

// ── 提示词 ────────────────────────────────────────────────────────────────────

function describeNode(node: NmsPromptNode, label: string): string {
  return [
    label + "：",
    "标题：" + node.title,
    "要点：" + (node.gist || "（无）"),
    "正文：" + clip(node.body, 600) || "（无）",
    "工作区：" + (node.workspace ?? "人格层"),
    "创建时间：" + (node.createdAt ?? "未知"),
    "被想起次数：" + node.recalls,
  ].join("\n");
}

/** 判定两条记忆是不是「同一段经历」（不是同项目/同主题）。 */
export function buildMergeJudgePrompt({ a, b }: { a: NmsPromptNode; b: NmsPromptNode }): { system: string; user: string } {
  const system = [
    "你在整理一个长期运行的 AI agent 的情景记忆。",
    "判断下面两条记忆是否在讲【同一段经历】—— 同一件事、同一次讨论、同一次决定。",
    "注意：同一个项目的不同片段、不同时间发生的两件事、同一主题的不同方面，即使很像，也必须判 false。",
    "宁可判 false，也不要把两段独立的经历揉成一段。",
    "只输出一个 JSON 对象，不要输出别的文字：",
    '{"sameExperience": true 或 false, "reason": "一句话理由"}',
  ].join("\n");
  const user = describeNode(a, "记忆 A") + "\n\n" + describeNode(b, "记忆 B");
  return { system, user };
}

/** 解析合并判定。 */
export function parseMergeVerdict(raw: unknown): { sameExperience: boolean; reason: string } | null {
  const parsed = extractJsonObject(raw);
  if (parsed === null || typeof parsed.sameExperience !== "boolean") return null;
  return {
    sameExperience: parsed.sameExperience === true,
    reason: clip(parsed.reason, 200),
  };
}

/** 让 LLM 把两条记忆合并成一条。 */
export function buildMergeWritePrompt({ a, b, existingTitles = [] }: { a: NmsPromptNode; b: NmsPromptNode; existingTitles?: string[] }): { system: string; user: string } {
  const system = [
    "把两条【讲同一段经历】的记忆合并成一条情景记忆。",
    "用记忆主人的第一人称（我）写；只写两条材料里确实存在的事实，不补充、不编造；保留关键决定与原因。",
    "keep 字段选哪条作主节点：选信息更完整、并进另一条更自然的那条（a 或 b）。",
    "标题不要与已有标题重复。",
    "只输出一个 JSON 对象，不要输出别的文字：",
    '{"title": "不超过 24 字", "gist": "不超过 60 字", "body": "120 到 400 字的第一人称正文", "keep": "a 或 b"}',
  ].join("\n");
  const existing = existingTitles.length === 0 ? "（无）" : existingTitles.slice(0, 30).map((title) => "- " + title).join("\n");
  const user = [describeNode(a, "记忆 A"), "", describeNode(b, "记忆 B"), "", "已有标题（不要重复）：", existing].join("\n");
  return { system, user };
}

export type MergedNode =
  | { ok: true; title: string; gist: string; body: string; keep: "a" | "b" | "" }
  | { ok: false; error: string };

/** 解析合并结果。 */
export function parseMergedNode(
  raw: unknown,
  { maxBodyChars = DEEP_SLEEP_DEFAULTS.mergeBodyMaxChars }: { maxBodyChars?: number } = {},
): MergedNode {
  const parsed = extractJsonObject(raw);
  if (parsed === null) return { ok: false, error: "输出不是 JSON 对象" };
  const title = clip(parsed.title, 60);
  const gist = clip(parsed.gist, 120);
  const body = clip(parsed.body, maxBodyChars);
  if (title.length === 0) return { ok: false, error: "缺少 title" };
  if (gist.length === 0 && body.length === 0) return { ok: false, error: "gist 与 body 都为空" };
  const keep = parsed.keep === "b" ? "b" : parsed.keep === "a" ? "a" : "";
  return { ok: true, title, gist: gist.length > 0 ? gist : title, body, keep };
}

export type SemanticPromptEpisode = {
  id: number;
  title: string;
  gist?: string | null;
  body?: string | null;
  workspace?: string | null;
};

export type SemanticPromptExisting = { id: number; title: string; gist?: string | null };

/** 语义化：一次看一批 episode，最多产出一条语义；先跟既有语义比对。 */
export function buildSemanticizeBatchPrompt({
  episodes = [],
  existingSemantics = [],
}: {
  episodes?: SemanticPromptEpisode[];
  existingSemantics?: SemanticPromptExisting[];
}): { system: string; user: string } {
  const system = [
    "你在维护一个长期记忆系统里的【语义层】。语义层只放**跨情景稳定成立**的事实、偏好与模式，条目数应当远少于情景层。",
    "输入是本批最多 10 条情景记忆（id / 标题 / 要点 / 正文摘要）。请判断：这些情景合起来是否支持**恰好 0 或 1 条**新的语义记忆。",
    "一条新语义成立的硬性条件（满足任一）：",
    "1) 至少被本批 2 条不同情景支持，在 supportingIds 里列出这些情景 id；",
    "2) 它描述的是反复出现的用户偏好/约束/协作方式（不是某一次事件）。",
    "明确禁止：把单条 episode 复述成短句、一次性事件、空泛总结（如「用户喜欢高效协作」「项目很重要」）、材料里没有的推测。",
    "输出前**先与「既有语义」逐条比对**：若其中某条已经表达同一件事，不要造新词——返回 linkExisting 为该条 id（不新建节点）。",
    "只输出一个 JSON 对象，不要输出别的文字：",
    '{"semantic": null, "reason": "为什么本批不产出语义"}',
    "或：",
    '{"semantic": {"title": "不超过 24 字", "gist": "不超过 60 字", "body": "40 到 200 字", "strength": 0.3 到 0.9 的数字, "supportingIds": [支持它的情景 id], "linkExisting": null 或 既有语义 id}, "reason": "一句话"}',
  ].join("\n");
  const epLines = episodes.map((ep) =>
    "#" + ep.id + " 标题：" + ep.title + " | 要点：" + (ep.gist || "（无）") + " | 工作区：" + (ep.workspace ?? "人格层") +
    " | 正文摘要：" + (ep.body || "（无）"),
  );
  const semLines = existingSemantics.slice(0, DEEP_SLEEP_DEFAULTS.hygienePromptSemLimit).map((sem) =>
    "#" + sem.id + " " + sem.title + " | " + (sem.gist || "（无）"),
  );
  const user = [
    "=== 本批情景记忆（" + episodes.length + " 条）===",
    ...epLines,
    "",
    "=== 既有语义（最多 40 条，判断是否已等价）===",
    semLines.length > 0 ? semLines.join("\n") : "（无）",
  ].join("\n");
  return { system, user };
}

export type SemanticCandidate = {
  title: string;
  gist: string;
  body: string;
  strength: number;
  supportingIds: number[];
  linkExisting: number | null;
};

export type SemanticCandidateResult =
  | { ok: true; semantic: SemanticCandidate | null; reason: string }
  | { ok: false; error: string };

/** 解析语义化批次输出。 */
export function parseSemanticCandidate(raw: unknown): SemanticCandidateResult {
  const parsed = extractJsonObject(raw);
  if (parsed === null) return { ok: false, error: "输出不是 JSON 对象" };
  if (parsed.semantic === null || parsed.semantic === undefined) {
    return { ok: true, semantic: null, reason: clip(parsed.reason, 160) };
  }
  const item: unknown = parsed.semantic;
  if (item === null || typeof item !== "object") return { ok: false, error: "semantic 形状不对" };
  const record = item as Record<string, unknown>;
  const title = clip(record.title, 60);
  if (title.length === 0) return { ok: false, error: "缺少 semantic.title" };
  const supportingIds = Array.isArray(record.supportingIds)
    ? record.supportingIds.filter((id) => Number.isInteger(id) && id > 0)
    : [];
  // 与源实现一致：linkExisting 只接受「数字类型的整数」，字符串 "9" 不算（Number.isInteger 不为字符串转换）。
  const linkExisting =
    typeof record.linkExisting === "number" && Number.isInteger(record.linkExisting) && record.linkExisting > 0
      ? record.linkExisting
      : null;
  return {
    ok: true,
    semantic: {
      title,
      gist: clip(record.gist, 120) || title,
      body: clip(record.body, 300),
      strength: clampNumber(record.strength, 0.3, 0.9, 0.55),
      supportingIds,
      linkExisting,
    },
    reason: clip(parsed.reason, 160),
  };
}

export type HygienePromptNode = {
  id: number;
  persona?: string | null;
  title: string;
  gist?: string | null;
  body?: string | null;
  weight: number;
  recalls: number;
};

/**
 * 语义卫生：一批 sem 逐条给 verdict。
 *
 * 目标是**保真清理**：只清掉一次性事件复述/噪声/空泛条目，绝不杀项目事实、决策与偏好。
 */
export function buildHygienePrompt({
  batch = [],
  existingSems = [],
}: {
  batch?: HygienePromptNode[];
  existingSems?: SemanticPromptExisting[];
}): { system: string; user: string } {
  const system = [
    "你在给长期记忆系统的【语义层】做卫生清理。语义层里放的是**跨情景稳定成立**的事实、偏好、决策与模式。",
    "这个系统的语义层抽样如下（大多是**好的**，请按同一标准判断）：",
    "  正面例子（保留）：HerTa 主题随插件包一起分发 / HerTa 按 ADR-0003 处理遗留改动 / HerTa 整机设置以 DSH 为唯一真相 / HerTa 发版 npm 凭据须本人在 TTY 登录 / dsh-herta 行高最终倾向压紧 / herta-mobile 字距偏好偏紧。",
    "  反面例子（归档）：某天把某个按钮改完了 / 某次对话里汇报了三条进度 / 用户今天说了一声谢谢 / 完成了一次发版检查。",
    "对每条语义给出一个 verdict：",
    "  keep —— 五年后仍然成立、且不是「某天发生了什么」；项目事实 / 用户偏好 / 决策及其原因 / 反复出现的模式都归这类。",
    "  archive —— 只是一次性事件的复述、某天完成了什么、纯进度汇报、空泛到没有具体信息、或明显噪声。",
    "  merge_into:<id> —— 与列表里另一条语义是同一事实的两种说法，给出目标 id。",
    "判断标准要严格：**宁可保留，错杀一条项目事实的代价远大于留一条弱语义**。不要为了达到某个数量目标而归档。",
    "只输出一个 JSON 对象，不要输出别的文字：",
    '{"decisions": [{"id": 12, "verdict": "keep 或 archive 或 merge_into:34", "reason": "一句话"}]}',
    "必须对输入里的每一条都给出 verdict。",
  ].join("\n");
  const batchLines = batch.map((sem) =>
    "#" + sem.id + " [" + (sem.persona ?? "?") + "] " + sem.title + " | 要点：" + (sem.gist || "（无）") +
    " | 正文：" + clip(sem.body, 300) + " | weight=" + sem.weight + " recalls=" + sem.recalls,
  );
  const otherLines = existingSems
    .filter((sem) => !batch.some((item) => item.id === sem.id))
    .slice(0, DEEP_SLEEP_DEFAULTS.hygienePromptSemLimit)
    .map((sem) => "#" + sem.id + " " + sem.title + " | " + (sem.gist || "（无）"));
  const user = [
    "=== 待判断的语义（" + batch.length + " 条）===",
    ...batchLines,
    "",
    "=== 其他已有语义（可用于 merge_into 目标）===",
    otherLines.length > 0 ? otherLines.join("\n") : "（无）",
  ].join("\n");
  return { system, user };
}

export type HygieneDecision = {
  id: number;
  action: "keep" | "archive" | "merge";
  mergeInto: number | null;
  reason: string;
};

export type HygieneDecisionResult = { ok: true; decisions: HygieneDecision[] } | { ok: false; error: string };

/**
 * 解析 hygiene 决策。verdict 支持 keep / archive / merge_into:<id>。
 */
export function parseHygieneDecisions(raw: unknown, validIds: number[] = []): HygieneDecisionResult {
  const parsed = extractJsonObject(raw);
  if (parsed === null || !Array.isArray(parsed.decisions)) return { ok: false, error: "缺少 decisions 数组" };
  const valid = new Set(validIds);
  const decisions: HygieneDecision[] = [];
  for (const item of parsed.decisions as unknown[]) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = Number(record.id);
    if (!Number.isInteger(id) || !valid.has(id)) continue;
    const verdict = typeof record.verdict === "string" ? record.verdict.trim() : "";
    let action: HygieneDecision["action"] = "keep";
    let mergeInto: number | null = null;
    if (verdict === "archive") action = "archive";
    else if (verdict.startsWith("merge_into:")) {
      const target = Number(verdict.slice("merge_into:".length));
      if (!Number.isInteger(target) || target <= 0 || target === id) continue;
      action = "merge";
      mergeInto = target;
    } else if (verdict !== "keep") continue;
    decisions.push({ id, action, mergeInto, reason: clip(record.reason, 160) });
  }
  return { ok: true, decisions };
}

/** 再巩固：重写 gist（可选正文摘要），原文保留在 history。 */
export function buildReconsolidatePrompt({ node }: { node: NmsPromptNode }): { system: string; user: string } {
  const system = [
    "下面这条情景记忆被多次回忆过（或权重很高）。按现在的语境把它重写成更准确的要点。",
    "硬性要求：只使用原文里已有的事实；不补充、不编造；如果原文有过期或含糊之处，在新要点里写清楚，但不要删除原文（原文会保留在历史里）。",
    "只输出一个 JSON 对象，不要输出别的文字：",
    '{"gist": "1 到 2 句、不超过 120 字的要点", "bodySummary": "可选：不超过 600 字的更紧凑正文摘要；没有就留空字符串"}',
  ].join("\n");
  return { system, user: describeNode(node, "情景记忆") };
}

/** 解析再巩固结果。 */
export function parseReconsolidated(raw: unknown): { gist: string; bodySummary: string } | null {
  const parsed = extractJsonObject(raw);
  if (parsed === null) return null;
  const gist = clip(parsed.gist, 120);
  if (gist.length === 0) return null;
  return { gist, bodySummary: clip(parsed.bodySummary, 600) };
}

// ── 候选规划（纯函数，可单测）────────────────────────────────────────────────

/**
 * 近重复合并候选对：相似度 ≥0.3（跨 workspace）或 ≥0.5（同 workspace）。
 * 返回按相似度降序的 [{a, b, similarity, sameWorkspace}]。
 */
export function findMergePairs(
  nodes: NmsPlanNode[],
  options: {
    mergeSimilaritySameWorkspace?: number;
    mergeSimilarityCrossWorkspace?: number;
    mergePairLimit?: number;
  } = {},
): Array<{ a: NmsPlanNode; b: NmsPlanNode; similarity: number; sameWorkspace: boolean }> {
  const sameThreshold = options.mergeSimilaritySameWorkspace ?? DEEP_SLEEP_DEFAULTS.mergeSimilaritySameWorkspace;
  const crossThreshold = options.mergeSimilarityCrossWorkspace ?? DEEP_SLEEP_DEFAULTS.mergeSimilarityCrossWorkspace;
  const active = (Array.isArray(nodes) ? nodes : []).filter(
    (node) => node.tier === "ep" && !node.archived && !node.forgotten && node.mergedInto === null,
  );
  const pairs: Array<{ a: NmsPlanNode; b: NmsPlanNode; similarity: number; sameWorkspace: boolean }> = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      const sim = memorySimilarity(a, b);
      const sameWorkspace = (a.workspace ?? "") === (b.workspace ?? "");
      const threshold = sameWorkspace ? sameThreshold : crossThreshold;
      if (sim >= threshold) pairs.push({ a, b, similarity: sim, sameWorkspace });
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity || x.a.id - y.a.id);
  return pairs;
}

/**
 * 建边候选：同 persona+workspace 且相似度 ≥ 阈值、当前无边的节点对。
 * 相似度降序；少于 connectMinEdges 时用 fallback 阈值补。
 */
export function planConnectPairs(
  nodes: NmsPlanNode[],
  edges: Array<Pick<NmsEdge, "a" | "b">>,
  options: {
    connectSimilarity?: number;
    connectFallbackSimilarity?: number;
    connectMinEdges?: number;
    connectLimit?: number;
  } = {},
): Array<{ a: NmsPlanNode; b: NmsPlanNode; similarity: number }> {
  const threshold = options.connectSimilarity ?? DEEP_SLEEP_DEFAULTS.connectSimilarity;
  const fallback = options.connectFallbackSimilarity ?? DEEP_SLEEP_DEFAULTS.connectFallbackSimilarity;
  const minEdges = options.connectMinEdges ?? DEEP_SLEEP_DEFAULTS.connectMinEdges;
  const limit = options.connectLimit ?? DEEP_SLEEP_DEFAULTS.connectLimit;
  const active = (Array.isArray(nodes) ? nodes : []).filter(
    (node) => !node.archived && !node.forgotten && node.mergedInto === null,
  );
  const existing = new Set((Array.isArray(edges) ? edges : []).map((edge) => Math.min(edge.a, edge.b) + ":" + Math.max(edge.a, edge.b)));
  const scored: Array<{ a: NmsPlanNode; b: NmsPlanNode; similarity: number }> = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      if (a.persona !== b.persona) continue;
      if ((a.workspace ?? "") !== (b.workspace ?? "")) continue;
      const key = Math.min(a.id, b.id) + ":" + Math.max(a.id, b.id);
      if (existing.has(key)) continue;
      const sim = memorySimilarity(a, b);
      scored.push({ a, b, similarity: sim });
    }
  }
  scored.sort((x, y) => y.similarity - x.similarity || x.a.id - y.a.id);
  const picked = scored.filter((pair) => pair.similarity >= threshold).slice(0, limit);
  if (picked.length < minEdges) {
    for (const pair of scored) {
      if (picked.length >= Math.max(minEdges, Math.min(limit, DEEP_SLEEP_DEFAULTS.connectLimit))) break;
      if (pair.similarity < fallback) break;
      if (picked.some((chosen) => chosen === pair)) continue;
      picked.push(pair);
    }
  }
  return picked.slice(0, limit);
}

/**
 * 规划 pending 入库后要建的确定性关联边（不调 LLM）。
 *
 * 规则：同 persona、非自连、非归档/遗忘/已合并；标题+gist 的余弦相似度 ≥ 阈值；
 * 按相似度降序取 topN；强度 = 0.3 + 0.7×sim（钳 0.2–0.9）；已有边跳过。
 */
export function planPendingLinks({
  node = null,
  candidates = [],
  existingPairs = [],
  topN = DEEP_SLEEP_DEFAULTS.pendingLinkTopN,
  similarityThreshold = DEEP_SLEEP_DEFAULTS.pendingLinkSimilarity,
}: {
  node?: NmsPlanNode | null;
  candidates?: NmsPlanNode[];
  existingPairs?: Iterable<string> | string[];
  topN?: number;
  similarityThreshold?: number;
} = {}): Array<{ id: number; similarity: number; strength: number }> {
  if (node === null || node === undefined || !Number.isInteger(node.id)) return [];
  const existing = existingPairs instanceof Set ? existingPairs : new Set(Array.isArray(existingPairs) ? existingPairs : []);
  const limit = Math.max(0, Math.floor(Number(topN) || 0));
  const threshold = Number.isFinite(Number(similarityThreshold)) ? Number(similarityThreshold) : 0.15;
  const scored: Array<{ id: number; similarity: number; strength: number }> = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (candidate === null || candidate === undefined) continue;
    if (!Number.isInteger(candidate.id) || candidate.id === node.id) continue;
    if (candidate.persona !== node.persona) continue;
    if (candidate.archived || candidate.forgotten) continue;
    if (candidate.mergedInto !== null && candidate.mergedInto !== undefined) continue;
    if (typeof candidate.title !== "string" || candidate.title.trim().length === 0) continue;
    const pairKey = node.id < candidate.id ? node.id + ":" + candidate.id : candidate.id + ":" + node.id;
    if (existing.has(pairKey)) continue;
    const sim = memorySimilarity(node, candidate);
    if (!(sim >= threshold)) continue;
    scored.push({
      id: candidate.id,
      similarity: Math.round(sim * 1e4) / 1e4,
      strength: Math.round(Math.min(0.9, Math.max(0.2, 0.3 + 0.7 * sim)) * 1e4) / 1e4,
    });
  }
  scored.sort((a, b) => b.similarity - a.similarity || a.id - b.id);
  return scored.slice(0, limit);
}

// ── 游标 ──────────────────────────────────────────────────────────────────────

/**
 * 游标用「已处理的单元 key/id 集合」，不用数组下标：
 * 节点被合并/新增后候选数组会变，下标会错位（第一版就踩过：续跑时跳过了本该处理的第二对）。
 *
 * 合并判定不放在游标里 —— 它要跨「整轮跑完」保留，持久化到 meta 的 merge_decisions。
 */
export function emptyDeepCursor(): DeepSleepCursor {
  return {
    stage: "pending",
    hygieneDoneIds: [],
    semanticizeDoneIds: [],
    reconsolidateDoneIds: [],
    connectDone: false,
    runCount: 0,
    updatedAt: null,
  };
}

const CURSOR_LIST_LIMIT = 500;

function readKeyList(value: unknown, limit = CURSOR_LIST_LIMIT): Array<number | string> {
  if (!Array.isArray(value)) return [];
  const out: Array<number | string> = [];
  for (const item of value) {
    const key = typeof item === "number" ? item : typeof item === "string" ? item : null;
    if (key === null || out.includes(key)) continue;
    out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeCursor(value: unknown): DeepSleepCursor {
  const empty = emptyDeepCursor();
  if (value === null || typeof value !== "object") return empty;
  const raw = value as Record<string, unknown>;
  const stage = STAGE_NAMES.includes(raw.stage as string) || raw.stage === "done" ? String(raw.stage) : "pending";
  return {
    stage,
    hygieneDoneIds: readKeyList(raw.hygieneDoneIds),
    semanticizeDoneIds: readKeyList(raw.semanticizeDoneIds),
    reconsolidateDoneIds: readKeyList(raw.reconsolidateDoneIds),
    connectDone: raw.connectDone === true,
    runCount: clampInt(raw.runCount, 0, 1_000_000, 0),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

export async function readDeepCursor(store: NmsStore | null | undefined): Promise<DeepSleepCursor> {
  if (store === null || store === undefined) return emptyDeepCursor();
  try {
    const raw = await store.getMeta(DEEP_CURSOR_META_KEY);
    if (typeof raw !== "string" || raw.length === 0) return emptyDeepCursor();
    return normalizeCursor(JSON.parse(raw));
  } catch {
    return emptyDeepCursor();
  }
}

async function writeDeepCursor(store: NmsStore, cursor: DeepSleepCursor, now: number): Promise<void> {
  cursor.updatedAt = new Date(now).toISOString();
  try {
    await store.setMeta(DEEP_CURSOR_META_KEY, JSON.stringify(cursor));
  } catch (error) {
    console.log("[nms] deep_sleep 游标写入失败（继续跑）：" + messageOf(error));
  }
}

/** 对外暴露的游标。 */
export function publicDeepCursor(cursor: DeepSleepCursor): DeepSleepCursorPublic {
  return {
    stage: cursor.stage,
    hygieneDone: cursor.hygieneDoneIds.length,
    semanticizeDone: cursor.semanticizeDoneIds.length,
    reconsolidateDone: cursor.reconsolidateDoneIds.length,
    connectDone: cursor.connectDone,
    runCount: cursor.runCount,
    updatedAt: cursor.updatedAt,
  };
}

/** 记录一个已处理单元（去重 + 上限，防止 meta 无限膨胀）。 */
function markDone(list: Array<number | string>, value: number | string): void {
  if (!list.includes(value)) list.push(value);
  while (list.length > CURSOR_LIST_LIMIT) list.shift();
}

// ── 合并判定持久化（merge_decisions）─────────────────────────────────────────

/** 一对节点在决策表里的 key。 */
export function mergePairKey(a: number, b: number): string {
  const lo = Math.min(Number(a), Number(b));
  const hi = Math.max(Number(a), Number(b));
  return lo + ":" + hi;
}

/** 读决策表（坏 JSON 回落空表，不抛）。 */
export async function readMergeDecisions(store: NmsStore | null | undefined): Promise<MergeDecisions> {
  if (store === null || store === undefined) return {};
  try {
    const raw = await store.getMeta(MERGE_DECISIONS_META_KEY);
    if (typeof raw !== "string" || raw.length === 0) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as MergeDecisions) : {};
  } catch {
    return {};
  }
}

/** 按 at 保留最新 N 条。 */
function pruneDecisions(decisions: MergeDecisions): MergeDecisions {
  const entries = Object.entries(decisions);
  if (entries.length <= MERGE_DECISIONS_LIMIT) return decisions;
  entries.sort((x, y) => Date.parse(y[1]?.at ?? "") - Date.parse(x[1]?.at ?? ""));
  const kept: MergeDecisions = {};
  for (const [key, value] of entries.slice(0, MERGE_DECISIONS_LIMIT)) kept[key] = value;
  return kept;
}

/**
 * 记一条合并判定（verdict: "same" | "different" | "invalid"）。
 * 只在判定**处理完成**后调用：判 true 但预算不够写合并时不记，下一轮重问。
 */
export async function rememberMergeDecision(
  store: NmsStore | null | undefined,
  pairKey: string,
  verdict: string,
  now: number = Date.now(),
): Promise<MergeDecision | null> {
  if (store === null || store === undefined) return null;
  try {
    const decisions = await readMergeDecisions(store);
    decisions[pairKey] = { verdict: String(verdict), at: new Date(now).toISOString() };
    await store.setMeta(MERGE_DECISIONS_META_KEY, JSON.stringify(pruneDecisions(decisions)));
    return decisions[pairKey];
  } catch (error) {
    console.log("[nms] merge 决策写入失败（继续跑）：" + messageOf(error));
    return null;
  }
}

/** 活动 sem 计数（给 semCap 与状态用）。 */
export async function countActiveSemantics(store: NmsStore | null | undefined): Promise<number> {
  if (store === null || store === undefined) return 0;
  try {
    const nodes = await store.listNodes({ tier: "sem" });
    return nodes.filter((node) => !node.archived && !node.forgotten && node.mergedInto === null).length;
  } catch {
    return 0;
  }
}

// ── 状态 ──────────────────────────────────────────────────────────────────────

/** 深睡队列概况（给设置页 / 状态面板的 deepQueue / pendingTurns 字段）。 */
export async function deepSleepStatus({
  store = null,
  now = Date.now(),
}: {
  store?: NmsStore | null;
  now?: number;
} = {}): Promise<{
  cursor: DeepSleepCursorPublic;
  pendingTurns: { total: number; unconsumed: number; sessions: number };
  deepQueue: { mergeCandidates: number; semanticizeRemaining: number; reconsolidateRemaining: number };
  semCount: number;
  semCap: number;
  epCount: number;
  semPerEpisode: number | null;
  mergeDecided: number;
  mergeRejected: number;
  lastDeepRun: Record<string, unknown> | null;
  generatedAt: string;
}> {
  const cursor = await readDeepCursor(store);
  const pending =
    store !== null && typeof store.pendingTurnStats === "function"
      ? await store.pendingTurnStats()
      : { total: 0, unconsumed: 0, sessions: 0 };
  const decisions = await readMergeDecisions(store);
  let mergeCandidates = 0;
  let semanticizeRemaining = 0;
  let reconsolidateRemaining = 0;
  let semCount = 0;
  let epCount = 0;
  if (store !== null) {
    try {
      const nodes = await store.listNodes({});
      const eps = nodes.filter((node) => node.tier === "ep" && !node.archived && !node.forgotten && node.mergedInto === null);
      epCount = eps.length;
      semCount = nodes.filter(
        (node) => node.tier === "sem" && !node.archived && !node.forgotten && node.mergedInto === null,
      ).length;
      // 只统计**未判定**的合并对（已判定的对不再计入队列）。
      mergeCandidates = findMergePairs(nodes).filter(
        (pair) => decisions[mergePairKey(pair.a.id, pair.b.id)] === undefined,
      ).length;
      semanticizeRemaining = eps.filter((node) => node.semanticizedAt === null).length;
      reconsolidateRemaining = eps.filter((node) => isReconsolidationCandidate(node, now)).length;
    } catch {
      /* 库不可用时保持 0 —— 状态端点不该因为估算失败而崩 */
    }
  }
  const lastRun = store !== null && typeof store.lastDreamRun === "function" ? await store.lastDreamRun({ kind: "deep" }) : null;
  return {
    cursor: publicDeepCursor(cursor),
    pendingTurns: pending,
    deepQueue: { mergeCandidates, semanticizeRemaining, reconsolidateRemaining },
    semCount,
    semCap: DEEP_SLEEP_DEFAULTS.semCap,
    epCount,
    semPerEpisode: epCount === 0 ? null : Math.round((semCount / epCount) * 100) / 100,
    mergeDecided: Object.keys(decisions).length,
    mergeRejected: Object.values(decisions).filter((entry) => entry?.verdict === "different").length,
    lastDeepRun:
      lastRun === null
        ? null
        : {
            id: lastRun.id,
            startedAt: lastRun.startedAt,
            endedAt: lastRun.endedAt,
            merged: lastRun.stats?.merged ?? 0,
            semMerged: lastRun.stats?.semMerged ?? 0,
            semArchived: lastRun.stats?.semArchived ?? 0,
            hygieneCalls: lastRun.stats?.hygieneCalls ?? 0,
            semanticized: lastRun.stats?.semanticized ?? 0,
            semanticNodesCreated: lastRun.stats?.semanticNodesCreated ?? 0,
            reconsolidated: lastRun.stats?.reconsolidated ?? 0,
            edgesAdded: lastRun.stats?.edgesAdded ?? 0,
            callsUsed: lastRun.stats?.callsUsed ?? 0,
            budgetExhausted: lastRun.stats?.budgetExhausted === true,
            pending: lastRun.stats?.pending ?? {
              consumed: lastRun.stats?.pendingConsumed ?? 0,
              inserted: lastRun.stats?.pendingInserted ?? 0,
              rejected: lastRun.stats?.pendingRejected ?? 0,
              duplicates: lastRun.stats?.pendingDuplicates ?? 0,
              firstRejectionReason: "",
              rejectionReasons: [],
              linkedEdges: lastRun.stats?.pendingLinkedEdges ?? 0,
            },
          },
    generatedAt: new Date(now).toISOString(),
  };
}

/** 一条 ep 是否够格再巩固。 */
export function isReconsolidationCandidate(
  node: NmsPlanNode | null | undefined,
  now: number = Date.now(),
  options: {
    reconsolidateMinWeight?: number;
    reconsolidateMinRecalls?: number;
    reconsolidateMinAgeDays?: number;
  } = {},
): boolean {
  const minWeight = options.reconsolidateMinWeight ?? DEEP_SLEEP_DEFAULTS.reconsolidateMinWeight;
  const minRecalls = options.reconsolidateMinRecalls ?? DEEP_SLEEP_DEFAULTS.reconsolidateMinRecalls;
  const minAgeDays = options.reconsolidateMinAgeDays ?? DEEP_SLEEP_DEFAULTS.reconsolidateMinAgeDays;
  if (node === null || node === undefined || node.tier !== "ep") return false;
  if (node.archived || node.forgotten || node.mergedInto !== null) return false;
  // 与源实现一致：字段缺失时 undefined 的数值比较恒为 false（不把「没填」当成够格/不够格）。
  if (Number(node.recalls) < minRecalls && Number(node.weight) < minWeight) return false;
  const base = node.lastConsolidatedAt ?? node.createdAt;
  return daysSince(base, now) >= minAgeDays;
}

// ── pending worthiness（M2 验收修正版）────────────────────────────────────────

export type PendingPromptSession = { createdAt?: string | null; preset?: string; workspace?: string | null };

/**
 * pending_turns 消费的第一阶段提示词。
 *
 * 与 bootstrap 的 buildWorthinessPrompt 分开：历史会话的「值得长期记」判据更严；
 * 而 pending 是用户**刚刚亲口说过**的轮次，默认应入库，助手是否接住不影响判断。
 */
export function buildPendingWorthinessPrompt({
  session = {},
  rows = [],
  userText = "",
  assistantText = "",
  chunkText = "",
  chunkIndex = 0,
  chunkCount = 1,
  maxText = 6000,
}: {
  session?: PendingPromptSession;
  rows?: NmsPendingTurn[];
  userText?: string;
  assistantText?: string;
  chunkText?: string;
  chunkIndex?: number;
  chunkCount?: number;
  maxText?: number;
} = {}): { system: string; user: string } {
  const clipText = (value: unknown): string => {
    const text = String(value ?? "");
    return text.length > maxText ? text.slice(0, maxText) + "…（截断）" : text;
  };
  const system = [
    "你是长期记忆的整理器。现在判断一段【真实对话轮次】里，用户是否明确说出了值得长期记住的信息。",
    "默认应入库（worthy=true）：用户明确说出的偏好、约定、事件（含时间/地点/人物）、决定、要求、纠正、边界与禁忌、正在做的项目事实。",
    "关键原则：",
    "  · 只看用户说了什么。助手回答是否接住、是否同意、是否说「我不知道 / 我没有记录 / 不确定」，",
    "    都不能作为拒绝理由；用户明确说过的事实，即使助手答不上来，也必须 worthy=true。",
    "  · 宁可多记一条，也不要漏记：拿不准时判 worthy=true（默认应入库）。",
    "请求与安排也算事实：用户提出要你记住、跟进、准备、安排、留意、整理、做完的事（如「周三评审要准备一下」「周五前把清单整理完」「这件事帮我留意」）→ worthy=true；祈使句/待办口吻不构成拒绝理由。",
    "「以后别提 / 不想聊」是边界偏好，不是「不要记」：用户明确说以后别提某件事、不想聊、别再问 → worthy=true，必须入库（生成侧写成「X 以后不提（边界）」这类边界记忆）。只有字面明确说「不要记/别记/忘掉/不用记住」才 worthy=false。",
    "只有以下情况才 worthy=false：",
    "  · 纯寒暄/客套（你好、谢谢、晚安、在吗）；",
    "  · 纯操作性对话（打开文件、运行命令）且没有可长期保留的事实；",
    "  · 用户明确说不要记（不要记、别记、忘掉、不用记住）；",
    "  · 用户只是提问/确认/试探，没有陈述任何新的可长期保留事实（如「上次评审改期定在什么时候？」「评审准备得怎么样了？」「她说「周五那件事」，我这儿是空白」）。",
    "提问里夹带了新事实（如「改到周一了，你知道几点吗」）不算纯提问，要判 worthy=true，并只记新事实。",
    "只输出一个 JSON 对象，不要输出任何别的文字：",
    '{"worthy": true 或 false, "reason": "一句话理由"}',
  ].join("\n");
  const header = [
    "会话时间：" + (session.createdAt ?? "未知"),
    "会话 preset：" + (typeof session.preset === "string" && session.preset.length > 0 ? session.preset : "未知"),
    "工作区：" + (session.workspace ?? "未知"),
  ];
  const turns = rows
    .filter((row) => Number.isInteger(row.turn))
    .map((row) => "#turn " + row.turn)
    .join(" · ");
  if (turns.length > 0) header.push("轮次：" + turns);
  if (chunkCount > 0) header.push("本片段：第 " + (chunkIndex + 1) + " / " + chunkCount + " 段");
  const body = [
    "【用户消息 · 判断依据】",
    clipText(userText || chunkText),
    "【助手回复 · 仅作上下文，不能作为拒绝理由】",
    clipText(assistantText) || "（无）",
  ].join("\n");
  return { system, user: header.join("\n") + "\n\n---\n\n" + body };
}

/**
 * 解析 pending worthiness 输出（宽进严出：坏 JSON 返回 null，由调用方记为 badJson）。
 * 原 parsePendingWorthiness = dream-bootstrap.parseWorthiness + 默认理由，这里合成一处。
 */
export function parsePendingWorthiness(raw: unknown): { worthy: boolean; reason: string } | null {
  const parsed = parseWorthiness(raw);
  if (parsed === null) return null;
  return {
    worthy: parsed.worthy === true,
    reason: parsed.reason.length > 0 ? parsed.reason : parsed.worthy === true ? "用户明确信息" : "不值得记",
  };
}

/**
 * 判断一段生成文本是不是「助手回答/探针」而不是用户事实。
 *
 * 实测缺陷：模型会照着材料里助手的「我记不得 / 没记录 / 我这儿是空白」写记忆。
 * prompt 已经禁止，但真实模型仍可能漏；这里做代码层兜底：命中且用户原文里没有
 * 该短语 → 视为污染，丢弃这条生成（记录拒绝原因，不写库）。
 */
export function looksLikeAssistantArtifact(text: string, { userText = "" }: { userText?: string } = {}): boolean {
  if (typeof text !== "string" || text.trim().length === 0) return false;
  const normalized = text.replace(/\s+/g, "");
  const userNormalized = String(userText ?? "").replace(/\s+/g, "");
  const patterns = [
    /我这儿?没(有)?记录/,
    /我(这儿|这里)?(记忆(里)?)?(是)?空(白|的)/,
    /我(记忆里)?(记不(得|起来))/,
    /我不(确定|知道)/,
    /我(这儿|这里)?没(有)?(相关)?记忆/,
    /探针/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match === null) continue;
    if (userNormalized.includes(match[0])) continue;
    return true;
  }
  return false;
}

// ── pending 请求分类（确定性预判，减少模型把祈使/边界误拒）───────────────────

/** 用户明确说「不要记」——只有这类才该拒绝。 */
const NO_RECORD_RE = /(不要记|别记|忘掉|不用记住|不要记住|别记住)/;
/** 边界偏好：以后别提 / 不想聊 / 别再问 —— 必须入库（是边界，不是「不要记」）。 */
const BOUNDARY_RE = /(以后别提|以后不用提|以后别再提|不想聊|不想再聊|别再问|别再提|到此为止|别提了)/;
/** 请求与安排：要准备 / 帮我留意 / 整理完 / 跟进 / 记住 / 提醒我 —— 也算事实。 */
const ARRANGEMENT_RE = /(要准备|准备一下|帮我留意|帮忙留意|留意一下|整理完|安排|跟进|记住|别忘了|提醒我|排一下|订一下|处理一下)/;
/** 提问/确认/试探（只用于取消“确定性入库”，最终仍由 worthiness 判断）。 */
const QUESTION_RE = /[？?]|(怎么样|什么时候|几点|是谁|还记得|多久|为什么|如何)/;

export type PendingRequestKind = "" | "boundary" | "arrangement";

/**
 * 对 pending 用户文本做确定性预判。
 *
 * 背景：真实模型曾把「周三评审要准备一下」（祈使安排）和「面试失败的事以后别提」
 * （边界偏好）判为不值得记。这里先做两类确定性处理：
 *   · 明确「不要记」→ 直接 reject（不浪费 worthiness 调用）；
 *   · 边界偏好 / 非提问式请求安排 → forceWorthy=true，跳过 worthiness 直接生成；
 * 纯提问不做确定性入库（交给 worthiness，保留「提问夹事实」的判断空间）。
 */
export function classifyPendingRequest(userText: string): {
  forceWorthy: boolean;
  requestKind: PendingRequestKind;
  rejectReason: string;
} {
  const text = typeof userText === "string" ? userText.trim() : "";
  if (text.length === 0) return { forceWorthy: false, requestKind: "", rejectReason: "" };
  if (NO_RECORD_RE.test(text)) return { forceWorthy: false, requestKind: "", rejectReason: "用户明确不要记" };
  // 边界偏好即使带问号（「以后别提了，好吗？」）也应入库，优先判。
  if (BOUNDARY_RE.test(text)) return { forceWorthy: true, requestKind: "boundary", rejectReason: "" };
  const looksQuestion = QUESTION_RE.test(text);
  if (!looksQuestion && ARRANGEMENT_RE.test(text)) {
    return { forceWorthy: true, requestKind: "arrangement", rejectReason: "" };
  }
  return { forceWorthy: false, requestKind: "", rejectReason: "" };
}

/**
 * pending_turns 消费的第二阶段提示词（M2 v2 验收修正版）。
 *
 * 旧实现复用 bootstrap 的 buildGenerationPrompt：把整段对话（含助手回答）丢给模型，
 * 结果模型把助手的「我记不得 / 没记录」写成了记忆。这里把「用户消息」和
 * 「助手回复」显式分开，并规定：只有用户消息是事实来源。
 */
export function buildPendingGenerationPrompt({
  session = {},
  rows = [],
  userText = "",
  assistantText = "",
  existingTitles = [],
  maxText = 6000,
  requestKind = "",
}: {
  session?: PendingPromptSession;
  rows?: NmsPendingTurn[];
  userText?: string;
  assistantText?: string;
  existingTitles?: string[];
  maxText?: number;
  requestKind?: PendingRequestKind | string;
} = {}): { system: string; user: string } {
  const clipText = (value: unknown): string => {
    const text = String(value ?? "");
    return text.length > maxText ? text.slice(0, maxText) + "…（截断）" : text;
  };
  const titleList = existingTitles.length === 0 ? "（无）" : existingTitles.slice(0, 40).map((title) => "- " + title).join("\n");
  const system = [
    "你是长期记忆的整理器。只根据【用户消息】写一条情景记忆。",
    "事实来源只有一个：用户在消息里陈述的事实、偏好、约定、事件、决定、要求、纠正、边界。",
    "严禁把助手的话写进记忆：助手回答「我不知道 / 记不得 / 没记录 / 不确定 / 我这儿是空白」既不是事实，也不是记忆内容；",
    "不要写「评审改期我这儿没记录」「周三评审我记忆里是空的」这种句子，也不要把「探针/提问」写成记忆。",
    "用户只是在提问、没有陈述新事实（如「上次评审改期定在什么时候？」「评审准备得怎么样了？」）→ 输出 {\"error\": \"用户只是提问，没有新事实\"}，不要生成记忆。",
    "提问里夹带新事实（如「改到周一了，你知道几点吗」）→ 只写新事实（评审改到周一），不写提问本身。",
    "标题必须是用户事实的短句（例：「评审改到周一上午十点」「面试失败的事以后别提」），不能是助手口吻。",
    "正文用第一人称（我）重述用户说的事实；只写用户消息里确有的内容，不补充、不推测、不编造。",
    "只输出一个 JSON 对象，不要输出任何别的文字：",
    '{"title": "不超过 24 字的用户事实短句", "gist": "不超过 60 字的一句话要点", "body": "120 到 400 字的第一人称记忆正文", "weightHint": 0.2 到 0.95 之间的数字, "tags": ["最多 4 个短标签"]}',
    '如果用户消息里没有可写的事实，输出 {"error": "原因"}。',
  ].join("\n");
  const header = [
    "会话时间：" + (session.createdAt ?? "未知"),
    "工作区：" + (session.workspace ?? "未知"),
  ];
  const turns = rows
    .filter((row) => Number.isInteger(row.turn))
    .map((row) => "#turn " + row.turn)
    .join(" · ");
  if (turns.length > 0) header.push("轮次：" + turns);
  const requestLines: string[] = [];
  if (requestKind === "boundary") {
    requestLines.push(
      "本条性质：【边界偏好】用户说以后别提/不想聊这件事。标题写「X 以后不提（边界）」（X 是对象），正文只写边界与对象（以后不提、不再追问），不要写事件的经过、地点、公司、人物细节。",
    );
  } else if (requestKind === "arrangement") {
    requestLines.push(
      "本条性质：【安排/要求/待办】用户提出要你准备、跟进、留意或完成的事。标题写安排短句（如「周三评审要准备一下」「周五前整理完资料清单」），正文写要求与对象；不要编造执行结果或完成状态。",
    );
  }
  const user = [
    header.join("\n"),
    "已有记忆标题（不要重复）：",
    titleList,
    ...(requestLines.length > 0 ? ["---", ...requestLines] : []),
    "---",
    "【用户消息 · 唯一事实来源】",
    clipText(userText),
    "---",
    "【助手回复 · 仅作上下文，禁止写进记忆】",
    clipText(assistantText) || "（无）",
  ].join("\n");
  return { system, user };
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

type CallResult = { ok: true; text: string | null } | { ok: false; budget: boolean; error: string };

/**
 * 跑一次深睡。
 *
 * @returns stats（永不抛；store 不可用 / 没给 caller 时 error 字段说明）
 */
export async function runDeepSleep(options: DeepSleepOptions = {}): Promise<DeepSleepStats> {
  const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const startedAt = new Date(now).toISOString();
  const dryRun = options.dryRun === true;
  const callCap = clampInt(
    options.nightCallCap,
    0,
    DEEP_SLEEP_DEFAULTS.nightCallCapMax,
    DEEP_SLEEP_DEFAULTS.nightCallCap,
  );
  const stats: DeepSleepStats = {
    ok: false,
    kind: "deep",
    dryRun,
    error: "",
    detail: "",
    callsUsed: 0,
    callCap,
    merged: 0,
    mergeRejected: 0,
    mergeRejectedRun: 0,
    mergeDecided: 0,
    semanticized: 0,
    semanticNodesCreated: 0,
    derivedEdges: 0,
    semanticCandidatesRejected: 0,
    semCapBlocked: 0,
    semArchived: 0,
    semMerged: 0,
    hygieneCalls: 0,
    hygieneBatches: 0,
    reconsolidated: 0,
    edgesAdded: 0,
    bridgesAdded: 0,
    pendingConsumed: 0,
    pendingInserted: 0,
    pendingDuplicates: 0,
    pendingRejected: 0,
    /** 被拒 pending 的原因摘要（最多 pendingRejectionLimit 条；deepSleepStatus 会带上）。 */
    pendingRejections: [],
    /** pending 入库时确定性建的 assoc 边数（纯本地，零 LLM 调用）。 */
    pendingLinkedEdges: 0,
    duplicates: 0,
    badJson: 0,
    budgetExhausted: false,
    dryRunCounts: null,
    cursorBefore: null,
    cursor: null,
    errors: [],
    startedAt,
    endedAt: null,
    runId: 0,
  };

  const store = options.store ?? null;
  const callerFn: DeepSleepCaller | null = typeof options.caller === "function" ? options.caller : null;
  if (store === null || store === undefined || typeof store.insertNode !== "function") {
    return { ...stats, error: "store_unavailable", detail: "记忆库不可用，深睡没有执行" };
  }
  if (callerFn === null && dryRun !== true) {
    return { ...stats, error: "llm_unavailable", detail: "没有可用的 LLM 调用器" };
  }

  const cursor = await readDeepCursor(store);
  if (cursor.stage === "done") {
    // 上一轮跑完了：新一轮从头开始（每晚的深睡都要重新检查合并/语义化/巩固/建边）。
    // 但**已判定过的合并对保留下来** —— 否则每晚都会把同样的 top-N 对重新问一遍
    // judge（真实模型上这是纯浪费）；拒绝过的对不重复问，等节点内容变化产生新 key。
    // 语义卫生的已处理集合跨夜保留（否则每晚把同样的 224 条重新问一遍）；
    // 合并判定已挪到 meta 的 merge_decisions（见 readMergeDecisions）。
    const hygieneDoneIds = cursor.hygieneDoneIds;
    Object.assign(cursor, emptyDeepCursor(), { hygieneDoneIds });
  }
  stats.cursorBefore = publicDeepCursor(cursor);
  const existingTitles = async (): Promise<string[]> => {
    try {
      return (await store.listNodes({ includeArchived: true })).map((node) => node.title);
    } catch {
      return [];
    }
  };

  if (dryRun) {
    const nodes = await store.listNodes({});
    const eps = nodes.filter((node) => node.tier === "ep" && !node.archived && !node.mergedInto);
    stats.dryRunCounts = {
      pendingTurns: (await store.pendingTurnStats()).unconsumed,
      mergePairs: findMergePairs(nodes).length,
      semanticizeCandidates: eps.filter((node) => node.semanticizedAt === null).length,
      reconsolidateCandidates: eps.filter((node) => isReconsolidationCandidate(node, now)).length,
      connectPairs: planConnectPairs(nodes, await store.allEdges()).length,
    };
    stats.ok = true;
    stats.endedAt = new Date(now).toISOString();
    stats.cursor = publicDeepCursor(cursor);
    return stats;
  }

  let callsUsed = 0;
  const budgetLeft = (): boolean => callsUsed < callCap;
  const bump = (): void => {
    callsUsed += 1;
  };

  /** 一次 LLM 调用；budget 用尽返回 {budget:true}。 */
  async function callLlm(stage: string, prompt: { system: string; user: string }, maxTokens: number): Promise<CallResult> {
    if (!budgetLeft()) return { ok: false, budget: true, error: "" };
    bump();
    if (callerFn === null) return { ok: false, budget: false, error: "llm_unavailable" };
    try {
      const text = await callerFn({
        stage,
        system: prompt.system,
        user: prompt.user,
        maxTokens,
        timeoutMs: DEEP_SLEEP_DEFAULTS.callTimeoutMs,
      });
      return typeof text === "string" ? { ok: true, text } : { ok: true, text: null };
    } catch (error) {
      return { ok: false, budget: false, error: messageOf(error) };
    }
  }

  const titles = await existingTitles();
  /** 给若干 ep 连到同一条 sem 的 derived 边（已存在时 INSERT OR REPLACE 覆盖强度）。 */
  const linkDerived = async (semId: number, epIds: number[], strength: number): Promise<number> => {
    let added = 0;
    for (const id of epIds) {
      if (!Number.isInteger(id) || id === semId) continue;
      try {
        await store.insertEdge(id, semId, { strength: clampNumber(strength, 0.2, 1, 0.5), kind: "derived" });
        added += 1;
      } catch (error) {
        pushError(stats, "derived 连边失败：" + messageOf(error));
      }
    }
    stats.derivedEdges += added;
    return added;
  };

  // ── 1) pending_turns → ep（两阶段：worthiness → generation）─────────────
  //
  // 验收教训（PILOT v1/v2）：
  //   · v1：worthiness 把用户明确事件拒了（助手说不知道 + 短句被 chunk 丢弃）→ 已修；
  //   · v2：能入库，但生成阶段把助手的「我记不得/没记录」写成记忆 → 现在生成 prompt
  //     显式分离「用户消息（唯一事实来源）」与「助手回复（禁止写进记忆）」，
  //     并在代码层用 looksLikeAssistantArtifact 兜底拦截污染文本。
  const stagePending = async (): Promise<void> => {
    const rows = await store.listPendingTurns({ limit: DEEP_SLEEP_DEFAULTS.pendingRowLimit });
    if (rows.length === 0) return;

    // 已有节点（含归档）：去重要按 persona/workspace 一起比，否则跨分区同标题会误判重复。
    const existingNodes = await (async (): Promise<NmsNode[]> => {
      try {
        return await store.listNodes({ includeArchived: true });
      } catch {
        return [];
      }
    })();
    const recordRejection = (slice: NmsPendingTurn[], reason: string): void => {
      const list = stats.pendingRejections;
      if (list.length >= DEEP_SLEEP_DEFAULTS.pendingRejectionLimit) return;
      list.push({
        sessionId: slice[0].sessionId,
        turn: slice[0].turn ?? null,
        turns: slice.map((row) => row.turn ?? null),
        reason: String(reason).slice(0, 200),
      });
    };

    // 按 session 分组（保持写入顺序），每 N 行组成一个块。
    const groups = new Map<string, NmsPendingTurn[]>();
    for (const row of rows) {
      if (!groups.has(row.sessionId)) groups.set(row.sessionId, []);
      groups.get(row.sessionId)!.push(row);
    }
    for (const group of groups.values()) {
      for (let start = 0; start < group.length; start += DEEP_SLEEP_DEFAULTS.pendingRowsPerChunk) {
        const slice = group.slice(start, start + DEEP_SLEEP_DEFAULTS.pendingRowsPerChunk);
        if (slice.length === 0) continue;
        // 不再用 chunkSessionTurns：短句事实会被 40 字门槛丢掉；这里整块处理，
        // user/assistant 文本分开进 prompt，让模型只从用户消息取事实。
        const userText = slice
          .map((row) => row.userText.trim())
          .filter((text) => text.length > 0)
          .join("\n---\n");
        const assistantText = slice
          .map((row) => row.assistantText.trim())
          .filter((text) => text.length > 0)
          .join("\n---\n");
        if (userText.length === 0 && assistantText.length === 0) {
          await store.consumePendingTurns(slice.map((row) => row.id), { now });
          stats.pendingConsumed += slice.length;
          continue;
        }
        const session = {
          createdAt: slice[0].createdAt,
          preset: "",
          workspace: slice[0].workspace ?? "unknown",
        };
        const maxText = DEEP_SLEEP_DEFAULTS.pendingPromptTextLimit;
        // 确定性预判：明确「不要记」直接拒；边界偏好/请求安排跳过 worthiness 直接生成。
        const pre = classifyPendingRequest(userText);
        let allDone = true;
        if (pre.rejectReason.length > 0) {
          stats.pendingRejected += 1;
          recordRejection(slice, pre.rejectReason);
        } else if (!budgetLeft()) {
          allDone = false;
          stats.budgetExhausted = true;
        } else {
          let worthy = pre.forceWorthy;
          let rejectionReason = "";
          if (!worthy) {
            const worth = await callLlm(
              "worthiness",
              buildPendingWorthinessPrompt({ session, rows: slice, userText, assistantText, maxText }),
              DEEP_SLEEP_DEFAULTS.judgeMaxTokens,
            );
            if (!worth.ok) {
              if (worth.budget) {
                allDone = false;
                stats.budgetExhausted = true;
              } else {
                pushError(stats, "pending worthiness 失败：" + worth.error);
              }
            } else {
              const verdict = parsePendingWorthiness(worth.text);
              if (verdict === null) {
                stats.badJson += 1;
                recordRejection(slice, "worthiness 输出无法解析");
              } else if (!verdict.worthy) {
                rejectionReason = verdict.reason.length > 0 ? verdict.reason : "worthiness 判不值得记";
              } else {
                worthy = true;
              }
            }
          }
          if (worthy && allDone) {
            if (!budgetLeft()) {
              allDone = false;
              stats.budgetExhausted = true;
            } else {
              const gen = await callLlm(
                "generation",
                buildPendingGenerationPrompt({
                  session,
                  rows: slice,
                  userText,
                  assistantText,
                  existingTitles: titles,
                  maxText,
                  requestKind: pre.requestKind,
                }),
                DEEP_SLEEP_DEFAULTS.mergeMaxTokens,
              );
              if (!gen.ok) {
                if (gen.budget) {
                  allDone = false;
                  stats.budgetExhausted = true;
                } else {
                  pushError(stats, "pending generation 失败：" + gen.error);
                }
              } else {
                const generated = parseGenerated(gen.text);
                if (generated.ok !== true) {
                  stats.badJson += 1;
                  recordRejection(slice, "generation 无可写内容：" + generated.error);
                } else if (looksLikeAssistantArtifact(generated.title, { userText }) ||
                    looksLikeAssistantArtifact(generated.gist, { userText })) {
                  // 代码层兜底：模型把助手「记不得/没记录」写进**标题/要点**时丢弃这条生成。
                  // 只检查正文会被误伤：助手在回复里复述用户事实（如「评审改到周一上午十点」）
                  // 时正文含「记不得」，但标题/要点是干净的用户事实（2026-10-31 C05 实测）。
                  stats.pendingRejected += 1;
                  recordRejection(slice, "generation 把助手回答写进记忆，已丢弃：" + generated.title.slice(0, 40));
                } else {
                  // 正文只是补充材料：命中助手口吻就清空，不连坐整条事实。
                  if (looksLikeAssistantArtifact(generated.body, { userText })) generated.body = "";
                  const key = dedupeKey({ persona: slice[0].persona, workspace: slice[0].workspace, title: generated.title });
                  const duplicate = existingNodes.some(
                    (node) => dedupeKey({ persona: node.persona, workspace: node.workspace, title: node.title }) === key,
                  );
                  if (duplicate) {
                    stats.pendingDuplicates += 1;
                    recordRejection(slice, "重复标题：" + generated.title);
                  } else {
                    try {
                      const node = await store.insertNode({
                        tier: "ep",
                        persona: slice[0].persona,
                        workspace: slice[0].workspace,
                        title: generated.title,
                        gist: generated.gist,
                        body: generated.body,
                        weight: generated.weight,
                        createdAt: slice[0].createdAt,
                        now,
                      });
                      // 溯源：这条 ep 由哪些 pending 轮次生成（验收按 turn 对账用）。
                      if (node !== null && typeof store.appendNodeHistory === "function") {
                        try {
                          await store.appendNodeHistory(node.id, {
                            kind: "pending-source",
                            sessionId: slice[0].sessionId,
                            turns: slice.map((row) => row.turn ?? null),
                            persona: slice[0].persona,
                            workspace: slice[0].workspace ?? null,
                            at: new Date(now).toISOString(),
                          });
                        } catch (error) {
                          pushError(stats, "pending 溯源写入失败：" + messageOf(error));
                        }
                      }
                      titles.push(generated.title);
                      existingNodes.push(node);
                      stats.pendingInserted += 1;
                      // 入库即建边（同 persona、纯本地相似度，零 LLM 调用）：
                      // 没有这条，联想扩散起不来，探针只会召回种子里的旧事件。
                      try {
                        const existingPairs = new Set((await store.allEdges()).map((edge) => edge.a + ":" + edge.b));
                        const planned = planPendingLinks({
                          node,
                          candidates: await store.listNodes({ tier: "ep" }),
                          existingPairs,
                        });
                        for (const link of planned) {
                          try {
                            await store.insertEdge(node.id, link.id, { strength: link.strength, kind: "assoc" });
                            stats.pendingLinkedEdges += 1;
                          } catch (error) {
                            pushError(stats, "pending 建边失败：" + messageOf(error));
                          }
                        }
                      } catch (error) {
                        pushError(stats, "pending 建边规划失败：" + messageOf(error));
                      }
                    } catch (error) {
                      pushError(stats, "pending 写库失败：" + messageOf(error));
                    }
                  }
                }
              }
            }
          } else if (!worthy && rejectionReason.length > 0) {
            stats.pendingRejected += 1;
            recordRejection(slice, rejectionReason);
          }
        }
        if (allDone) {
          await store.consumePendingTurns(slice.map((row) => row.id), { now });
          stats.pendingConsumed += slice.length;
        } else {
          return;
        }
      }
    }
  };

  // ── 2) 语义卫生（hygiene）──────────────────────────────────────────────────
  //
  // 目标：**保真清理**。只归档「一次性事件复述 / 某天完成了什么 / 空泛到没有信息 /
  // 噪声」，合并真正重复的事实；项目事实、决策、偏好一律保留。
  const stageHygiene = async (): Promise<void> => {
    const activeSems = async (): Promise<NmsNode[]> =>
      (await store.listNodes({ tier: "sem" })).filter(
        (node) => !node.archived && !node.forgotten && node.mergedInto === null,
      );

    // 2a) 确定性去重（零 LLM）：同 persona 下 normalized title 相同、或 bigram >= 0.85。
    let guard = 0;
    while (guard < 200) {
      guard += 1;
      const sems = await activeSems();
      if (sems.length < 2) break;
      const byPersona = new Map<string, NmsNode[]>();
      for (const node of sems) {
        const key = node.persona ?? "";
        if (!byPersona.has(key)) byPersona.set(key, []);
        byPersona.get(key)!.push(node);
      }
      const score = (node: NmsNode): number => node.weight + node.recalls * 0.05;
      let mergedOne = false;
      outer: for (const group of byPersona.values()) {
        if (group.length < 2) continue;
        group.sort((a, b) => score(b) - score(a) || a.id - b.id);
        for (let i = 0; i < group.length; i += 1) {
          for (let j = i + 1; j < group.length; j += 1) {
            const keeper = group[i];
            const other = group[j];
            const sameTitle = normalizeTitle(keeper.title) === normalizeTitle(other.title);
            const similar = sameTitle || memorySimilarity(keeper, other) >= DEEP_SLEEP_DEFAULTS.hygieneDedupSimilarity;
            if (!similar) continue;
            try {
              await store.mergeNodeInto(keeper.id, other.id);
              stats.semMerged += 1;
              mergedOne = true;
            } catch (error) {
              pushError(stats, "hygiene 确定性去重失败：" + messageOf(error));
            }
            break outer;
          }
        }
      }
      if (!mergedOne) break;
    }

    // 2b) LLM 分批：12 条/批，默认最多 20 次调用。
    while (stats.hygieneCalls < DEEP_SLEEP_DEFAULTS.hygieneMaxCalls) {
      if (!budgetLeft()) {
        stats.budgetExhausted = true;
        return;
      }
      const candidates = (await activeSems())
        .filter((node) => !cursor.hygieneDoneIds.includes(node.id))
        .sort((a, b) => b.weight - a.weight || a.id - b.id);
      if (candidates.length === 0) break;
      const batch = candidates.slice(0, DEEP_SLEEP_DEFAULTS.hygieneBatchSize);
      const allSems = await activeSems();
      const result = await callLlm(
        "hygiene",
        buildHygienePrompt({ batch, existingSems: allSems }),
        DEEP_SLEEP_DEFAULTS.hygieneMaxTokens,
      );
      stats.hygieneCalls += 1;
      if (!result.ok) {
        if (result.budget) {
          stats.budgetExhausted = true;
          return;
        }
        pushError(stats, "hygiene 调用失败：" + result.error);
        /* 调用失败（网络/预算/reasoning 超限）不算「已判定」：不写 done，
         * 否则这批 sem 会被永久跳过（2026-10-30 实测踩过）。下次运行重试。 */
        await writeDeepCursor(store, cursor, now);
        continue;
      }
      const parsed = parseHygieneDecisions(result.text, batch.map((node) => node.id));
      if (parsed.ok !== true) {
        stats.badJson += 1;
        pushError(stats, "hygiene 输出不可用：" + parsed.error);
        for (const node of batch) markDone(cursor.hygieneDoneIds, node.id);
        await writeDeepCursor(store, cursor, now);
        continue;
      }
      stats.hygieneBatches += 1;
      const byId = new Map<number, NmsNode>(batch.map((node): [number, NmsNode] => [node.id, node]));
      for (const decision of parsed.decisions) {
        const original = byId.get(decision.id);
        if (original === undefined) continue;
        const current = await store.getNode(decision.id);
        if (current === null || current.archived || current.mergedInto !== null) continue;
        try {
          if (decision.action === "archive") {
            await store.updateNode(decision.id, { archived: true });
            stats.semArchived += 1;
          } else if (decision.action === "merge") {
            const target = await store.getNode(decision.mergeInto as number);
            if (
              target !== null &&
              target.tier === "sem" &&
              !target.archived &&
              target.mergedInto === null &&
              target.persona === current.persona
            ) {
              await store.mergeNodeInto(target.id, current.id);
              stats.semMerged += 1;
            }
          }
        } catch (error) {
          pushError(stats, "hygiene 落库失败（#" + decision.id + "）：" + messageOf(error));
        }
      }
      for (const node of batch) {
        markDone(cursor.hygieneDoneIds, node.id);
        stats.hygieneDone = (stats.hygieneDone ?? 0) + 1;
      }
      await writeDeepCursor(store, cursor, now);
    }
  };

  // ── 3) 近重复合并 ─────────────────────────────────────────────────────────
  const stageMerge = async (): Promise<void> => {
    const nodes = await store.listNodes({});
    const decisions = await readMergeDecisions(store);
    const pairs = findMergePairs(nodes, { mergePairLimit: DEEP_SLEEP_DEFAULTS.mergePairLimit })
      .filter((pair) => decisions[mergePairKey(pair.a.id, pair.b.id)] === undefined)
      .slice(0, DEEP_SLEEP_DEFAULTS.mergePairLimit);
    for (const pair of pairs) {
      const pairKey = mergePairKey(pair.a.id, pair.b.id);
      if (!budgetLeft()) {
        stats.budgetExhausted = true;
        return;
      }
      const a = await store.getNode(pair.a.id);
      const b = await store.getNode(pair.b.id);
      if (a === null || b === null || a.archived || b.archived || a.mergedInto !== null || b.mergedInto !== null) {
        await rememberMergeDecision(store, pairKey, "invalid", now);
        continue;
      }
      const verdictResult = await callLlm(
        "merge-judge",
        buildMergeJudgePrompt({ a, b }),
        DEEP_SLEEP_DEFAULTS.judgeMaxTokens,
      );
      if (!verdictResult.ok) {
        if (verdictResult.budget) {
          stats.budgetExhausted = true;
          return;
        }
        pushError(stats, "merge 判定失败：" + verdictResult.error);
        continue;
      }
      const verdict = parseMergeVerdict(verdictResult.text);
      if (verdict === null) {
        stats.badJson += 1;
        await rememberMergeDecision(store, pairKey, "invalid", now);
        continue;
      }
      if (!verdict.sameExperience) {
        stats.mergeRejectedRun += 1;
        await rememberMergeDecision(store, pairKey, "different", now);
        continue;
      }
      if (!budgetLeft()) {
        // 判了「同一段」但预算不够写合并：不记账，下一轮重问（否则这对永远漏掉）。
        stats.budgetExhausted = true;
        return;
      }
      const merged = await callLlm(
        "merge-write",
        buildMergeWritePrompt({ a, b, existingTitles: titles }),
        DEEP_SLEEP_DEFAULTS.mergeMaxTokens,
      );
      if (!merged.ok) {
        if (merged.budget) {
          stats.budgetExhausted = true;
          return;
        }
        pushError(stats, "merge 生成失败：" + merged.error);
        continue;
      }
      const mergedNode = parseMergedNode(merged.text, { maxBodyChars: DEEP_SLEEP_DEFAULTS.mergeBodyMaxChars });
      if (mergedNode.ok !== true) {
        stats.badJson += 1;
        pushError(stats, "merge 输出不可用：" + mergedNode.error);
        await rememberMergeDecision(store, pairKey, "invalid", now);
        continue;
      }
      const keepA = mergedNode.keep === "a" || (mergedNode.keep !== "b" && richerNode(a, b) === a.id);
      const main = keepA ? a : b;
      const other = keepA ? b : a;
      try {
        const historyMain = [
          ...main.history,
          { at: new Date(now).toISOString(), kind: "merge-main", withNode: other.id, withTitle: other.title },
        ];
        const historyOther = [
          ...other.history,
          { at: new Date(now).toISOString(), kind: "merged-into", intoNode: main.id, intoTitle: main.title },
        ];
        await store.updateNode(main.id, {
          title: mergedNode.title,
          gist: mergedNode.gist,
          body: mergedNode.body.length > 0 ? mergedNode.body : main.body,
          history: historyMain,
        });
        await store.updateNode(other.id, { history: historyOther });
        await store.mergeNodeInto(main.id, other.id);
        stats.merged += 1;
        await rememberMergeDecision(store, pairKey, "same", now);
      } catch (error) {
        pushError(stats, "merge 落库失败：" + messageOf(error));
      }
    }
  };

  // ── 4) 语义化 ─────────────────────────────────────────────────────────────
  //
  // 每批最多 10 条 ep、最多产出 1 条 sem；先与既有 40 条 sem 比对，重复则只连边。
  // 硬上限 semCap（默认 300）只是保险丝，不是质量手段；质量靠 prompt 与去重。
  const stageSemanticize = async (): Promise<void> => {
    const allNodes = await store.listNodes({});
    const pendingEps = allNodes.filter(
      (node) =>
        node.tier === "ep" &&
        !node.archived &&
        !node.forgotten &&
        node.mergedInto === null &&
        node.semanticizedAt === null &&
        !cursor.semanticizeDoneIds.includes(node.id),
    );
    if (pendingEps.length === 0) return;
    if (!budgetLeft()) {
      stats.budgetExhausted = true;
      return;
    }
    // 一批只处理同一 persona（语义是 persona 级的，跨 persona 会串味）。
    const byPersona = new Map<string, NmsNode[]>();
    for (const node of pendingEps) {
      const key = node.persona ?? "";
      if (!byPersona.has(key)) byPersona.set(key, []);
      byPersona.get(key)!.push(node);
    }
    const personaGroups = [...byPersona.values()].sort(
      (a, b) => Math.max(...b.map((node) => node.weight)) - Math.max(...a.map((node) => node.weight)),
    );
    const group = personaGroups[0];
    const eps = group.sort((a, b) => b.weight - a.weight || a.id - b.id).slice(0, DEEP_SLEEP_DEFAULTS.semanticizeLimit);
    const persona = eps[0].persona;
    const semList = (await store.listNodes({ tier: "sem" }))
      .filter((node) => !node.archived && !node.forgotten && node.mergedInto === null && node.persona === persona)
      .sort((a, b) => b.weight - a.weight || a.id - b.id);
    const existingForPrompt = semList
      .slice(0, DEEP_SLEEP_DEFAULTS.hygienePromptSemLimit)
      .map((sem) => ({ id: sem.id, title: sem.title, gist: sem.gist }));
    const episodes = eps.map((node) => ({
      id: node.id,
      title: node.title,
      gist: node.gist,
      body: clip(node.body, 400),
      workspace: node.workspace,
    }));

    const result = await callLlm(
      "semanticize",
      buildSemanticizeBatchPrompt({ episodes, existingSemantics: existingForPrompt }),
      DEEP_SLEEP_DEFAULTS.semanticMaxTokens,
    );
    if (result.ok) {
      const parsed = parseSemanticCandidate(result.text);
      if (parsed.ok !== true) {
        stats.badJson += 1;
        pushError(stats, "semanticize 输出不可用：" + parsed.error);
      } else if (parsed.semantic !== null) {
        const candidate = parsed.semantic;
        const supporting = candidate.supportingIds.filter((id) => eps.some((node) => node.id === id));
        // 与既有 sem 做代码层比对（bigram 余弦）：>=0.9 同一事实（合并），>=0.75 重复（只连边）。
        let best: { sem: NmsNode; similarity: number } | null = null;
        for (const sem of semList) {
          const sim = memorySimilarity({ title: candidate.title, gist: candidate.gist }, sem);
          if (best === null || sim > best.similarity) best = { sem, similarity: sim };
        }
        const linkExisting =
          candidate.linkExisting !== null && semList.some((sem) => sem.id === candidate.linkExisting)
            ? candidate.linkExisting
            : null;
        if (linkExisting !== null) {
          // LLM 自己认出「已有等价事实」：只连边，不建节点。
          const target = await store.getNode(linkExisting);
          const ids = supporting.length > 0 ? supporting : eps.map((node) => node.id);
          await linkDerived(linkExisting, ids, candidate.strength);
          stats.duplicates += 1;
          if (target !== null && candidate.gist.length > 0 && candidate.gist.length > target.gist.length) {
            try {
              await store.updateNode(target.id, {
                gist: candidate.gist,
                history: [
                  ...target.history,
                  { at: new Date(now).toISOString(), kind: "semantic-enrich", from: candidate.title },
                ],
              });
            } catch (error) {
              pushError(stats, "语义补全失败：" + messageOf(error));
            }
          }
        } else if (best !== null && best.similarity >= DEEP_SLEEP_DEFAULTS.semanticMergeSimilarity) {
          // 同一事实：合并进既有 sem（更新 gist/weight），并连边。
          const ids = supporting.length > 0 ? supporting : eps.map((node) => node.id);
          await linkDerived(best.sem.id, ids, candidate.strength);
          try {
            await store.updateNode(best.sem.id, {
              gist: candidate.gist.length > 0 ? candidate.gist : best.sem.gist,
              weight: Math.max(best.sem.weight, candidate.strength),
              history: [
                ...best.sem.history,
                { at: new Date(now).toISOString(), kind: "semantic-merge", from: candidate.title },
              ],
            });
            stats.semMerged += 1;
          } catch (error) {
            pushError(stats, "语义合并失败：" + messageOf(error));
          }
        } else if (best !== null && best.similarity >= DEEP_SLEEP_DEFAULTS.semanticDedupeSimilarity) {
          // 语义重复：不建节点，改为给既有 sem 建 derived 边（桥接依赖这条边）。
          const ids = supporting.length > 0 ? supporting : eps.map((node) => node.id);
          await linkDerived(best.sem.id, ids, candidate.strength);
          stats.duplicates += 1;
        } else if (supporting.length < DEEP_SLEEP_DEFAULTS.semanticSupportMin) {
          stats.semanticCandidatesRejected += 1;
        } else if (semList.length >= DEEP_SLEEP_DEFAULTS.semCap) {
          stats.semCapBlocked += 1;
        } else {
          try {
            const semNode = await store.insertNode({
              tier: "sem",
              persona,
              workspace: null,
              title: candidate.title,
              gist: candidate.gist,
              body: candidate.body.length > 0 ? candidate.body : candidate.gist,
              weight: candidate.strength,
              now,
            });
            await linkDerived(semNode.id, supporting, candidate.strength);
            titles.push(candidate.title);
            stats.semanticNodesCreated += 1;
          } catch (error) {
            pushError(stats, "semanticize 写库失败：" + messageOf(error));
          }
        }
      }
    } else if (result.budget) {
      stats.budgetExhausted = true;
      return;
    } else {
      pushError(stats, "semanticize 调用失败：" + result.error);
    }

    // 本批 episode 处理完（无论是否产出语义）都标记，避免每晚重复烧调用。
    for (const node of eps) {
      try {
        await store.updateNode(node.id, { semanticizedAt: new Date(now).toISOString() });
        stats.semanticized += 1;
      } catch (error) {
        pushError(stats, "semanticized_at 写入失败：" + messageOf(error));
      }
      markDone(cursor.semanticizeDoneIds, node.id);
    }
    await writeDeepCursor(store, cursor, now);
  };

  // ── 5) 再巩固 ─────────────────────────────────────────────────────────────
  const stageReconsolidate = async (): Promise<void> => {
    const candidates = (await store.listNodes({ tier: "ep" }))
      .filter(
        (node) => isReconsolidationCandidate(node, now) && !cursor.reconsolidateDoneIds.includes(node.id),
      )
      .sort((a, b) => b.weight - a.weight || a.id - b.id)
      .slice(0, DEEP_SLEEP_DEFAULTS.reconsolidateLimit);
    for (const candidate of candidates) {
      if (!budgetLeft()) {
        stats.budgetExhausted = true;
        return;
      }
      const node = await store.getNode(candidate.id);
      if (node === null || !isReconsolidationCandidate(node, now)) {
        markDone(cursor.reconsolidateDoneIds, candidate.id);
        await writeDeepCursor(store, cursor, now);
        continue;
      }
      const result = await callLlm(
        "reconsolidate",
        buildReconsolidatePrompt({ node }),
        DEEP_SLEEP_DEFAULTS.reconsolidateMaxTokens,
      );
      if (!result.ok) {
        markDone(cursor.reconsolidateDoneIds, candidate.id);
        await writeDeepCursor(store, cursor, now);
        if (result.budget) {
          stats.budgetExhausted = true;
          return;
        }
        pushError(stats, "reconsolidate 失败：" + result.error);
        continue;
      }
      const parsed = parseReconsolidated(result.text);
      if (parsed === null) {
        stats.badJson += 1;
        markDone(cursor.reconsolidateDoneIds, candidate.id);
        await writeDeepCursor(store, cursor, now);
        continue;
      }
      try {
        const history = [...node.history, { at: new Date(now).toISOString(), kind: "reconsolidate", beforeGist: node.gist }];
        const patch: NmsNodePatch = {
          gist: parsed.gist,
          consolidatedCount: node.consolidatedCount + 1,
          lastConsolidatedAt: new Date(now).toISOString(),
          history,
        };
        if (parsed.bodySummary.length > 0) {
          history.push({
            at: new Date(now).toISOString(),
            kind: "reconsolidate-body",
            beforeBody: clip(node.body, DEEP_SLEEP_DEFAULTS.maxBodyChars),
          });
          patch.body = parsed.bodySummary;
        }
        await store.updateNode(node.id, patch);
        stats.reconsolidated += 1;
      } catch (error) {
        pushError(stats, "reconsolidate 落库失败：" + messageOf(error));
      }
      markDone(cursor.reconsolidateDoneIds, node.id);
      await writeDeepCursor(store, cursor, now);
    }
  };

  // ── 6) 建边（零 LLM）──────────────────────────────────────────────────────
  const stageConnect = async (): Promise<void> => {
    if (cursor.connectDone) return;
    const nodes = await store.listNodes({});
    const edges = await store.allEdges();
    const pairs = planConnectPairs(nodes, edges);
    for (const pair of pairs) {
      try {
        await store.insertEdge(pair.a.id, pair.b.id, {
          strength: Math.max(0.2, Math.round(pair.similarity * 100) / 100),
          kind: "assoc",
        });
        stats.edgesAdded += 1;
      } catch (error) {
        pushError(stats, "建边失败：" + messageOf(error));
      }
    }
    // 共语义桥接：共享同一条 sem 的 ep 之间补边（文本可能不相似，但语义上是一类）。
    const freshEdges = await store.allEdges();
    const semNeighbors = new Map<number, Array<{ ep: NmsNode; strength: number }>>();
    for (const edge of freshEdges) {
      if (edge.kind !== "derived") continue;
      const a = await store.getNode(edge.a);
      const b = await store.getNode(edge.b);
      if (a === null || b === null) continue;
      const sem = a.tier === "sem" ? a : b.tier === "sem" ? b : null;
      const ep = a.tier === "ep" ? a : b.tier === "ep" ? b : null;
      if (sem === null || ep === null) continue;
      if (!semNeighbors.has(sem.id)) semNeighbors.set(sem.id, []);
      semNeighbors.get(sem.id)!.push({ ep, strength: edge.strength });
    }
    for (const group of semNeighbors.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => b.strength - a.strength);
      const limited = group.slice(0, DEEP_SLEEP_DEFAULTS.bridgePerSemantic);
      for (let i = 0; i < limited.length; i += 1) {
        for (let j = i + 1; j < limited.length; j += 1) {
          const strength = Math.max(0.2, Math.min(limited[i].strength, limited[j].strength) * DEEP_SLEEP_DEFAULTS.bridgeStrengthFactor);
          try {
            await store.insertEdge(limited[i].ep.id, limited[j].ep.id, { strength, kind: "assoc" });
            stats.bridgesAdded += 1;
          } catch (error) {
            pushError(stats, "桥接边失败：" + messageOf(error));
          }
        }
      }
    }
    cursor.connectDone = true;
    await writeDeepCursor(store, cursor, now);
  };

  // ── 跑阶段 ────────────────────────────────────────────────────────────────
  const stageRunners: Record<string, () => Promise<void>> = {
    pending: stagePending,
    hygiene: stageHygiene,
    merge: stageMerge,
    semanticize: stageSemanticize,
    reconsolidate: stageReconsolidate,
    connect: stageConnect,
  };

  const startIndex = cursor.stage === "done" ? 0 : STAGE_NAMES.indexOf(cursor.stage);
  for (let index = Math.max(0, startIndex); index < DEEP_STAGES.length; index += 1) {
    const stage = DEEP_STAGES[index];
    cursor.stage = stage;
    await writeDeepCursor(store, cursor, now);
    try {
      await stageRunners[stage]();
    } catch (error) {
      pushError(stats, stage + " 阶段异常：" + messageOf(error));
    }
    if (stats.budgetExhausted) break;
    cursor.stage = index + 1 < DEEP_STAGES.length ? DEEP_STAGES[index + 1] : "done";
    await writeDeepCursor(store, cursor, now);
    if (cursor.stage === "done") break;
  }
  if (!stats.budgetExhausted) cursor.stage = "done";
  cursor.runCount += 1;
  await writeDeepCursor(store, cursor, now);

  stats.callsUsed = callsUsed;
  {
    const decisions = await readMergeDecisions(store);
    stats.mergeDecided = Object.keys(decisions).length;
    stats.mergeRejected = Object.values(decisions).filter((entry) => entry?.verdict === "different").length;
  }
  stats.semCount = await countActiveSemantics(store);
  stats.semCap = DEEP_SLEEP_DEFAULTS.semCap;
  stats.cursor = publicDeepCursor(cursor);
  // pending 明细计数（设置页 / dream_runs / 验收脚本统一读这个）。
  stats.pending = {
    consumed: stats.pendingConsumed,
    inserted: stats.pendingInserted,
    rejected: stats.pendingRejected,
    duplicates: stats.pendingDuplicates,
    firstRejectionReason: stats.pendingRejections.length > 0 ? stats.pendingRejections[0].reason : "",
    rejectionReasons: stats.pendingRejections,
    linkedEdges: stats.pendingLinkedEdges,
  };
  const endedAt = new Date(Math.max(now, Date.now())).toISOString();
  stats.endedAt = endedAt;
  stats.ok = true;

  try {
    stats.runId = await store.recordDreamRun({ kind: "deep", startedAt, endedAt, stats });
    await store.setMeta(LAST_DEEP_RUN_META_KEY, endedAt);
  } catch (error) {
    pushError(stats, "记账失败：" + messageOf(error));
  }
  return stats;
}

/** 合并时选主节点：更完整/更近的优先（LLM 没给 keep 时用）。 */
function richerNode(a: NmsNode, b: NmsNode): number {
  const weightA = a.weight + (a.recalls > 0 ? 0.05 : 0);
  const weightB = b.weight + (b.recalls > 0 ? 0.05 : 0);
  if (Math.abs(weightA - weightB) > 0.05) return weightA >= weightB ? a.id : b.id;
  const timeA = Date.parse(a.createdAt ?? "") || 0;
  const timeB = Date.parse(b.createdAt ?? "") || 0;
  return timeA >= timeB ? a.id : b.id;
}
