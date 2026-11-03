/**
 * 换机：把她的会话、记忆、表情打成一个包，另一台手机上拆回去。
 *
 * 和"导入"（core/import.ts）是两件事：
 *   - 导入是把**别处的对话**搬进来（通常是 DeepSeek 分享链接），只读归档，进来之后是 origin="import"；
 *   - 备份是把**这个 App 自己的家**整个搬到另一台手机上：会话原样、记忆原样、表情原样，
 *     连块里的表情引用都能对上（所以表情要跟着走，不然历史里全是「表情已删」）。
 *
 * 包里**不带 API Key**：那不是她的东西，是用户的凭据。要换机就重新填一次。
 */

import type { Block, Session } from "../../protocol/src/index.ts";
import type { MemoryRecord } from "./memory.ts";
import type { BroadcastIssue, BroadcastItem } from "./broadcast.ts";

export const BACKUP_FORMAT = "herta-backup";
/** v1 = 旧 MemoryRecord 备份；v2 = 允许带 NMS 快照（当前先保留字段，恢复由 app 层迁移旧记忆）。 */
export const BACKUP_VERSION = 2;

/** 表情也一样要搬：表情块只存引用，不带图过去，历史里那几张就全变成「已删」。 */
export interface BackupSticker {
  id: string;
  name: string;
  tags: string[];
  data: string;
  mediaType: string;
  createdAt: string;
  owner?: "herta" | "mine";
}

/**
 * 黑塔币钱包。
 *
 * 结构刻意和 `@herta/coin` 的 `CoinWallet` 保持一致，但 core 不 import 那个包：
 * 依赖方向是 coin →（无），core 是地基，不该反过来拉一个业务模块。
 * 两边形状由 app 层赋值时做结构校验（TypeScript 结构化类型会直接卡住）。
 */
export interface BackupCoinWallet {
  version: 1;
  holdings: number;
  costPrice: number;
  initialAt: string;
  lastSign: { date: string; streak: number; price: number; reward: number } | null;
  history: Array<{ date: string; reward: number; price: number }>;
  updatedAt: string;
}

export interface BackupBundle {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  /** 从哪台设备导出来的，只在导入时显示一句"来自……"。 */
  from?: string;
  sessions: Session[];
  memories: MemoryRecord[];
  stickers?: BackupSticker[];
  /** 设置（**不含 Key**）。 */
  settings?: Record<string, unknown>;
  /** 黑塔币钱包（v1 单机；换机时跟着走）。 */
  coin?: BackupCoinWallet;
  /** 星际和平播报：一期一条，换机时跟着走。 */
  broadcast?: BroadcastIssue[];
  /** v2：NMS 快照（可选；没有时恢复旧 MemoryRecord 后再迁移）。 */
  nms?: unknown;
}

export interface BackupStats {
  sessions: number;
  blocks: number;
  memories: number;
  stickers: number;
  /** 播报期数（可选：旧包没有这一项）。 */
  broadcast?: number;
  /** JSON 的字节数（按 UTF-8 算）。 */
  bytes: number;
}

export interface BuildBackupInput {
  sessions: readonly Session[];
  memories: readonly MemoryRecord[];
  stickers?: readonly BackupSticker[];
  settings?: Record<string, unknown>;
  coin?: BackupCoinWallet;
  broadcast?: readonly BroadcastIssue[];
  nms?: unknown;
  from?: string;
  now?: Date;
}

function byteLength(text: string): number {
  // 手机上没有 TextEncoder 之外更省事的路；这里只用来显示"包多大"
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return text.length * 2;
}

/**
 * 打一个包。
 *
 * 字节数在打完之后算一遍：快照里几 MB 的表情会让包变大，用户有权在分享前知道。
 */
