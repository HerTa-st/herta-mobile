import type { TokenUsage } from "@herta/protocol";

/**
 * 今日用量账本（B14）：所有调模型的地方都往这里记一笔。
 *
 * 三条规矩（设计文档 §6.3）：
 *   - **全算，含后台**：深睡、自动语气、播报这些你不看着的时候也在花；
 *   - **分链路**：复核那段 system 两万多字符、每轮重发，只看总数永远看不出它；
 *   - **只留当天**：按本地自然日做键，过零点就是新的一页（旧那页读的时候直接当空）。
 *
 * 为什么不进 settings：用量是过程数据，不是用户的选择；而且每秒都可能变，
 * 塞进 settings 会带着「保存设置」那套语义乱跑。单独一个 key，写坏了也不影响设置。
 */

export type UsageSource =
  | "chat"
  | "review"
  | "mood"
  | "redo"
  | "broadcast"
  | "reader"
  | "deepSleep"
  | "voice"
  | "proactive";

/** 明细里从上往下的顺序：先聊天这条主线，再是后台那些你看不见的。 */
export const USAGE_SOURCES: readonly UsageSource[] = [
  "chat",
  "review",
  "mood",
  "redo",
  "broadcast",
  "reader",
  "deepSleep",
  "voice",
  "proactive",
];

export const USAGE_LABELS: Record<UsageSource, string> = {
  chat: "主对话",
  review: "复核",
  mood: "判心情",
  redo: "重说",
  broadcast: "播报",
  reader: "读原文",
  deepSleep: "深睡",
  voice: "自动语气",
  proactive: "主动消息",
};

export interface UsageRow {
  /** 输入 token（含缓存命中的那部分）。 */
  prompt: number;
  /** 输出 token。 */
  completion: number;
  /** 缓存命中：接口给了就记，没给就是 0。 */
  cached: number;
  /** 这段时间里发了几次请求。 */
  calls: number;
}

export interface UsageDay {
  /** 本地自然日 YYYY-MM-DD。 */
  date: string;
  rows: Record<UsageSource, UsageRow>;
  prompt: number;
  completion: number;
  cached: number;
  calls: number;
}

const KEY = "herta.usage.v1";

/** 账本变了就通知一声（设置里那行和明细页都靠它刷新）。 */
const listeners = new Set<() => void>();

export function subscribeUsage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.warn("用量订阅者出错：", error);
    }
  }
}

/** 本地自然日的键。**必须用本地时区**——按 UTC 算的话，晚上八点后就开始算第二天了。 */
export function localDayKey(now: number = Date.now()): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function emptyRows(): Record<UsageSource, UsageRow> {
  const rows = {} as Record<UsageSource, UsageRow>;
  for (const source of USAGE_SOURCES) rows[source] = { prompt: 0, completion: 0, cached: 0, calls: 0 };
  return rows;
}

function emptyDay(now: number): UsageDay {
  return { date: localDayKey(now), rows: emptyRows(), prompt: 0, completion: 0, cached: 0, calls: 0 };
}

/** 偶数、负数、NaN、字符串一律当 0：账本宁可少记，也不要记出个假数。 */
function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function row(raw: unknown): UsageRow {
  const item = (raw ?? {}) as Record<string, unknown>;
  return {
    prompt: count(item.prompt),
    completion: count(item.completion),
    cached: count(item.cached),
    calls: count(item.calls),
  };
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null; // 隐私模式 / 被禁用
  }
}

/** 读今天这一页。要么是今天，要么是空的——没有「昨天」这一页。 */
export function readUsage(now: number = Date.now()): UsageDay {
  const today = localDayKey(now);
  const store = storage();
  if (!store) return emptyDay(now);
  const raw = store.getItem(KEY);
  if (!raw) return emptyDay(now);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyDay(now);
  }
  const doc = (parsed ?? {}) as Record<string, unknown>;
  if (doc.date !== today) return emptyDay(now);
  const stored = (doc.rows ?? {}) as Record<string, unknown>;
  const day = emptyDay(now);
  for (const source of USAGE_SOURCES) {
    const item = row(stored[source]);
    day.rows[source] = item;
    day.prompt += item.prompt;
    day.completion += item.completion;
    day.cached += item.cached;
    day.calls += item.calls;
  }
  return day;
}

function write(day: UsageDay): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify({ date: day.date, rows: day.rows }));
  } catch (error) {
    console.warn("用量没存下来（本地存储满了）", error);
  }
}

/**
 * 记一笔。跨天时自动开新页：昨天那页连同旧 key 一起被今天的覆盖掉。
 * 返回写完之后今天这一页，调用方要显示就用它，不用再读一遍。
 */
export function recordUsage(
  source: UsageSource,
  prompt: number,
  completion: number,
  options: { cached?: number; calls?: number; now?: number } = {}
): UsageDay {
  const now = options.now ?? Date.now();
  const day = readUsage(now);
  const add = day.rows[source];
  add.prompt += count(prompt);
  add.completion += count(completion);
  add.cached += count(options.cached);
  add.calls += Math.max(1, count(options.calls ?? 1));
  day.prompt += count(prompt);
  day.completion += count(completion);
  day.cached += count(options.cached);
  day.calls += Math.max(1, count(options.calls ?? 1));
  write(day);
  notify();
  return day;
}

/**
 * 把接口回执直接记进来。没回执（那家接口不给 usage）就什么也不记——
 * 宁可这一行是空的，也别挂个「0 tok」骗人。
 */
export function recordUsageFrom(
  source: UsageSource,
  usage: TokenUsage | null | undefined,
  now: number = Date.now()
): UsageDay | null {
  if (!usage) return null;
  const prompt = count(usage.prompt);
  const completion = count(usage.completion);
  const cached = count(usage.cached);
  const calls = count(usage.calls);
  if (prompt === 0 && completion === 0 && calls === 0) return null;
  return recordUsage(source, prompt, completion, {
    cached,
    calls: calls > 0 ? calls : 1,
    now,
  });
}

/** 清空今天（调试 / 测试用；界面上没暴露）。 */
export function clearUsage(): void {
  const store = storage();
  if (store) {
    try {
      store.removeItem(KEY);
    } catch {
      /* 删不掉就算了，下次写会覆盖 */
    }
  }
  notify();
}
