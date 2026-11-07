/**
 * 自动语气（手机版）。
 *
 * 她读自己的记忆，重写「我说话的方式」，同时最多挪一格自己的性子。
 * 与 DSH 版的差别：单人格、单分区；参数树是扁平的四个旋钮；快照只留 5 条；
 * 状态存在 NMS meta 的 voice_state（JSON），不新建表。
 *
 * 注入与展示都在 app 层；这里只放纯逻辑与状态读写，方便单测。
 */
import type { NmsStore } from "./store.ts";
import { extractJsonObject } from "./deep-sleep.ts";

/** 语气笔记最长字符数（与旧语气笔记同口径）。 */
export const VOICE_PROFILE_MAX_CHARS = 420;
/** 回滚快照保留条数。 */
export const VOICE_SNAPSHOT_LIMIT = 5;
/** 状态在 NMS meta 里的键。 */
export const VOICE_META_KEY = "voice_state";
/** 一次最多喂几篇记忆。 */
export const VOICE_SAMPLE_LIMIT = 6;

export type VoiceParamValue = number | string;
export type VoiceParams = Record<string, VoiceParamValue>;

export interface VoiceNumberNode {
  type: "number";
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /**
   * 允许一次挪多格。
   *
   * 默认所有旋钮一晚最多一格（改太快就不是"长出来的"）。只有主动程度例外：
   * 它直接决定她多久找你一次，跟着对话走才像活的。
   */
  free?: boolean;
}
export interface VoiceEnumOption {
  value: string;
  label: string;
}
export interface VoiceEnumNode {
  type: "enum";
  label: string;
  values: VoiceEnumOption[];
  default: string;
}
export type VoiceParamNode = VoiceNumberNode | VoiceEnumNode;

export interface VoiceSchema {
  version: number;
  nodes: Record<string, VoiceParamNode>;
}

export interface VoiceSnapshot {
  version: number;
  profile: string;
  params: VoiceParams;
  updatedAt: string;
  reason: string;
}

export interface VoiceState {
  version: number;
  profile: string;
  params: VoiceParams;
  updatedAt: string;
  reason: string;
  /** 更早的版本，新的在前。 */
  history: VoiceSnapshot[];
}

