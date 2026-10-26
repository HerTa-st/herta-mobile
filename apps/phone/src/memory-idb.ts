/**
 * 记忆库的 IndexedDB 实现。
 *
 * 为什么要单独一个文件：core 里的 `MemoryStore` 是接缝，Node 测试用内存实现，
 * 手机用这个。两边跑同一套 dream 算法——这样"她怎么记住一件事"只有一份代码。
 */

import { EMPTY_STATE, type DreamState, type MemoryRecord, type MemoryStore } from "@herta/core";
import { STORE_KV, STORE_MEMORIES, tx } from "./storage.ts";

const STATE_KEY = "dreamState";

export class IdbMemoryStore implements MemoryStore {
  async list(): Promise<MemoryRecord[]> {
    const all = (await tx<MemoryRecord[]>(STORE_MEMORIES, "readonly", (s) => s.getAll() as IDBRequest<MemoryRecord[]>)) ?? [];
    return all.sort((a, b) => a.name.localeCompare(b.name));
  }

  async write(record: MemoryRecord): Promise<void> {
    await tx(STORE_MEMORIES, "readwrite", (s) => s.put(record));
  }

  async remove(name: string): Promise<void> {
    await tx(STORE_MEMORIES, "readwrite", (s) => s.delete(name));
  }

  async state(): Promise<DreamState> {
    const row = await tx<{ key: string; value: DreamState } | undefined>(
      STORE_KV,
      "readonly",
      (s) => s.get(STATE_KEY) as IDBRequest<{ key: string; value: DreamState } | undefined>
    );
    return row?.value ?? { ...EMPTY_STATE, cursors: {} };
  }

  async saveState(state: DreamState): Promise<void> {
    await tx(STORE_KV, "readwrite", (s) => s.put({ key: STATE_KEY, value: state }));
  }
}
