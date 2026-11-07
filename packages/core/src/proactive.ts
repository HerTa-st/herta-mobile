/**
 * 她主动开口的节奏，和她自己的「主动档案」。
 *
 * 频率不该写死成「一天两次」：他调「主动程度」这个旋钮，本身就是一句
 * 「你可以多找我一点 / 少找我一点」。所以每日上限和最短间隔都从旋钮来，
 * 再看最近七天他回得怎么样，上下浮动一档。
 *
 * 档案是给她自己看的：上次什么时候找的、说了什么、他多久回、最后一句留了什么。
 * 下次开口前扫一眼，话才接得上，而不是每次都像第一次想起他。
 *
 * 这里全是纯函数：不读表、不发请求、不看当前时间以外的东西，方便直接测。
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 最近七天：判互动信号只看这个窗口。 */
const SIGNAL_WINDOW_MS = 7 * DAY_MS;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** 最近这段互动里，他是什么态度。 */
export interface InteractionSignals {
  /** 最近 7 天、他回她话的中位延迟（ms）；一次没回就是 null。 */
  medianReplyMs: number | null;
  /** 他回话的平均字数；没有回复样本就是 null。 */
  avgReplyChars: number | null;
  /** 从最新往前数、连续没回的主动次数（碰到第一条有回复的就停）。 */
  consecutiveMisses: number;
  /** 最近 7 天最长的一次回复延迟（ms）；没有回复样本就是 null。 */
  maxGapMs: number | null;
}

/** 旋钮换算出来的两条硬上限。 */
export interface InitiativeLimits {
  /** 一天最多主动几次，0–10。 */
  maxPerDay: number;
  /** 两次之间至少隔多久（ms），45 分钟到 6 小时。 */
  minGapMs: number;
}

/**
 * 他的互动给节奏的修正：-1 / 0 / +1。
 *
 * 负数优先——他连着三次没理、或者最长一次拖过一天，那就是「别追了」，
 * 这时候哪怕中位回得很快也不该加码。回得快且回得长，才是「可以多找一点」。
 */
export function interactionDelta(signals: InteractionSignals | null): number {
  if (!signals) return 0;
  const misses = signals.consecutiveMisses ?? 0;
  if (misses >= 3) return -1;
  if (signals.maxGapMs !== null && signals.maxGapMs > 24 * HOUR_MS) return -1;
  if (
    signals.medianReplyMs !== null &&
    signals.medianReplyMs < 10 * MINUTE_MS &&
    signals.avgReplyChars !== null &&
    signals.avgReplyChars > 15
  ) {
    return 1;
  }
  return 0;
}

/**
 * 旋钮 → 每天上限 + 最短间隔。
 *
 * 上限：base = round((n/100)^2 × 10)，0/40/60/80/100 分别是 0/2/4/6/10；
 *       再按互动信号 ±1，最后夹在 0–10。
 * 间隔：6h − 5h×(n/100)，夹在 [45min, 6h]——旋钮越高，隔得越短。
 */
export function initiativeLimits(initiative: number, signals?: InteractionSignals | null): InitiativeLimits {
  const n = clamp(Number.isFinite(initiative) ? initiative : 40, 0, 100);
  const base = Math.round((n / 100) ** 2 * 10);
  const minGapMs = clamp(6 * HOUR_MS - 5 * HOUR_MS * (n / 100), 45 * MINUTE_MS, 6 * HOUR_MS);
  const maxPerDay = clamp(base + interactionDelta(signals ?? null), 0, 10);
  return { maxPerDay, minGapMs };
}

/** 主动档案最多留几条；再老的就不必记着了。 */
export const PING_LOG_LIMIT = 5;

/** 她主动开口的一条记录。 */
export interface PingLogEntry {
  /** 发送时刻，ISO 字符串。 */
  at: string;
  /** 她当时说了什么。 */
  text: string;
  /** 他隔了多久回（ms）；还没回 / 不知道就是 null。 */
  replyDelayMs?: number | null;
  /** 他回的最后一句。 */
  userLine?: string | null;
}

/**
 * 记一条档案：新的在前，多的截掉。
 *
 * 返回新数组，不动传进来的那份——调用方可能还要拿旧数组做对比。
 */
export function appendPingLog(log: readonly PingLogEntry[], entry: PingLogEntry): PingLogEntry[] {
  return [entry, ...log].slice(0, PING_LOG_LIMIT);
}

/** 中位数；空数组给 null。偶数个取中间两个的平均。 */
function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 从档案里读互动信号。
 *
 * 只看最近 7 天；连续没回从最新往前数，碰到第一条他回过的就停。
 * 平均字数用去空白后的长度，不取整（判 +1 时只和 15 比，没必要圆）。
 */
export function interactionFromLog(log: readonly PingLogEntry[], now: number): InteractionSignals {
  const recent = log.filter((e) => {
    const at = Date.parse(e.at);
    return Number.isFinite(at) && at <= now && now - at <= SIGNAL_WINDOW_MS;
  });

  let consecutiveMisses = 0;
  for (const e of recent) {
    if (typeof e.replyDelayMs === "number" && Number.isFinite(e.replyDelayMs)) break;
    consecutiveMisses += 1;
  }

  const delays: number[] = [];
  const lengths: number[] = [];
  for (const e of recent) {
    if (typeof e.replyDelayMs === "number" && Number.isFinite(e.replyDelayMs) && e.replyDelayMs >= 0) {
      delays.push(e.replyDelayMs);
    }
    if (typeof e.userLine === "string" && e.userLine.trim()) {
      lengths.push(e.userLine.trim().length);
    }
  }

  return {
    medianReplyMs: medianOf(delays),
    avgReplyChars: lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : null,
    consecutiveMisses,
    maxGapMs: delays.length > 0 ? Math.max(...delays) : null,
  };
}

