/**
 * 落盘：IndexedDB。
 *
 * 一个库，几个 store：
 *   sessions —— 会话（键 id）
 *   memories —— 记忆库（键 name，就是那个 `### 废案_NN：标题.txt` 文件名）
 *   kv       —— 零散状态（做梦进度等）
 *   stickers —— 表情库（键 id）
 *   coin     —— 黑塔币钱包与行情缓存（键 key：wallet / quote）
 *
 * 不用 localStorage：只有几 MB，一条长会话就能撑爆，而且同步写会卡 UI。
 * 版本号只增不减；升级时在 onupgradeneeded 里按 oldVersion 补 store。
 */

import type { Session } from "@herta/protocol";
import { MOOD_TTL_MS, type MoodState } from "@herta/core";

const DB_NAME = "herta";
const DB_VERSION = 5;

export const STORE_SESSIONS = "sessions";
export const STORE_MEMORIES = "memories";
export const STORE_KV = "kv";
export const STORE_STICKERS = "stickers";
/** 黑塔币：钱包 + 最后一次成功的行情响应。设计见 docs/设计-黑塔币-v1.md。 */
export const STORE_COIN = "coin";
/** 星际和平播报：一期一条，键 = 本地日期。设计见 docs/设计-星际和平播报-v1.md。 */
export const STORE_BROADCAST = "broadcast";

/** 表情是谁的：她的库（她发给你）还是你的箱（你发给她）。 */
export type StickerOwner = "herta" | "mine";

export interface StickerRecord {
  id: string;
  name: string;
  /** 粗略标签，她按心情挑的时候用。配了视觉模型时自动打，手改也行。 */
  tags: string[];
  data: string;
  mediaType: string;
  createdAt: string;
  /** 老记录没有这个字段（那时候只有她的库），读出来一律按她的算。 */
  owner: StickerOwner;
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: string;
  blocks: number;
  /** 列表里要能看出哪些是从别处导进来的。 */
  origin: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const s = db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
        s.createIndex("updatedAt", "updatedAt");
      }
      // v2：记忆库与零散状态
      if (!db.objectStoreNames.contains(STORE_MEMORIES)) {
        db.createObjectStore(STORE_MEMORIES, { keyPath: "name" });
      }
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV, { keyPath: "key" });
      }
      // v3：表情库
      if (!db.objectStoreNames.contains(STORE_STICKERS)) {
        db.createObjectStore(STORE_STICKERS, { keyPath: "id" });
      }
      // v4：黑塔币（钱包 / 最后一次行情缓存，键固定 wallet / quote）
      if (!db.objectStoreNames.contains(STORE_COIN)) {
        db.createObjectStore(STORE_COIN, { keyPath: "key" });
      }
      // v5：星际和平播报（一期一条，键 = 本地日期）
      if (!db.objectStoreNames.contains(STORE_BROADCAST)) {
        db.createObjectStore(STORE_BROADCAST, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("打不开 IndexedDB"));
  });
}

/** 泛型事务：每次调用开一次连接。手机上这点开销可以忽略，换来的是不会持有陈连接。 */
export function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB 操作失败"));
        t.oncomplete = () => db.close();
      })
  );
}

export async function listSessions(): Promise<SessionMeta[]> {
  const all = (await tx<Session[]>(STORE_SESSIONS, "readonly", (s) => s.getAll() as IDBRequest<Session[]>)) ?? [];
  return all
    .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, blocks: s.blocks.length, origin: s.origin }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function loadSession(id: string): Promise<Session | null> {
  const got = await tx<Session | undefined>(STORE_SESSIONS, "readonly", (s) => s.get(id) as IDBRequest<Session | undefined>);
  return got ?? null;
}

export async function putSession(session: Session): Promise<void> {
  await tx(STORE_SESSIONS, "readwrite", (s) => s.put(session));
}

export async function deleteSession(id: string): Promise<void> {
  await tx(STORE_SESSIONS, "readwrite", (s) => s.delete(id));
}

/** 重命名会话：只改标题，消息与时间一点都不动。 */
export async function renameSession(id: string, title: string): Promise<void> {
  const session = await loadSession(id);
  if (!session) return;
  const next = title.trim();
  if (!next || next === session.title) return;
  await putSession({ ...session, title: next });
}

const PINNED_KEY = "sessions.pinned";

