/**
 * 「她能读的文件」落盘。
 *
 * filesRef 以前是内存 Map——App 一重启就没了；可聊天里那条「「x」已放进她能读的文件里」
 * 的提示是写进会话的，重启后她还记得文件在，read_file 却报没有。两边要么都不留，
 * 要么文件也留下来。选后者：用户给她的文件，本机留一份才像"记得"。
 *
 * 只存文本（二进制在选文件时就被拒了），整库上限由 core 的 trimTextFiles 兜底：
 * 超了丢最早的那份，避免用户连塞十几本小说把 IndexedDB 撑爆。丢的时候要报出来——
 * 文件静默消失和提示块还在是一对老矛盾，这一层得把"丢了谁"交给调用方。
 */
import { mergeTextFile, READABLE_FILES_MAX_CHARS, trimTextFiles } from "@herta/core";
import { getKV, setKV } from "./storage.ts";

// v1：以前没有这个键；以后格式变了就换 v2，别让旧数据把解析带崩
const KEY = "readableFiles.v1";

export interface ReadableFileRecord {
  name: string;
  text: string;
  at: string;
}

export interface SavedReadableFiles {
  /** 落盘后的全量（已裁剪）。 */
  kept: ReadableFileRecord[];
  /** 这一次因为超上限被挤掉的名字。 */
  dropped: string[];
}

function isRecord(v: unknown): v is ReadableFileRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<ReadableFileRecord>;
  return typeof r.name === "string" && typeof r.text === "string" && typeof r.at === "string";
}

/** 读回全部；坏了就丢那一条，不全丢——一条烂记录不该让她所有文件消失。 */
export async function loadReadableFiles(): Promise<ReadableFileRecord[]> {
  const list = await getKV<ReadableFileRecord[]>(KEY);
  if (!Array.isArray(list)) return [];
  // 旧数据 / 手改数据库可能超过上限：读回时也裁一次，别把启动撑爆
  return trimTextFiles(list.filter(isRecord), READABLE_FILES_MAX_CHARS);
}

/**
 * 保存是串行的：读-改-写不是原子的，两次快速加文件可能互相覆盖。
 * 用一条 Promise 链排队，单进程内不会交叉。
 */
let chain: Promise<unknown> = Promise.resolve();

/** 加一份（同名覆盖），返回落盘后的全量与这次被挤掉的名字。 */
export function saveReadableFile(record: ReadableFileRecord): Promise<SavedReadableFiles> {
  const run = chain.then(async (): Promise<SavedReadableFiles> => {
    const list = await loadReadableFiles();
    // 去重 + 裁剪 + 算 dropped 的纯逻辑在 core（那边有单测）；这里只管 IO 与串行
    const merged = mergeTextFile(list, record, READABLE_FILES_MAX_CHARS);
    await setKV(KEY, merged.kept);
    return merged;
  });
  // 链上只关心"轮到下一次"，本次失败要让调用方看到
  chain = run.catch(() => undefined);
  return run;
}
