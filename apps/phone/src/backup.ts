/**
 * 换机的两头：打包、拆包。
 *
 * 打包在 JS 里做（数据都在 IndexedDB 里），落盘与分享在原生做（WebView 不能下载文件）。
 * 一份包 = 会话 + 记忆 +（可选）表情 +（可选）设置。**不带 API Key**。
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  buildBackupBundle,
  formatSize,
  parseBackupBundle,
  planRestore,
  type BackupStats,
  type BackupSticker,
} from "@herta/core";
import type { Session } from "@herta/protocol";
import { IdbMemoryStore } from "./memory-idb.ts";
import type { Settings } from "./settings.ts";
import { listSessions, listStickers, loadSession, putSession, putSticker } from "./storage.ts";

interface BackupPlugin {
  share(options: { filename: string; text: string }): Promise<{ bytes: number }>;
  save(options: { filename: string; text: string }): Promise<{ path: string; bytes: number }>;
}

const HertaBackup = registerPlugin<BackupPlugin>("HertaBackup");

const store = new IdbMemoryStore();

/** 文件名带时间：换几台手机、导几次，包里不会互相覆盖。 */
export function backupFilename(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    "herta-backup-" +
    now.getFullYear() +
    p(now.getMonth() + 1) +
    p(now.getDate()) +
    "-" +
    p(now.getHours()) +
    p(now.getMinutes()) +
    ".json"
  );
}

/** 设置里不能带走的东西：Key 是用户的凭据，不是她的家当。 */
function settingsForBackup(s: Settings): Record<string, unknown> {
  const { apiKey: _k, ttsApiKey: _t, ...rest } = s;
  return rest as Record<string, unknown>;
}

export interface LocalBackup {
  json: string;
  filename: string;
  stats: BackupStats;
}

/** 把这台手机上的家底打成一个包。 */
export async function buildLocalBackup(
  settings: Settings,
  opts: { withStickers: boolean; withSettings: boolean }
): Promise<LocalBackup> {
  const metas = await listSessions();
  const loaded = await Promise.all(metas.map((m) => loadSession(m.id)));
  const sessions = loaded.filter((s): s is Session => s !== null);
  const memories = await store.list();
  const stickers: BackupSticker[] = opts.withStickers
    ? (await listStickers()).map((s) => ({
        id: s.id,
        name: s.name,
        tags: s.tags,
        data: s.data,
        mediaType: s.mediaType,
        createdAt: s.createdAt,
        owner: s.owner,
      }))
    : [];

  const { bundle, stats } = buildBackupBundle({
    sessions,
    memories,
    stickers,
    ...(opts.withSettings ? { settings: settingsForBackup(settings) } : {}),
    from: "Herta 手机端",
  });
  return { json: JSON.stringify(bundle), filename: backupFilename(), stats };
}

/** 原生分享面板；浏览器里退化成下载一个文件（dev 时用）。 */
export async function shareBackup(backup: LocalBackup): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    await HertaBackup.share({ filename: backup.filename, text: backup.json });
    return "已经交给系统分享面板了（发到微信、存文件都行）";
  }
  const blob = new Blob([backup.json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = backup.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return "浏览器里下载了 " + backup.filename;
}

/** 存进应用自己的外部目录（文件管理器里能翻到）。 */
export async function saveBackup(backup: LocalBackup): Promise<string> {
  if (!Capacitor.isNativePlatform()) return await shareBackup(backup);
  const res = await HertaBackup.save({ filename: backup.filename, text: backup.json });
  return "存到了：" + res.path + "（" + formatSize(res.bytes) + "）";
}

export interface RestoreOutcome {
  stats: BackupStats;
  from?: string;
  writes: { sessions: number; memories: number; stickers: number };
  skipped: { sessions: number; memories: number; stickers: number };
}

/** 拆包：读完先校验，确认之后再真正写库。 */
export async function readBackup(text: string) {
  return parseBackupBundle(text);
}

export async function restoreLocalBackup(text: string): Promise<RestoreOutcome> {
  const parsed = parseBackupBundle(text);
  if (!parsed.ok) throw new Error(parsed.error);

  const [metas, memories, stickers] = await Promise.all([listSessions(), store.list(), listStickers()]);
  const plan = planRestore(parsed.bundle, {
    sessionIds: new Set(metas.map((m) => m.id)),
    memoryNames: new Set(memories.map((m) => m.name)),
    stickerIds: new Set(stickers.map((s) => s.id)),
  });

  for (const s of plan.sessions) await putSession(s);
  for (const m of plan.memories) await store.write(m);
  for (const k of plan.stickers) {
    await putSticker({
      id: k.id,
      name: k.name,
      tags: k.tags,
      data: k.data,
      mediaType: k.mediaType,
      createdAt: k.createdAt,
      owner: k.owner ?? "herta",
    });
  }

  return {
    stats: parsed.stats,
    ...(parsed.bundle.from ? { from: parsed.bundle.from } : {}),
    writes: { sessions: plan.sessions.length, memories: plan.memories.length, stickers: plan.stickers.length },
    skipped: plan.skipped,
  };
}
