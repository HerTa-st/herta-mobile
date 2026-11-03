/**
 * 她自己找你：没人叫她，她发一句话过来。
 *
 * 什么时候开口，两条路：
 *   1. 她的行踪换了一段（换地方 / 换时段）——她自己过日子，顺口跟你说一句；
 *   2. 她自己排的时间到了（plan_ping 工具）——她说过「晚点再找你」。
 * 两条共用一份配额：一天最多两次，两次之间至少两小时，二十二点到八点不吵。
 *
 * 说什么：走一遍完整人格装配（行踪 + 语气笔记 + 最近的对话），只带最近八块；
 * 模型没网/报错时回落到一句按行踪拼的本地台词，别让这一条直接没了。
 */

import type { Block, Session } from "@herta/protocol";
import {
  buildPresenceNote,
  buildStaticPrefix,
  parseNarrative,
  presenceAt,
  serializeRecord,
  timePhrase,
  trimForContext,
  voiceTextOf,
  type DreamState,
  type MemoryRecord,
} from "@herta/core";
import { BrowserAssetSource } from "./assets-browser.ts";
import { getKV, setKV } from "./storage.ts";
import { collect } from "./stream.ts";
import type { ChatTransport } from "./transport.ts";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Capacitor } from "@capacitor/core";

const assets = new BrowserAssetSource();

const NEXT_KEY = "nextPing";
/** 一天最多三条：排下一条时至少隔两小时，免得聊完一轮连发三条。 */
export const PING_MIN_GAP_MS = 2 * 3600_000;
export const PING_MAX_GAP_MS = 5 * 3600_000;
/** 安静时段：这两头之间不发。 */
export const QUIET_FROM = 22;
export const QUIET_TO = 8;

export function inQuietHours(now = new Date()): boolean {
  const h = now.getHours();
  return h >= QUIET_FROM || h < QUIET_TO;
}

/** 挑下一个时间点：2~5 小时之后，落在 8:00–22:00 之间。 */
export function pickNextPing(now = new Date(), random = Math.random): Date {
  const gap = PING_MIN_GAP_MS + random() * (PING_MAX_GAP_MS - PING_MIN_GAP_MS);
  const at = new Date(now.getTime() + gap);
  const h = at.getHours();
  if (h >= QUIET_FROM || h < QUIET_TO) {
    // 推到第二天早上八点之后一点点，别正好卡在八点整
    const morning = new Date(at);
    if (h >= QUIET_FROM) morning.setDate(morning.getDate() + 1);
    morning.setHours(QUIET_TO, 15 + Math.floor(random() * 40), 0, 0);
    return morning;
  }
  return at;
}

