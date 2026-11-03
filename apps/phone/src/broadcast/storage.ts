/**
 * 播报的落盘：一期一条（store broadcast）+ 配置 / 已提示 / 已读（kv）。
 *
 * 不塞进 sessions：播报不是聊天，清历史、备份、搜索都不该把它当会话。
 */

import {
  DEFAULT_BROADCAST_TAGS,
  type BroadcastIssue,
} from "@herta/core";
import { STORE_BROADCAST, STORE_KV, getKV, setKV, tx } from "../storage.ts";

export interface BroadcastConfig {
  /** 关注标签：决定下一次抓什么。 */
  tags: string[];
  /** 每天 08:30 的本地通知开关。 */
  notify: boolean;
  /** 通知时间 HH:mm。 */
  notifyTime: string;
}

export const DEFAULT_BROADCAST_CONFIG: BroadcastConfig = {
  tags: [...DEFAULT_BROADCAST_TAGS],
  notify: true,
  notifyTime: "08:30",
};

const CONFIG_KEY = "broadcastConfig";
const PROMPTED_KEY = "broadcastPrompted";
const READ_KEY = "broadcastReadNo";
/** 今天这期被「清空历史」清掉了：别再自动补做，等明天或手动「来一期」。 */
const CLEARED_KEY = "broadcastCleared";

function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_BROADCAST_TAGS];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const tag = value.trim();
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= 8) break;
  }
  return out.length > 0 ? out : [...DEFAULT_BROADCAST_TAGS];
}

function cleanTime(raw: unknown): string {
  if (typeof raw === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.trim())) return raw.trim();
  return DEFAULT_BROADCAST_CONFIG.notifyTime;
}

function normalizeConfig(raw: unknown): BroadcastConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_BROADCAST_CONFIG, tags: [...DEFAULT_BROADCAST_TAGS] };
  const config = raw as Record<string, unknown>;
  return {
    tags: cleanTags(config.tags),
    notify: config.notify !== false,
    notifyTime: cleanTime(config.notifyTime),
  };
}

export async function loadBroadcastConfig(): Promise<BroadcastConfig> {
  return normalizeConfig(await getKV<unknown>(CONFIG_KEY));
}

export async function saveBroadcastConfig(next: BroadcastConfig): Promise<BroadcastConfig> {
  const clean = normalizeConfig(next);
  await setKV(CONFIG_KEY, clean);
  return clean;
}

function looksLikeIssue(value: unknown): value is BroadcastIssue {
  if (!value || typeof value !== "object") return false;
  const issue = value as Record<string, unknown>;
  return (
    typeof issue.id === "string" &&
    typeof issue.date === "string" &&
    typeof issue.no === "number" &&
    Array.isArray(issue.items)
  );
}

/** 所有期，期号大的在前。坏数据直接跳过，别让一条脏记录把整页弄崩。 */
export async function listBroadcastIssues(): Promise<BroadcastIssue[]> {
  const all = (await tx<BroadcastIssue[]>(STORE_BROADCAST, "readonly", (s) => s.getAll() as IDBRequest<BroadcastIssue[]>)) ?? [];
  return all.filter(looksLikeIssue).sort((a, b) => b.no - a.no);
}

export async function saveBroadcastIssue(issue: BroadcastIssue): Promise<void> {
  await tx(STORE_BROADCAST, "readwrite", (s) => s.put(issue));
  // 新一期落库就把「今天清空过」的标记撤掉
  await setKV(CLEARED_KEY, "");
}

export async function loadBroadcastCleared(): Promise<string> {
  return (await getKV<string>(CLEARED_KEY)) ?? "";
}

export async function markBroadcastCleared(date: string): Promise<void> {
  await setKV(CLEARED_KEY, date);
}

export async function clearBroadcastIssues(): Promise<void> {
  await tx(STORE_BROADCAST, "readwrite", (s) => s.clear());
  await setKV(PROMPTED_KEY, "");
  await setKV(READ_KEY, 0);
  await setKV(CLEARED_KEY, "");
}

export async function promptedIssueId(): Promise<string> {
  return (await getKV<string>(PROMPTED_KEY)) ?? "";
}

export async function markPrompted(issueId: string): Promise<void> {
  await setKV(PROMPTED_KEY, issueId);
}

export async function loadReadNo(): Promise<number> {
  const value = await getKV<number>(READ_KEY);
  return Number.isFinite(value) ? Number(value) : 0;
}

export async function saveReadNo(no: number): Promise<void> {
  await setKV(READ_KEY, Number.isFinite(no) ? Math.floor(no) : 0);
}
