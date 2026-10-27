/**
 * 落盘：IndexedDB。
 *
 * 三个 store，一个库：
 *   sessions —— 会话（键 id）
 *   memories —— 记忆库（键 name，就是那个 `### 废案_NN：标题.txt` 文件名）
 *   kv       —— 零散状态（做梦进度等）
 *
 * 不用 localStorage：只有几 MB，一条长会话就能撑爆，而且同步写会卡 UI。
 * 版本号只增不减；升级时在 onupgradeneeded 里按 oldVersion 补 store。
 */

import type { Session } from "@herta/protocol";
import { MOOD_TTL_MS, type MoodState } from "@herta/core";

const DB_NAME = "herta";
const DB_VERSION = 3;

export const STORE_SESSIONS = "sessions";
export const STORE_MEMORIES = "memories";
export const STORE_KV = "kv";
export const STORE_STICKERS = "stickers";

export interface StickerRecord {
  id: string;
  name: string;
  /** 粗略标签，她按心情挑的时候用。 */
  tags: string[];
  data: string;
  mediaType: string;
  createdAt: string;
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
  for (const store of [STORE_SESSIONS, STORE_MEMORIES, STORE_KV, STORE_STICKERS]) {
    await tx(store, "readwrite", (s) => s.clear());
  }
}

export async function listStickers(): Promise<StickerRecord[]> {
  const all = (await tx<StickerRecord[]>(STORE_STICKERS, "readonly", (s) => s.getAll() as IDBRequest<StickerRecord[]>)) ?? [];
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function putSticker(record: StickerRecord): Promise<void> {
  await tx(STORE_STICKERS, "readwrite", (s) => s.put(record));
}

export async function deleteSticker(id: string): Promise<void> {
  await tx(STORE_STICKERS, "readwrite", (s) => s.delete(id));
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
