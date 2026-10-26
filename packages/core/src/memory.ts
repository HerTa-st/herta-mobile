/**
 * 记忆库：她"想起来"的那些废案，以及做梦进度。
 *
 * 桌面版把它们放成 `.herta/narrative/### 废案_NN：标题.txt`；手机上没有 fs，
 * 但**文件名本身就是格式的一部分**（编号决定淘汰顺序），所以这里保留同一个形状，
 * 只是存进 IndexedDB。
 *
 * 这一层只声明接口，不关心存哪：Node 测试用内存实现，手机用 IndexedDB 实现。
 */

export interface MemoryRecord {
  /** 文件名，形如 `### 废案_07：标题.txt`。编号是她自己的记忆序号。 */
  name: string;
  body: string;
  createdAt: string;
  /** 造出它的会话；自带种子没有来源。 */
  sessionId?: string;
  /** 情境标签，供"别写重复的"那道门用。 */
  tag?: string;
}

export interface DreamState {
  lastPassAt: number | null;
  /** 她自己写的语气笔记（会随记忆积累被重写）。 */
  voice: { text: string; updatedAt: string; basis: number } | null;
  /** 会话 id → 已经消化到第几块。增量就靠它。 */
  cursors: Record<string, number>;
  /** 自己造出来的记忆数（不含种子）。 */
  made: number;
  /** 被判定"不值得记"的次数，只给 UI 看。 */
  skipped: number;
  /** 最近一次的结论，写成一句话给 UI。 */
  lastNote: string | null;
}

export const EMPTY_STATE: DreamState = {
  lastPassAt: null,
  voice: null,
  cursors: {},
  made: 0,
  skipped: 0,
  lastNote: null,
};

export interface MemoryStore {
  list(): Promise<MemoryRecord[]>;
  write(record: MemoryRecord): Promise<void>;
  remove(name: string): Promise<void>;
  state(): Promise<DreamState>;
  saveState(state: DreamState): Promise<void>;
}

/** 从正文首行取标题：`### 废案_07：标题` → `标题`。取不到就退回文件名。 */
export function memoryTitle(record: MemoryRecord): string {
  const first = record.body.split("\n").find((l) => l.trim().length > 0) ?? "";
  const m = first.match(/^###\s*废案(?:_(\d+))?[：:]\s*(.+)$/);
  if (m && m[2].trim()) return m[2].trim();
  return record.name.replace(/^###\s*/, "").replace(/\.txt$/, "");
}

/** 编号：种子 00–09，她自己造的从 10 起。淘汰时按编号从大到小。 */
export function memoryIndex(name: string): number | null {
  const m = name.match(/废案_(\d+)/);
  return m ? Number.parseInt(m[1], 10) : null;
}

/** 下一个可用编号：比她现有最大的还大一号。 */
export function nextMemoryIndex(records: readonly MemoryRecord[]): number {
  let max = 9;
  for (const r of records) {
    const n = memoryIndex(r.name);
    if (n !== null && n > max) max = n;
  }
  return max + 1;
}

export function memoryFileName(index: number, title: string): string {
  const safe = title.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) || "无题";
  return `### 废案_${String(index).padStart(2, "0")}：${safe}.txt`;
}

/** 测试与无持久化环境用的内存实现。 */
export class MemoryInMemory implements MemoryStore {
  private records = new Map<string, MemoryRecord>();
  private current: DreamState = { ...EMPTY_STATE, cursors: {} };

  constructor(seed: readonly MemoryRecord[] = []) {
    for (const r of seed) this.records.set(r.name, r);
  }

  async list(): Promise<MemoryRecord[]> {
    return [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async write(record: MemoryRecord): Promise<void> {
    this.records.set(record.name, record);
  }

  async remove(name: string): Promise<void> {
    this.records.delete(name);
  }

  async state(): Promise<DreamState> {
    return { ...this.current, cursors: { ...this.current.cursors } };
  }

  async saveState(state: DreamState): Promise<void> {
    this.current = { ...state, cursors: { ...state.cursors } };
  }
}

/** 从会话状态里取语气笔记，取不到就是空。 */
export function voiceTextOf(state: DreamState | null): string | null {
  const t = state?.voice?.text;
  return t && t.trim() ? t.trim() : null;
}