/** 她自己的四个旋钮。改这里等于改她能漂的方向。 */
export const HERTA_VOICE_SCHEMA = {
  version: 1,
  root: {
    speech: { type: "number", label: "说话长短", min: 0, max: 100, step: 5, default: 70 },
    patience: { type: "number", label: "耐心", min: 0, max: 100, step: 5, default: 60 },
    initiative: { type: "number", label: "主动程度", min: 0, max: 100, step: 5, default: 40, free: true },
    address: {
      type: "enum" as const,
      label: "称呼方式",
      // 「名字」用的是引导页里填的用户名；没填就按「开拓者」叫。
      values: [
        { value: "name", label: "名字" },
        { value: "trailblazer", label: "开拓者" },
        { value: "none", label: "不称呼" },
      ],
      default: "name",
    },
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 把配置对象归一成 { version, nodes }；只接受 number / enum。 */
export function normalizeVoiceSchema(input: unknown = HERTA_VOICE_SCHEMA): VoiceSchema {
  const raw = isObject(input) && isObject(input.root) ? input.root : input;
  if (!isObject(raw)) throw new Error("voice schema: root 必须是对象");
  const version = isObject(input) && Number.isInteger(input.version as number) ? Number(input.version) : 1;
  const nodes: Record<string, VoiceParamNode> = {};
  for (const [key, node] of Object.entries(raw)) {
    if (!isObject(node)) throw new Error("voice schema: " + key + " 必须是对象");
    if (node.type === "number") {
      const min = Number(node.min);
      const max = Number(node.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
        throw new Error("voice schema: " + key + " 的 min/max 不合法");
      }
      const step = Number.isFinite(Number(node.step)) && Number(node.step) > 0 ? Number(node.step) : (max - min) / 10;
      const fallback = Number.isFinite(Number(node.default)) ? Number(node.default) : min;
      nodes[key] = {
        type: "number",
        label: String(node.label ?? key),
        min,
        max,
        step,
        default: clampNumber(fallback, min, max),
        free: node.free === true,
      };
      continue;
    }
    if (node.type === "enum") {
      if (!Array.isArray(node.values) || node.values.length === 0) {
        throw new Error("voice schema: " + key + " 的 values 不能为空");
      }
      const values: VoiceEnumOption[] = node.values.map((item) => {
        if (typeof item === "string") return { value: item, label: item };
        if (isObject(item) && typeof item.value === "string") {
          return { value: item.value, label: String(item.label ?? item.value) };
        }
        throw new Error("voice schema: " + key + " 的 values 项不合法");
      });
      const fallback =
        typeof node.default === "string" && values.some((item) => item.value === node.default)
          ? node.default
          : values[0].value;
      nodes[key] = { type: "enum", label: String(node.label ?? key), values, default: fallback };
      continue;
    }
    throw new Error("voice schema: 未知类型 " + String((node as { type?: unknown }).type) + "（" + key + "）");
  }
  return { version, nodes };
}

/** 默认参数（已有合法值就保留）。 */
export function defaultVoiceParams(schema: VoiceSchema = normalizeVoiceSchema()): VoiceParams {
  const out: VoiceParams = {};
  for (const [key, node] of Object.entries(schema.nodes)) out[key] = node.default;
  return out;
}

/** 只保留 schema 认识的键；缺的补默认。 */
export function normalizeVoiceParams(
  schema: VoiceSchema,
  params: Partial<VoiceParams> | null | undefined
): VoiceParams {
  const out: VoiceParams = {};
  for (const [key, node] of Object.entries(schema.nodes)) {
    const value = params ? params[key] : undefined;
    if (node.type === "number") {
      out[key] = Number.isFinite(Number(value)) ? clampNumber(Number(value), node.min, node.max) : node.default;
    } else {
      out[key] =
        typeof value === "string" && node.values.some((item) => item.value === value) ? value : node.default;
    }
  }
  return out;
}

/**
 * 把模型给的参数夹到「一晚一格」的范围内：数字最多差一个 step，
 * 枚举只能挪到相邻候选；结构以 schema 为准。
 * 标了 `free` 的数字例外（目前只有主动程度）：只夹到 min/max，不限一次挪几格。
 */
export function clampVoiceParams(
  schema: VoiceSchema,
  previous: VoiceParams,
  proposed: Partial<VoiceParams> | null | undefined
): { params: VoiceParams; changed: { key: string; from: VoiceParamValue; to: VoiceParamValue }[]; rejected: string[] } {
  const before = normalizeVoiceParams(schema, previous);
  const changed: { key: string; from: VoiceParamValue; to: VoiceParamValue }[] = [];
  const rejected: string[] = [];
  const params: VoiceParams = { ...before };
  const source = isObject(proposed) ? proposed : {};
  for (const [key, node] of Object.entries(schema.nodes)) {
    if (node.type === "number") {
      const old = Number(before[key]);
      let next = Number(source[key]);
      if (!Number.isFinite(next)) continue;
      next = clampNumber(next, node.min, node.max);
      if (node.free) {
        // 自由旋钮：对齐到步长、夹在上下限内，不按"一格"截断。
        next = clampNumber(node.min + Math.round((next - node.min) / node.step) * node.step, node.min, node.max);
        if (next !== old) changed.push({ key, from: old, to: next });
        params[key] = next;
        continue;
      }
      const delta = next - old;
      if (delta > node.step) next = old + node.step;
      if (delta < -node.step) next = old - node.step;
      const aligned = node.min + Math.round((next - node.min) / node.step) * node.step;
      next = clampNumber(aligned, old - node.step, old + node.step);
      next = clampNumber(next, node.min, node.max);
      if (Math.abs(next - old) > node.step + 1e-9) {
        rejected.push(key + " 超过一个步长");
        next = old;
      }
      if (next !== old) changed.push({ key, from: old, to: next });
      params[key] = next;
      continue;
    }
    const oldValue = String(before[key]);
    if (typeof source[key] !== "string") continue;
    const proposedValue = String(source[key]);
    const oldIndex = node.values.findIndex((item) => item.value === oldValue);
    const nextIndex = node.values.findIndex((item) => item.value === proposedValue);
    if (nextIndex < 0) continue;
    if (Math.abs(nextIndex - oldIndex) <= 1) {
      if (proposedValue !== oldValue) changed.push({ key, from: oldValue, to: proposedValue });
      params[key] = proposedValue;
    } else {
      rejected.push(key + " 只能挪到相邻候选");
    }
  }
  return { params, changed, rejected };
}

/** 枚举的值怎么念：name 用真实用户名，没填就按开拓者兜底。 */
function addressLabel(node: VoiceEnumNode, value: VoiceParamValue, userName?: string | null): string {
  if (value === "name") {
    const name = String(userName ?? "").trim();
    return name || "开拓者";
  }
  const hit = node.values.find((item) => item.value === value);
  return hit ? hit.label : String(value);
}

/** 给提示词/面板看的一行性子摘要。 */
export function renderVoiceParamsLine(
  schema: VoiceSchema,
  params: VoiceParams,
  userName?: string | null
): string {
  const parts: string[] = [];
  for (const [key, node] of Object.entries(schema.nodes)) {
    const value = params[key];
    if (node.type === "number") {
      parts.push(node.label + " " + String(value) + "/" + String(node.max));
    } else {
      parts.push(node.label + "：" + addressLabel(node, value, userName));
    }
  }
  return "我现在的性子：" + parts.join("；");
}

/** 给模型看的参数说明。 */
export function renderVoiceSchemaHint(
  schema: VoiceSchema,
  params: VoiceParams,
  userName?: string | null
): string {
  const lines = Object.entries(schema.nodes).map(([key, node]) => {
    if (node.type === "number") {
      return (
        "- " +
        key +
        "（" +
        node.label +
        "）：数字 " +
        node.min +
        "–" +
        node.max +
        "，" +
        (node.free ? "可以一次挪多格，但要有依据" : "每次最多挪 " + node.step) +
        "，现在是 " +
        String(params[key])
      );
    }
    return (
      "- " +
      key +
      "（" +
      node.label +
      "）：只能保持或挪到相邻候选（" +
      node.values.map((item) => (item.value === "name" ? "名字" : item.label)).join(" / ") +
      "），现在是 " +
      addressLabel(node, params[key], userName)
    );
  });
  return lines.join("\n");
}

/** 清掉模型带出来的壳，再按句子边界截到上限。 */
export function cleanVoiceProfile(raw: string): string {
  let text = String(raw ?? "").trim();
  text = text.replace(/^\s*#{1,6}[^\n]*\n+/, "");
  text = text
    .split("\n")
    .map((line) => line.replace(/^\s*[-*•·]\s+/, "").trim())
    .filter((line) => line.length > 0)
    .join("\n");
  text = text.replace(/^["'「『]+/, "").replace(/["'」』]+$/, "").trim();
  if (text.length > VOICE_PROFILE_MAX_CHARS) {
    const cut = text.slice(0, VOICE_PROFILE_MAX_CHARS);
    const lastStop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf("\n"));
    text = lastStop > VOICE_PROFILE_MAX_CHARS * 0.5 ? cut.slice(0, lastStop + 1) : cut;
  }
  return text.trim();
}

export interface VoicePrompt {
  system: string;
  user: string;
}

/** 生成提示词：样本 + 上一版 + 当前参数 → 新的语气笔记与参数。 */
export function buildVoicePrompt(input: {
  samples: readonly string[];
  previousProfile: string | null;
  previousParams: VoiceParams;
  schema?: VoiceSchema;
  /** 引导页里填的用户名：只用来把「名字」这一档念成真名。 */
  userName?: string | null;
}): VoicePrompt {
  const schema = input.schema ?? normalizeVoiceSchema();
  const samples = input.samples
    .slice(0, VOICE_SAMPLE_LIMIT)
    .map((sample) => sample.trim())
    .filter((sample) => sample.length > 0)
    .join("\n\n---\n\n");

  const system = [
    "你在修订一段关于「你自己怎么说话」的笔记，顺便把自己的性子挪一格。它不是设定集，是你观察自己之后写下来的。",
    "",
    "规矩：",
    "1. 第一人称，平铺直叙。不抒情，不喊口号，不用形容词堆砌自己。",
    "2. 只写你真在用的习惯：句子一般多长、爱用和不用哪些词、不耐烦时怎么表达、拒绝时怎么绕、什么时候会多补一句、什么时候干脆不接话。",
    "3. 不写身份介绍（你是谁不在这重复），不写别人怎么看你。",
    "4. profile 是纯文本：不要标题、不要列表符号、不要引号包裹、不要解释，最多 " + VOICE_PROFILE_MAX_CHARS + " 字。",
    "5. 参数一般只能动一格：数字每次最多一个步长；枚举只能保持或挪到相邻候选。",
    "   主动程度例外：它可以直接挪到 0–100 之间的任何一档——它决定你多久去找他一次，跟着最近聊得像不像话走。但它动一下就是真动，要有依据。",
    "   没有依据就别动任何参数。",
    "",
    "参数说明：",
    renderVoiceSchemaHint(schema, input.previousParams, input.userName),
    "",
    '只输出 JSON：{"profile": "……", "params": {…}}。不要代码块，不要多余的话。',
  ].join("\n");

  const user = [
    "下面是你最近写下的记忆，它们是你语气的样本：",
    "",
    samples || "（还没有）",
    "",
    "你上一次写的笔记是：",
    "",
    input.previousProfile && input.previousProfile.trim() ? input.previousProfile.trim() : "（还没有写过）",
    "",
    "当前参数：" + JSON.stringify(input.previousParams),
    "",
    "现在重写这段笔记，并给出新的参数。新样本说明你以前写得不准，就改掉；没变化就保持原样。",
  ].join("\n");

  return { system, user };
}

/** 解析模型输出；不合法返回 null（保留旧版）。 */
export function parseVoiceReply(
  raw: unknown,
  schema: VoiceSchema,
  previousParams: VoiceParams
): { profile: string; params: VoiceParams; changed: { key: string; from: VoiceParamValue; to: VoiceParamValue }[]; rejected: string[] } | null {
  const parsed = extractJsonObject(raw);
  if (!parsed) return null;
  const profile = cleanVoiceProfile(typeof parsed.profile === "string" ? parsed.profile : "");
  if (!profile) return null;
  const proposed = isObject(parsed.params) ? (parsed.params as Partial<VoiceParams>) : {};
  const clamped = clampVoiceParams(schema, previousParams, proposed);
  return { profile, params: clamped.params, changed: clamped.changed, rejected: clamped.rejected };
}

function snapshotOf(state: VoiceState): VoiceSnapshot {
  return {
    version: state.version,
    profile: state.profile,
    params: state.params,
    updatedAt: state.updatedAt,
    reason: state.reason,
  };
}

function pushHistory(state: VoiceState): VoiceSnapshot[] {
  return [snapshotOf(state), ...state.history].slice(0, VOICE_SNAPSHOT_LIMIT);
}

/** 一次生成/重写之后的新状态（版本 +1，旧版进历史）。 */
export function applyVoiceGeneration(
  previous: VoiceState | null,
  input: { profile: string; params: VoiceParams; reason: string; now?: number }
): VoiceState {
  const updatedAt = new Date(input.now ?? Date.now()).toISOString();
  if (!previous) {
    return {
      version: 1,
      profile: input.profile,
      params: input.params,
      updatedAt,
      reason: input.reason,
      history: [],
    };
  }
  return {
    version: previous.version + 1,
    profile: input.profile,
    params: input.params,
    updatedAt,
    reason: input.reason,
    history: pushHistory(previous),
  };
}

/** 手动改参数：版本 +1，旧版进历史（写歪了能回滚）。 */
export function applyVoiceParams(
  previous: VoiceState,
  params: VoiceParams,
  input: { reason?: string; now?: number } = {}
): VoiceState {
  return {
    version: previous.version + 1,
    profile: previous.profile,
    params,
    updatedAt: new Date(input.now ?? Date.now()).toISOString(),
    reason: input.reason ?? "manual",
    history: pushHistory(previous),
  };
}

/** 回滚到某个历史快照；找不到返回 null。 */
export function rollbackVoiceState(previous: VoiceState, version: number, now = Date.now()): VoiceState | null {
  const hit = previous.history.find((item) => item.version === version);
  if (!hit) return null;
  return {
    version: previous.version + 1,
    profile: hit.profile,
    params: hit.params,
    updatedAt: new Date(now).toISOString(),
    reason: "rollback:" + version,
    history: pushHistory(previous),
  };
}

/** 读状态；没有/损坏/结构不对都当没有。 */
export async function readVoiceState(store: NmsStore): Promise<VoiceState | null> {
  const raw = await store.getMeta(VOICE_META_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  if (typeof parsed.profile !== "string" || !parsed.profile.trim()) return null;
  if (!Number.isFinite(Number(parsed.version)) || Number(parsed.version) <= 0) return null;
  const schema = normalizeVoiceSchema();
  const params = normalizeVoiceParams(schema, isObject(parsed.params) ? (parsed.params as VoiceParams) : null);
  const history: VoiceSnapshot[] = Array.isArray(parsed.history)
    ? parsed.history
        .filter((item): item is Record<string, unknown> => isObject(item))
        .map((item) => ({
          version: Number(item.version) || 0,
          profile: String(item.profile ?? ""),
          params: normalizeVoiceParams(schema, isObject(item.params) ? (item.params as VoiceParams) : null),
          updatedAt: String(item.updatedAt ?? ""),
          reason: String(item.reason ?? ""),
        }))
        .slice(0, VOICE_SNAPSHOT_LIMIT)
    : [];
  return {
    version: Number(parsed.version),
    profile: parsed.profile.trim(),
    params,
    updatedAt: String(parsed.updatedAt ?? ""),
    reason: String(parsed.reason ?? ""),
    history,
  };
}

export async function writeVoiceState(store: NmsStore, state: VoiceState): Promise<void> {
  await store.setMeta(VOICE_META_KEY, JSON.stringify(state));
}
