/**
 * Capacitor SQLite 连接获取：处理「原生侧还挂着旧连接」的情况。
 *
 * 为什么单独拎出来：@capacitor-community/sqlite 的 isConnection / retrieveConnection
 * 只查 **JS 侧** 的 _connectionDict。WebView 页面重载后 JS 字典是空的，但原生侧
 * 仍记着同名连接，createConnection 会直接抛
 * "CreateConnection: Connection herta_nms already exists"，
 * 于是记忆初始化失败、UI 掉回旧 IndexedDB 视图（不是数据丢了）。
 *
 * 这里没有可复用的 JS 句柄，只能关掉原生旧连接再建；数据在 SQLite 文件里，不受影响。
 */
import type { SQLiteDBConnection } from "@capacitor-community/sqlite";

/** 只取用到的四个方法；测试可传假实现。 */
export interface SqliteConnectionWrapper {
  isConnection(database: string, readonly: boolean): Promise<{ result?: boolean }>;
  retrieveConnection(database: string, readonly: boolean): Promise<SQLiteDBConnection>;
  createConnection(
    database: string,
    encrypted: boolean,
    mode: string,
    version: number,
    readonly: boolean,
  ): Promise<SQLiteDBConnection>;
  closeConnection(database: string, readonly: boolean): Promise<void>;
}

function alreadyExists(error: unknown): boolean {
  return /already exists/i.test(error instanceof Error ? error.message : String(error));
}

/** 取连接：能复用就复用；原生侧残留同名连接时关掉再建。 */
export async function acquireConnection(
  wrapper: SqliteConnectionWrapper,
  database: string,
  version: number,
): Promise<SQLiteDBConnection> {
  const existing = await wrapper.isConnection(database, false).catch(() => ({ result: false }));
  if (existing.result === true) {
    try {
      return await wrapper.retrieveConnection(database, false);
    } catch {
      // 字典说有、实际取不出来：往下走新建。
    }
  }
  try {
    return await wrapper.createConnection(database, false, "no-encryption", version, false);
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    // 关掉上一次页面留下的原生连接，再建一次。close 失败也继续尝试建。
    await wrapper.closeConnection(database, false).catch(() => {});
    return await wrapper.createConnection(database, false, "no-encryption", version, false);
  }
}