/**
 * 置顶会话的 id（按置顶先后）。
 *
 * 会话对象里不加字段：备份包、协议、老版本读到的会话都保持原样；
 * 置顶只是这台手机上的一张顺序表。
 */
export async function loadPinnedSessions(): Promise<string[]> {
  return (await getKV<string[]>(PINNED_KEY)) ?? [];
}

export async function savePinnedSessions(ids: string[]): Promise<void> {
  await setKV(PINNED_KEY, ids);
}

/* -------------------------------------------------------------- 表情库 */

/**
 * 库里有没有东西。
 *
 * 白纸版靠它区分"新装"和"老用户升级"：新装才是白纸，升级不准动人家数据。
 * 只看会话 / 记忆 / 表情三类——别的都从这三样长出来。
 */
export async function hasLocalData(): Promise<boolean> {
  const [sessions, memories, stickers] = await Promise.all([
    tx<number>(STORE_SESSIONS, "readonly", (s) => s.count()),
    tx<number>(STORE_MEMORIES, "readonly", (s) => s.count()),
    tx<number>(STORE_STICKERS, "readonly", (s) => s.count()),
  ]);
  return sessions > 0 || memories > 0 || stickers > 0;
}

/** 清空全部本地数据。纯净版第一次启动时用——它要"什么都不带"。 */
export async function clearAll(): Promise<void> {
  for (const store of [STORE_SESSIONS, STORE_MEMORIES, STORE_KV, STORE_STICKERS, STORE_COIN, STORE_BROADCAST]) {
    await tx(store, "readwrite", (s) => s.clear());
  }
}

export async function listStickers(): Promise<StickerRecord[]> {
  const all = (await tx<StickerRecord[]>(STORE_STICKERS, "readonly", (s) => s.getAll() as IDBRequest<StickerRecord[]>)) ?? [];
  return all
    .map((s) => (s.owner ? s : { ...s, owner: "herta" as StickerOwner }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function putSticker(record: StickerRecord): Promise<void> {
  await tx(STORE_STICKERS, "readwrite", (s) => s.put(record));
}

export async function deleteSticker(id: string): Promise<void> {
  await tx(STORE_STICKERS, "readwrite", (s) => s.delete(id));
}

/* ---------------------------------------------------------- 工具调用记录 */

/** 一次工具调用或一条文件库事件。只留最近两百条——这是给人看的审计记录，不是数据库。 */
export interface ToolLogEntry {
  at: string;
  sessionId: string;
  name: string;
  label: string;
  ok: boolean;
  /** 参数压成一行 JSON（可能很长，UI 自己折）。 */
  args: string;
  content: string;
}

const TOOL_LOG_KEY = "toolLog";
const TOOL_LOG_MAX = 200;

export async function appendToolLog(entry: ToolLogEntry): Promise<void> {
  const cur = (await getKV<ToolLogEntry[]>(TOOL_LOG_KEY)) ?? [];
  await setKV(TOOL_LOG_KEY, [entry, ...cur].slice(0, TOOL_LOG_MAX));
}

export async function listToolLog(): Promise<ToolLogEntry[]> {
  return (await getKV<ToolLogEntry[]>(TOOL_LOG_KEY)) ?? [];
}

export async function clearToolLog(): Promise<void> {
  await setKV(TOOL_LOG_KEY, []);
}

/* -------------------------------------------------------------- 零散状态 */

export async function getKV<T>(key: string): Promise<T | null> {
  const got = await tx<{ key: string; value: T } | undefined>(
    STORE_KV,
    "readonly",
    (s) => s.get(key) as IDBRequest<{ key: string; value: T } | undefined>
  );
  return got?.value ?? null;
}

export async function setKV<T>(key: string, value: T): Promise<void> {
  await tx(STORE_KV, "readwrite", (s) => s.put({ key, value }));
}

const MOOD_KEY = "moodState";

/**
 * 她现在的情绪状态。
 *
 * 隔得太久（三小时）就不算"现在的"了——情绪会自己落回去，下一轮重新起算，
 * 否则你关机一夜回来，她还端着昨天那点脾气。
 */
export async function loadMoodState(now = Date.now()): Promise<MoodState | null> {
  const got = await getKV<MoodState>(MOOD_KEY);
  if (!got || typeof got.mood !== "string" || !Number.isFinite(got.at)) return null;
  if (now - got.at > MOOD_TTL_MS) return null;
  return got;
}

export async function saveMoodState(state: MoodState): Promise<void> {
  await setKV(MOOD_KEY, state);
}
