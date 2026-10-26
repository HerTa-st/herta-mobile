/**
 * 会话落盘：IndexedDB。
 *
 * 不用 SQLite 也不用 localStorage：
 * - localStorage 只有几 MB，一条长会话就能撑爆，而且写的是同步的，会卡 UI；
 * - 手机端现在只需要"按 id 存取一份会话"，IndexedDB 的键值store 正好，
 *   等 M2 的 dream 要存记忆库时再往同一个库里加 store。
 *
 * 版本号只增不减。升级时在 onupgradeneeded 里按 oldVersion 补 store。
 */

import type { Session } from "@herta/protocol";

const DB_NAME = "herta";
const DB_VERSION = 1;
const STORE = "sessions";

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: string;
  blocks: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id" });
        s.createIndex("updatedAt", "updatedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("打不开 IndexedDB"));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB 操作失败"));
        t.oncomplete = () => db.close();
      })
  );
}

export async function listSessions(): Promise<SessionMeta[]> {
  const all = await tx<Session[]>("readonly", (s) => s.getAll() as IDBRequest<Session[]>);
  return all
    .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, blocks: s.blocks.length }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function loadSession(id: string): Promise<Session | null> {
  const got = await tx<Session | undefined>("readonly", (s) => s.get(id) as IDBRequest<Session | undefined>);
  return got ?? null;
}

export async function putSession(session: Session): Promise<void> {
  await tx("readwrite", (s) => s.put(session));
}

export async function deleteSession(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}
