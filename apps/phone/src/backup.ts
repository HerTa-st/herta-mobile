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
  type BackupFile,
  type BackupStats,
  type BackupSticker,
  type RestoreMode,
} from "@herta/core";
import type { Session } from "@herta/protocol";
import { IdbMemoryStore } from "./memory-idb.ts";
import { exportNmsBackup, restoreNmsBackup, type NmsRestoreOutcome } from "./nms/controller.ts";
import { loadReadableFiles, replaceReadableFiles, saveReadableFile } from "./readable-files.ts";
import { loadCoinWallet, saveCoinWallet } from "./coin/coin-storage.ts";
import { exportCoinKeys, importCoinKeys, listCoinKeyNames } from "./coin/userkey.ts";
import { listBroadcastIssues, saveBroadcastIssue } from "./broadcast/storage.ts";
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
  opts: { withStickers: boolean; withSettings: boolean; withFiles?: boolean }
): Promise<LocalBackup> {
  const metas = await listSessions();
  const loaded = await Promise.all(metas.map((m) => loadSession(m.id)));
  const sessions = loaded.filter((s): s is Session => s !== null);
  const memories = await store.list();
  const coin = await loadCoinWallet();
  const broadcast = await listBroadcastIssues();
  const nms = await exportNmsBackup();
  const keys = exportCoinKeys();
  // v3：她能读的文件。不带就是老样子（v1/v2 的包也没有这块）
  const files: BackupFile[] = opts.withFiles
    ? (await loadReadableFiles()).map((file) => ({ name: file.name, text: file.text, at: file.at }))
    : [];
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
    // 黑塔币钱包是单机的，换机就该跟着走；没激活过就不写这块
    ...(coin ? { coin } : {}),
    // 播报期也是单机的家当，换机跟着走
    ...(broadcast.length > 0 ? { broadcast } : {}),
    ...(nms ? { nms } : {}),
    ...(files.length > 0 ? { files } : {}),
    // 用户密钥默认带上：服务端一号一钥，丢了就再也进不去自己的号。
    // 代价是这个包等于账号，界面上必须说清楚。
    ...(Object.keys(keys).length > 0 ? { coinKeys: keys } : {}),
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

/**
 * 恢复完了给的那张报告：写了几条、换了几条、跳过几条，钱包和记忆网络各自怎么样。
 * 数字全部来自 planRestore 与实际写入的返回值，不在这里另算一遍——两处都算迟早对不上。
 */
/**
 * 恢复之前强制先存一份当前状态。
 *
 * 原生平台存进应用自己的外部目录（和「保存备份」同一条通道）；
 * 浏览器（dev）里不落盘——那里没有应用目录，硬下载一个文件反而吓人，界面上会说清楚。
 */
export async function makeSafetyBackup(settings: Settings): Promise<{ where: string; filename: string }> {
  const backup = await buildLocalBackup(settings, { withStickers: true, withSettings: true, withFiles: true });
  const filename = backup.filename.replace("herta-backup-", "herta-safety-");
  if (!Capacitor.isNativePlatform()) {
    return { where: "浏览器里不落盘（真机上会存到应用目录）", filename };
  }
  const res = await HertaBackup.save({ filename, text: backup.json });
  return { where: res.path + "（" + formatSize(res.bytes) + "）", filename };
}

export interface RestoreReport {
  stats: BackupStats;
  from?: string;
  mode: RestoreMode;
  wrote: { sessions: number; memories: number; stickers: number; broadcast: number; files: number };
  overwritten: { sessions: number; memories: number; stickers: number; broadcast: number; files: number };
  skipped: { sessions: number; memories: number; stickers: number; broadcast: number; files: number };
  wallet: "written" | "kept" | "absent";
  /** 写回本机的用户密钥条数（0 = 包里没带或本机已经都有）。 */
  keys: number;
  /** 记忆网络：写没写、为什么没写。 */
  nms: NmsRestoreOutcome | { wrote: false; nodes: 0; edges: 0; reason: "not_in_bundle" };
  /** 包里有没有带文件（区分「一个文件都没带」和「带了 0 个」）。 */
  hasFiles: boolean;
}

/** 拆包：读完先校验，确认之后再真正写库。 */
export async function readBackup(text: string) {
  return parseBackupBundle(text);
}

/**
 * 真正写库。
 *
 * `mode`：合并（默认，本机已有的跳过）/ 覆盖（换机「覆盖本机」，本机已有的换掉）。
 * 覆盖是唯一会弄丢东西的路径，调用方必须先自动备一份当前状态（BackupSheet 的三步流程）。
 */
export async function restoreLocalBackup(text: string, mode: RestoreMode = "merge"): Promise<RestoreReport> {
  const parsed = parseBackupBundle(text);
  if (!parsed.ok) throw new Error(parsed.error);

  const [metas, memories, stickers, issues, localFiles] = await Promise.all([
    listSessions(),
    store.list(),
    listStickers(),
    listBroadcastIssues(),
    loadReadableFiles(),
  ]);
  const existingWallet = await loadCoinWallet();
  const plan = planRestore(
    parsed.bundle,
    {
      sessionIds: new Set(metas.map((m) => m.id)),
      memoryNames: new Set(memories.map((m) => m.name)),
      stickerIds: new Set(stickers.map((s) => s.id)),
      broadcastIds: new Set(issues.map((i) => i.id)),
      wallet: existingWallet !== null,
      fileNames: new Set(localFiles.map((f) => f.name)),
      coinKeyNames: new Set(listCoinKeyNames()),
    },
    mode
  );

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
  for (const issue of plan.broadcast) await saveBroadcastIssue(issue);

  // 文件：包里带了这一块才动本机的文件库。
  // 合并 → 逐份并进去；覆盖 → 整库换成包里那份（本机独有的也换掉，这才叫覆盖）。
  if (parsed.bundle.files !== undefined) {
    if (mode === "overwrite") await replaceReadableFiles(plan.files);
    else for (const file of plan.files) await saveReadableFile({ name: file.name, text: file.text, at: file.at });
  }

  // 钱包只有一个：合并时本机没有才写；覆盖时照包里的换（反正恢复前刚存过一份）。
  const wallet: RestoreReport["wallet"] = plan.coin ? "written" : existingWallet !== null ? "kept" : "absent";
  if (plan.coin) await saveCoinWallet(plan.coin);

  // 用户密钥：不写回去，换机之后照样进不了自己的号
  const keys = importCoinKeys(plan.coinKeys);

  // 记忆网络：v2 起才带快照。没带的包不动它，报告里如实说「包里没有」。
  const nms: RestoreReport["nms"] =
    parsed.bundle.nms !== undefined
      ? await restoreNmsBackup(parsed.bundle.nms, mode)
      : { wrote: false, nodes: 0, edges: 0, reason: "not_in_bundle" };

  return {
    stats: parsed.stats,
    ...(parsed.bundle.from ? { from: parsed.bundle.from } : {}),
    mode,
    wrote: {
      sessions: plan.sessions.length,
      memories: plan.memories.length,
      stickers: plan.stickers.length,
      broadcast: plan.broadcast.length,
      files: plan.files.length,
    },
    overwritten: plan.overwritten,
    skipped: plan.skipped,
    wallet,
    keys,
    nms,
    hasFiles: parsed.bundle.files !== undefined,
  };
}