/** 相对时间，给人看的那种：刚刚 / 12分钟前 / 3小时前 / 5天前。 */
function relativeTime(ms: number): string {
  if (ms < MINUTE_MS) return "刚刚";
  if (ms < HOUR_MS) return Math.round(ms / MINUTE_MS) + "分钟前";
  if (ms < DAY_MS) return Math.round(ms / HOUR_MS) + "小时前";
  return Math.round(ms / DAY_MS) + "天前";
}

/** 他隔了多久回，用来说成「他5分钟后回了」。 */
function delayPhrase(ms: number): string {
  if (ms < MINUTE_MS) return "1分钟";
  if (ms < HOUR_MS) return Math.round(ms / MINUTE_MS) + "分钟";
  if (ms < DAY_MS) return Math.round(ms / HOUR_MS) + "小时";
  return Math.round(ms / DAY_MS) + "天";
}

/** 压成一行并截断；太长的那截用省略号收掉。 */
function clipLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + "…" : one;
}

/**
 * 把档案写成一条旁注：上次找他的相对时间 + 说了什么 + 他多久回 + 他最后一句。
 *
 * 第一人称，像她自己想起来的，不用「记录显示」那种口吻。
 * 空档案给 null——没有旧事可提就别硬编。总长压到 300 字以内。
 */
export function buildPingArchiveNote(log: readonly PingLogEntry[], now: number = Date.now()): string | null {
  if (!log || log.length === 0) return null;

  // appendPingLog 约定新的在前；这里再按时间兜一次底，免得手写/旧数据顺序不对。
  let latest = log[0];
  for (const e of log) {
    if (Date.parse(e.at) > Date.parse(latest.at)) latest = e;
  }

  const at = Date.parse(latest.at);
  const rel = Number.isFinite(at) ? relativeTime(Math.max(0, now - at)) : null;
  const said = clipLine(latest.text ?? "", 48);
  const head = rel ? "你上次找他是" + rel : "你上次找他";
  let note = said ? head + "，说的是「" + said + "」。" : head + "。";

  const delay =
    typeof latest.replyDelayMs === "number" && Number.isFinite(latest.replyDelayMs) && latest.replyDelayMs >= 0
      ? latest.replyDelayMs
      : null;
  note += delay === null ? "他还没回。" : "他" + delayPhrase(delay) + "后回了。";

  const userLine = typeof latest.userLine === "string" && latest.userLine.trim() ? clipLine(latest.userLine, 36) : null;
  if (userLine) note += "他最后一句留的是「" + userLine + "」。";

  return note.length > 300 ? note.slice(0, 299) + "…" : note;
}

/**
 * 她多久没被推着多说话，就自己回一点血。
 *
 * 旋钮低于 20、且至少七天没动过（或从没动过）→ 涨 5，封顶 20；
 * 不然返回 null，表示不用动。什么时候调用由 App 层决定。
 */
export function shouldRecoverInitiative(input: { initiative: number; lastMovedAt: number | null; now: number }): number | null {
  if (!(input.initiative < 20)) return null;
  const last = input.lastMovedAt;
  if (last !== null && input.now - last < SIGNAL_WINDOW_MS) return null;
  return Math.min(20, input.initiative + 5);
}

/**
 * 主动开口时带不带当前心情。
 *
 * 负面档（被烦 / 被戳穿 / 被顶嘴）不往主动消息里带——她可以自己闷着，
 * 但不该在没人惹她的时候先甩脸色。平静 / 倾听照带。空心情给 null。
 */
export function moodForPing(mood: string | null, volatile: readonly string[]): string | null {
  if (mood === null || !mood.trim()) return null;
  if (volatile.includes(mood)) return null;
  return mood;
}

/** 会话里她回话时用到的最小结构：只认「谁说的 / 什么时候 / 说了什么」。 */
export interface PingReplyBlock {
  kind: string;
  at?: string | null;
  text?: string | null;
}

/**
 * 把「他回没回、多久回」补进主动档案。
 *
 * 她发出去时不认识回复，等下一次 tick 有会话块了才补——所以每一条还没回的
 * 记录都要单独找它之后的第一条 user 块，不能用「最后一条消息」粗暴顶替。
 * 返回新数组，没变化时 changed=false（调用方据此决定要不要写盘）。
 */
export function fillPingReplies(
  log: readonly PingLogEntry[],
  blocks: readonly PingReplyBlock[],
  now: number
): { log: PingLogEntry[]; changed: boolean } {
  let changed = false;
  const next = log.map((entry) => {
    if (typeof entry.replyDelayMs === "number" && Number.isFinite(entry.replyDelayMs)) return entry;
    const sentAt = Date.parse(entry.at);
    if (!Number.isFinite(sentAt) || sentAt > now) return entry;
    const reply = blocks.find((block) => {
      if (block.kind !== "user" || typeof block.at !== "string") return false;
      const at = Date.parse(block.at);
      return Number.isFinite(at) && at > sentAt;
    });
    if (!reply || typeof reply.at !== "string") return entry;
    changed = true;
    const delay = Math.max(0, Date.parse(reply.at) - sentAt);
    return {
      ...entry,
      replyDelayMs: delay,
      userLine: clipLine(String(reply.text ?? ""), 80),
    };
  });
  return { log: next, changed };
}