export function buildBackupBundle(input: BuildBackupInput): { bundle: BackupBundle; stats: BackupStats } {
  const now = input.now ?? new Date();
  const bundle: BackupBundle = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    ...(input.from ? { from: input.from } : {}),
    sessions: input.sessions.map((s) => ({ ...s, blocks: [...s.blocks] })),
    memories: input.memories.map((m) => ({ ...m })),
    ...(input.stickers && input.stickers.length > 0 ? { stickers: input.stickers.map((s) => ({ ...s })) } : {}),
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.coin ? { coin: { ...input.coin } } : {}),
    ...(input.broadcast && input.broadcast.length > 0
      ? { broadcast: input.broadcast.map((issue) => ({ ...issue, items: issue.items.map((item) => ({ ...item })) })) }
      : {}),
    ...(input.nms !== undefined ? { nms: input.nms } : {}),
  };
  const bytes = byteLength(JSON.stringify(bundle));
  return {
    bundle,
    stats: {
      sessions: bundle.sessions.length,
      blocks: bundle.sessions.reduce((n, s) => n + s.blocks.length, 0),
      memories: bundle.memories.length,
      stickers: bundle.stickers?.length ?? 0,
      broadcast: bundle.broadcast?.length ?? 0,
      bytes,
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type ParseBackupResult = { ok: true; bundle: BackupBundle; stats: BackupStats } | { ok: false; error: string };

/**
 * 拆钱包：坏数据丢掉整块，不因为钱包脏了就让整份家底进不来。
 * 数量/成本价必须是有限数；连签记录坏了就当从没签过（最多丢一条签到，不丢本金）。
 */
function sanitizeCoin(raw: unknown): BackupCoinWallet | null {
  if (!isRecord(raw)) return null;
  const holdings = Number(raw.holdings);
  const costPrice = Number(raw.costPrice);
  if (!Number.isFinite(holdings) || holdings < 0 || !Number.isFinite(costPrice) || costPrice <= 0) return null;

  const at = String(raw.initialAt ?? new Date().toISOString());
  const updatedAt = String(raw.updatedAt ?? at);

  let lastSign: BackupCoinWallet["lastSign"] = null;
  if (isRecord(raw.lastSign)) {
    const streak = Math.floor(Number(raw.lastSign.streak));
    const price = Number(raw.lastSign.price);
    const reward = Number(raw.lastSign.reward);
    const date = String(raw.lastSign.date ?? "");
    if (date && Number.isFinite(streak) && streak > 0 && Number.isFinite(price) && Number.isFinite(reward)) {
      lastSign = { date, streak, price, reward };
    }
  }

  const history: BackupCoinWallet["history"] = [];
  if (Array.isArray(raw.history)) {
    for (const item of raw.history) {
      if (!isRecord(item)) continue;
      const date = String(item.date ?? "");
      const reward = Number(item.reward);
      const price = Number(item.price);
      if (date && Number.isFinite(reward) && Number.isFinite(price)) history.push({ date, reward, price });
    }
  }

  return {
    version: 1,
    holdings,
    costPrice,
    initialAt: at,
    lastSign,
    history: history.slice(-60),
    updatedAt,
  };
}

/* ---------------------------------------------------------------- 播报 */

/**
 * 拆播报：坏一条丢掉、坏一期丢掉，不因为播报脏了就让整份家底进不来。
 * 真新闻必须有 http(s) 原文；彩蛋没有链接（和设计一致）。
 */
function sanitizeBroadcastItem(raw: unknown): BroadcastItem | null {
  if (!isRecord(raw)) return null;
  const egg = raw.egg === true;
  const title = String(raw.title ?? "").trim();
  const summary = String(raw.summary ?? "").trim();
  const comment = String(raw.comment ?? "").trim();
  if (!title || !summary || !comment) return null;
  const url = egg ? "" : String(raw.url ?? "").trim();
  if (!egg && !/^https?:\/\//i.test(url)) return null;
  return {
    id: String(raw.id ?? "").trim() || (egg ? "egg-" + title.slice(0, 8) : url),
    source: String(raw.source ?? "").trim() || (egg ? "星际和平公司" : "媒体"),
    domain: egg ? "" : String(raw.domain ?? "").trim(),
    title,
    summary,
    url,
    ...(typeof raw.publishedAt === "string" ? { publishedAt: raw.publishedAt } : {}),
    ...(typeof raw.tag === "string" ? { tag: raw.tag } : {}),
    comment,
    ...(egg ? { egg: true } : {}),
  };
}

function sanitizeBroadcast(raw: unknown): BroadcastIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: BroadcastIssue[] = [];
  for (const rawIssue of raw) {
    if (!isRecord(rawIssue)) continue;
    const id = String(rawIssue.id ?? "").trim();
    const date = String(rawIssue.date ?? "").trim();
    const no = Number(rawIssue.no);
    if (!id || !date || !Number.isFinite(no) || no < 1) continue;
    const items = Array.isArray(rawIssue.items)
      ? rawIssue.items.map(sanitizeBroadcastItem).filter((item): item is BroadcastItem => item !== null)
      : [];
    if (items.length === 0) continue;
    out.push({
      id,
      no: Math.floor(no),
      date,
      createdAt: typeof rawIssue.createdAt === "string" ? rawIssue.createdAt : new Date().toISOString(),
      items,
      status: "ready",
    });
  }
  return out;
}

const BLOCK_KINDS = new Set(["user", "herta", "system", "sticker"]);

/** 校验一块。坏块丢掉，不整包失败——一个坏块不该让整份家底进不来。 */
function sanitizeBlock(raw: unknown): Block | null {
  if (!isRecord(raw)) return null;
  const kind = String(raw.kind ?? "");
  if (!BLOCK_KINDS.has(kind)) return null;
  const at = typeof raw.at === "string" ? raw.at : new Date().toISOString();
  if (kind === "user") {
    return {
      kind: "user",
      text: String(raw.text ?? ""),
      at,
      ...(Array.isArray(raw.attachments) ? { attachments: raw.attachments.filter(isRecord) as never } : {}),
    };
  }
  if (kind === "herta") {
    const surface = raw.surface === "thought" ? "thought" : "speech";
    return {
      kind: "herta",
      surface,
      text: String(raw.text ?? ""),
      at,
      ...(Array.isArray(raw.attachments) ? { attachments: raw.attachments.filter(isRecord) as never } : {}),
      ...(isRecord(raw.usage) ? { usage: raw.usage as never } : {}),
      // 播报提示的按钮要跟着备份走，不然恢复之后只剩一句话、点不开播报页
      ...(isRecord(raw.action) &&
      raw.action.kind === "broadcast" &&
      typeof raw.action.issueId === "string" &&
      Number.isFinite(Number(raw.action.no))
        ? {
            action: {
              kind: "broadcast" as const,
              issueId: String(raw.action.issueId),
              no: Math.floor(Number(raw.action.no)),
            },
          }
        : {}),
    };
  }
  if (kind === "sticker") {
    return {
      kind: "sticker",
      from: raw.from === "herta" ? "herta" : "user",
      stickerId: String(raw.stickerId ?? ""),
      name: String(raw.name ?? ""),
      at,
    };
  }
  return {
    kind: "system",
    label: raw.label === "差分协处理器" ? "差分协处理器" : "系统",
    body: String(raw.body ?? ""),
    at,
    // 隐藏标记要跟着备份走：不然恢复之后文件库事件又会在聊天里刷屏
    ...(raw.hidden === true ? { hidden: true } : {}),
  };
}

/**
 * 拆一份包。
 *
 * 宽松到什么程度：块坏了丢掉、会话缺 id 丢掉、记忆缺正文丢掉——**不因为一条坏数据
 * 把整份家底拒之门外**。但格式与版本必须对，否则拆出来的就是别的东西。
 */
export function parseBackupBundle(raw: string): ParseBackupResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: "不是合法的 JSON：" + (e instanceof Error ? e.message : String(e)) };
  }
  if (!isRecord(parsed)) return { ok: false, error: "顶层不是一个对象" };
  if (parsed.format !== BACKUP_FORMAT) {
    return { ok: false, error: "这不是备份包（format 应当是 " + BACKUP_FORMAT + "）" };
  }
  const version = Number(parsed.version);
  if (!Number.isInteger(version) || version < 1 || version > BACKUP_VERSION) {
    return { ok: false, error: "备份版本不支持：" + String(parsed.version) + "（这个版本接受 1.." + BACKUP_VERSION + "）" };
  }

  const sessions: Session[] = [];
  if (Array.isArray(parsed.sessions)) {
    for (const rawSession of parsed.sessions) {
      if (!isRecord(rawSession)) continue;
      const id = String(rawSession.id ?? "").trim();
      if (!id) continue;
      const blocks = Array.isArray(rawSession.blocks)
        ? rawSession.blocks.map(sanitizeBlock).filter((b): b is Block => b !== null)
        : [];
      if (blocks.length === 0) continue;
      sessions.push({
        id,
        title: String(rawSession.title ?? "新的对话"),
        origin: (rawSession.origin === "import" || rawSession.origin === "pc" ? rawSession.origin : "phone") as Session["origin"],
        createdAt: String(rawSession.createdAt ?? new Date().toISOString()),
        updatedAt: String(rawSession.updatedAt ?? rawSession.createdAt ?? new Date().toISOString()),
        blocks,
      });
    }
  }

  const memories: MemoryRecord[] = [];
  if (Array.isArray(parsed.memories)) {
    for (const raw of parsed.memories) {
      if (!isRecord(raw)) continue;
      const name = String(raw.name ?? "").trim();
      const body = String(raw.body ?? "");
      if (!name || !body.trim()) continue;
      memories.push({
        name,
        body,
        createdAt: String(raw.createdAt ?? new Date().toISOString()),
        ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
        ...(typeof raw.tag === "string" ? { tag: raw.tag } : {}),
        ...(typeof raw.weight === "number" ? { weight: raw.weight } : {}),
        ...(Array.isArray(raw.links) ? { links: raw.links.filter((l): l is string => typeof l === "string") } : {}),
        ...(typeof raw.gist === "string" ? { gist: raw.gist } : {}),
        ...(typeof raw.recalls === "number" && Number.isFinite(raw.recalls) ? { recalls: raw.recalls } : {}),
        ...(typeof raw.lastRecallAt === "string" ? { lastRecallAt: raw.lastRecallAt } : {}),
        ...(typeof raw.deepenNote === "string" ? { deepenNote: raw.deepenNote } : {}),
        ...(raw.forgotten === true ? { forgotten: true } : {}),
      });
    }
  }

  const stickers: BackupSticker[] = [];
  if (Array.isArray(parsed.stickers)) {
    for (const raw of parsed.stickers) {
      if (!isRecord(raw)) continue;
      const id = String(raw.id ?? "").trim();
      const data = String(raw.data ?? "");
      if (!id || !data.startsWith("data:")) continue;
      stickers.push({
        id,
        name: String(raw.name ?? "表情"),
        tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
        data,
        mediaType: String(raw.mediaType ?? "image/jpeg"),
        createdAt: String(raw.createdAt ?? new Date().toISOString()),
        ...(raw.owner === "mine" ? { owner: "mine" as const } : { owner: "herta" as const }),
      });
    }
  }

  const coin = sanitizeCoin(parsed.coin);
  const broadcast = sanitizeBroadcast(parsed.broadcast);

  if (sessions.length === 0 && memories.length === 0 && broadcast.length === 0 && !coin) {
    return { ok: false, error: "包里没有能用的会话或记忆" };
  }

  const bundle: BackupBundle = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: String(parsed.exportedAt ?? new Date().toISOString()),
    ...(typeof parsed.from === "string" ? { from: parsed.from } : {}),
    sessions,
    memories,
    ...(stickers.length > 0 ? { stickers } : {}),
    ...(isRecord(parsed.settings) ? { settings: parsed.settings } : {}),
    ...(coin ? { coin } : {}),
    ...(broadcast.length > 0 ? { broadcast } : {}),
    ...(isRecord(parsed.nms) ? { nms: parsed.nms } : {}),
  };
  return {
    ok: true,
    bundle,
    stats: {
      sessions: sessions.length,
      blocks: sessions.reduce((n, s) => n + s.blocks.length, 0),
      memories: memories.length,
      stickers: stickers.length,
      broadcast: broadcast.length,
      bytes: byteLength(raw),
    },
  };
}

