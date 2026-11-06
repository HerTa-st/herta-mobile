import { ThemeError } from "./errors.ts";
import type { ThemeSkin } from "./skin.ts";

/**
 * 主题包落在自己的 IndexedDB 里（herta-themes），不往现有 herta 库加 store。
 *
 * 原因：现有库版本号只增不减，升版本会碰所有会话数据；主题是独立的一类数据，
 * 单独开库最省事，也不会影响备份包 / 协议 / 会话存储。
 */

const DB_NAME = "herta-themes";
const DB_VERSION = 1;
const STORE = "themes";
const ACTIVE_KEY = "herta.theme.active.v1";

export interface StoredTheme {
  id: string;
  skin: ThemeSkin;
  css: string;
  assets: Record<string, Uint8Array>;
  installedAt: number;
}

export interface InstalledThemeMeta {
  id: string;
  name: string;
  author: string;
  version: string;
  minAppVersion: string;
  description: string;
  installedAt: number;
}

export function metaOf(theme: StoredTheme): InstalledThemeMeta {
  return {
    id: theme.skin.id,
    name: theme.skin.name,
    author: theme.skin.author,
    version: theme.skin.version,
    minAppVersion: theme.skin.minAppVersion,
    description: theme.skin.description,
    installedAt: theme.installedAt,
  };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new ThemeError("storage", "这台手机的本地存储打不开，主题装不上。"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new ThemeError("storage", "主题库打不开（本地存储被禁用或满了）。"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new ThemeError("storage", "主题库读写失败。"));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(new ThemeError("storage", "主题库读写失败。"));
    };
  });
}

export async function listThemes(): Promise<InstalledThemeMeta[]> {
  try {
    const all = (await withStore<StoredTheme[]>("readonly", (store) => store.getAll() as IDBRequest<StoredTheme[]>)) ?? [];
    return all.map(metaOf).sort((a, b) => b.installedAt - a.installedAt);
  } catch {
    return [];
  }
}

export async function loadTheme(id: string): Promise<StoredTheme | null> {
  const got = await withStore<StoredTheme | undefined>("readonly", (store) => store.get(id) as IDBRequest<StoredTheme | undefined>);
  return got ?? null;
}

export async function saveTheme(theme: StoredTheme): Promise<void> {
  await withStore("readwrite", (store) => store.put(theme));
}

export async function deleteTheme(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}

export function loadActiveThemeId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveActiveThemeId(id: string): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* 本地存储满了也不该让切换主题失败；下次启动只是回到内置 */
  }
}
