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