export interface RestoreExisting {
  sessionIds: ReadonlySet<string>;
  memoryNames: ReadonlySet<string>;
  stickerIds: ReadonlySet<string>;
  /** 本机已经有的播报期 id（日期）；同一期不重复写。 */
  broadcastIds?: ReadonlySet<string>;
  /** 本机已经有黑塔币钱包：不覆盖（钱包只有一个，覆盖等于把本地的币抹掉）。 */
  wallet?: boolean;
}

export interface RestorePlan {
  sessions: Session[];
  memories: MemoryRecord[];
  stickers: BackupSticker[];
  broadcast: BroadcastIssue[];
  coin?: BackupCoinWallet;
  skipped: { sessions: number; memories: number; stickers: number; broadcast: number };
}

/**
 * 决定哪些该写进去。
 *
 * 同一份包导两次不该出现两份：会话按 id、记忆按文件名、表情按 id 去重。
 * 跳过就是跳过，不覆盖——她那边可能已经改过同名那条。
 */
export function planRestore(bundle: BackupBundle, existing: RestoreExisting): RestorePlan {
  const sessions: Session[] = [];
  const memories: MemoryRecord[] = [];
  const stickers: BackupSticker[] = [];
  const broadcast: BroadcastIssue[] = [];
  let skipS = 0;
  let skipM = 0;
  let skipK = 0;
  let skipB = 0;
  const broadcastIds = existing.broadcastIds ?? new Set<string>();

  for (const s of bundle.sessions) {
    if (existing.sessionIds.has(s.id)) skipS += 1;
    else if (!sessions.some((x) => x.id === s.id)) sessions.push(s);
  }
  for (const m of bundle.memories) {
    if (existing.memoryNames.has(m.name)) skipM += 1;
    else if (!memories.some((x) => x.name === m.name)) memories.push(m);
  }
  for (const k of bundle.stickers ?? []) {
    if (existing.stickerIds.has(k.id)) skipK += 1;
    else if (!stickers.some((x) => x.id === k.id)) stickers.push(k);
  }
  for (const issue of bundle.broadcast ?? []) {
    if (broadcastIds.has(issue.id)) skipB += 1;
    else if (!broadcast.some((x) => x.id === issue.id)) broadcast.push(issue);
  }

  return {
    sessions,
    memories,
    stickers,
    broadcast,
    ...(bundle.coin && !existing.wallet ? { coin: { ...bundle.coin } } : {}),
    skipped: { sessions: skipS, memories: skipM, stickers: skipK, broadcast: skipB },
  };
}

/** 人类可读的大小。 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}