export async function readNextPing(): Promise<number | null> {
  const v = await getKV<number>(NEXT_KEY);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function writeNextPing(at: Date): Promise<void> {
  await setKV(NEXT_KEY, at.getTime());
}

export async function clearNextPing(): Promise<void> {
  await setKV(NEXT_KEY, null);
}

/* ---------------------------------------------------------------- 行踪配额 */

const SEEN_KEY = "presenceSeen";
const BUDGET_KEY = "pingBudget";
const LAST_PING_KEY = "lastPingAt";

/** 最近一次消费掉的行踪（phase|place）；同一段不重复开口。 */
export async function readPresenceSeen(): Promise<string | null> {
  const v = await getKV<string>(SEEN_KEY);
  return typeof v === "string" ? v : null;
}
export async function writePresenceSeen(key: string): Promise<void> {
  await setKV(SEEN_KEY, key);
}

/** 今天已经主动了几次；跨天自动归零。 */
export async function readPingCount(now = new Date()): Promise<number> {
  const got = await getKV<{ day: string; count: number }>(BUDGET_KEY);
  const today = now.getFullYear() + "-" + (now.getMonth() + 1) + "-" + now.getDate();
  if (!got || got.day !== today) return 0;
  return Number.isFinite(got.count) ? got.count : 0;
}
export async function bumpPingCount(now = new Date()): Promise<void> {
  const today = now.getFullYear() + "-" + (now.getMonth() + 1) + "-" + now.getDate();
  await setKV(BUDGET_KEY, { day: today, count: (await readPingCount(now)) + 1 });
}

export async function readLastPingAt(): Promise<number | null> {
  const v = await getKV<number>(LAST_PING_KEY);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
export async function writeLastPingAt(at: Date): Promise<void> {
  await setKV(LAST_PING_KEY, at.getTime());
}

/** 没有模型时的台词：按她此刻的行踪拼一句，别装成刚想的。 */
export function fallbackPingLine(p = presenceAt()): string {
  return "我在" + p.place + "，" + p.doing + "。想起你了，说一句。";
}

export interface PingDeps {
  transport: ChatTransport;
  apiKey: string;
  baseUrl: string;
  model: string;
  memories: MemoryRecord[];
  dreamState: DreamState | null;
  mood: string | null;
  blocks: readonly Block[];
  /** 深一点：先检索记忆（贵，设置在「她能做什么」里） */
  deep: boolean;
  /** 引导页里填的名字：她主动找你时也这么叫。 */
  userName?: string | null;
}

/**
 * 写那句话。
 *
 * 提示词只给一条旁注：不是他叫你，是你自己想起了他。剩下的交给人格层——
 * 这里多写一句规矩，她的语气就多一分不像她。
 */
export async function writePing(deps: PingDeps): Promise<string> {
  const promptAssets = await assets.promptAssets();
  const voiceText = voiceTextOf(deps.dreamState);
  const recent = trimForContext(deps.blocks, 8);
  // 默认只带一篇（便宜）；开了「翻完整记忆」就带三篇。
  // 这里不按话题检索——没人在跟她说话，没有话题可用，带最近的就对。
  const live = deps.memories.filter((m) => !m.forgotten);
  const seeds = (deps.deep ? live.slice(-3) : live.slice(-1)).map((m) => m.body);

  const presence = presenceAt();
  const prefix = buildStaticPrefix({
    assets: promptAssets,
    seeds,
    voiceText,
    presence: buildPresenceNote(presence, timePhrase()),
    extraNotes: [
      "〔旁注：现在不是他叫你。是你自己想起了他，想发一条消息过去。" +
        "短，一两句；不要问「在吗」，直接说你想到的那件事。" +
        "你手上这一档事刚换到「" + presence.place + "」——真要说自己在干嘛，就从这个新地方、新事情说起，别照抄旁注。〕",
      ...(deps.userName && deps.userName.trim()
        ? ["〔旁注：他叫「" + deps.userName.trim() + "」。称呼他的时候用这个名字。〕"]
        : []),
    ],
  });

  const transcript = serializeRecord(recent, { maxBlocks: 0 });
  try {
    const raw = await collect(
      deps.transport.stream({
        apiKey: deps.apiKey,
        baseUrl: deps.baseUrl,
        model: deps.model,
        messages: [
          { role: "system", content: prefix },
          { role: "user", content: transcript + "\n\n（现在没有新消息。你想说什么就说。）" },
        ],
        maxTokens: 300,
      })
    );
    const speech = parseNarrative(raw).speech || raw.trim();
    // 只留第一句、去掉标签残留：通知栏放不下三段
    const line = speech.replace(/\s+/g, " ").trim().slice(0, 120);
    return line || fallbackPingLine(presence);
  } catch {
    // 没网 / 报错：这一条还是发出去，只是不带模型写的字
    return fallbackPingLine(presence);
  }
}

/** 把这句话推成一条系统通知（她在后台时，你只能这样收到）。 */
export async function pushPingNotification(speech: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: Math.floor(Date.now() % 2_000_000_000),
          title: "黑塔",
          body: speech,
        },
      ],
    });
  } catch {
    /* 通知没发出去也不该让这一轮崩掉 */
  }
}

/** 把这句话落进会话。她自己说的话也是上下文——下次聊天她得记得自己找过你。 */
export function withPing(session: Session, speech: string, at = new Date()): Session {
  return {
    ...session,
    blocks: [...session.blocks, { kind: "herta", surface: "speech", text: speech, at: at.toISOString() }],
    updatedAt: at.toISOString(),
  };
}
