import { useEffect, useMemo, useRef } from "react";
import type { Session } from "@herta/protocol";
import type { DreamState, MemoryRecord } from "@herta/core";
import { appendPingLog, decidePresencePing, fillPingReplies, initiativeLimits, interactionFromLog, presenceKey } from "@herta/core";
import { pickTransport } from "../transport.ts";
import { acquireKeepAlive } from "../nms/keepalive-lease.ts";
import {
  PING_MAX_GAP_MS,
  bumpPingCount,
  clearNextPing,
  inQuietHours,
  pickNextPing,
  pushPingNotification,
  readLastPingAt,
  readNextPing,
  readPingCount,
  readPingLog,
  readPresenceSeen,
  readVolatileMoods,
  withPing,
  writeLastPingAt,
  writeNextPing,
  writePing,
  writePingLog,
  writePresenceSeen,
} from "../proactive.ts";
import type { Settings } from "../settings.ts";

/**
 * 她到点自己找你。
 *
 * 三件事必须分开看：
 *   1. 保活 —— 常驻前台服务让进程活着（关掉开关就停服务，通知栏那条也跟着消失）；
 *   2. 计时 —— 每分钟看一眼到点没有。JS 定时器在后台会被节流到一分钟一次，
 *      这正好够用：我们本来就只要求"这一分钟里发出去"；
 *   3. 说话 —— 走一遍人格装配，落进会话，再推一条通知。
 *
 * 不在聊天页也要能用：所以这里不碰 session 的 UI 状态，只通过 setSession/persist
 * 把这一句接上去。正在打字/正在回复时不插话——她不该在你打字的中间突然说话。
 */
export function useProactive(opts: {
  settings: Settings;
  session: Session | null;
  setSession(next: Session): void;
  persist(session: Session): Promise<void>;
  memories: MemoryRecord[];
  dreamState: DreamState | null;
  mood: string | null;
  busy: boolean;
  onError(message: string | null): void;
  /** 「主动程度」旋钮 0–100；不传按 40（一天两三次、隔 4~5 小时）。 */
  initiative?: number;
  /** 开口前按话题召回一篇记忆；返回空就回落「最近一篇」。失败不挡这一条。 */
  seedProvider?: (() => Promise<string | null>) | null;
  /** 会让她当场变脸的心情档：主动开口时不带，避免没人惹她也先甩脸色。 */
  volatileMoods?: readonly string[];
}) {
  const transport = useMemo(() => pickTransport(), []);
  const firing = useRef(false);
  // 回调里要拿到最新值，但不该因为 session 变了就重排计时器
  const live = useRef(opts);
  live.current = opts;

  const enabled = opts.settings.proactiveEnabled && !opts.settings.cheapMode;

  useEffect(() => {
    if (!enabled) return;
    const release = acquireKeepAlive("proactive");
    return release;
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !opts.settings.apiKey) return;

    const tick = async () => {
      const p = live.current;
      if (firing.current || p.busy || !p.session) return;
      const now = new Date();

      // 她刚把播报递过去、他还没开口：那条提示不是一句「话」，她也别自己
      // 接自己的茬（2026-11-02 真机上她把它当成开拓者发的消息回了）。
      const last = p.session.blocks[p.session.blocks.length - 1];
      if (last && last.kind === "herta" && last.action?.kind === "broadcast") return;

      // 先补档案：发出去的那一刻还不认识他的回复，等会话里出现 user 块才补得上。
      let pingLog = await readPingLog();
      const filled = fillPingReplies(pingLog, p.session.blocks, now.getTime());
      if (filled.changed) {
        pingLog = filled.log;
        try {
          await writePingLog(pingLog);
        } catch {
          /* 补记失败不该挡住这一轮开口 */
        }
      }
      // 节奏按旋钮和最近互动算：今天还能主动几次、两次之间至少隔多久。

      const limits = initiativeLimits(p.initiative ?? 40, interactionFromLog(pingLog, now.getTime()));
      const gap = { minGapMs: limits.minGapMs, maxGapMs: Math.max(PING_MAX_GAP_MS, limits.minGapMs) };

      // 撞上睡觉时段：她自己排的时间往后推；行踪这一段直接作废，不补发——
      // 半夜弹一条「我想起你了」很吓人。
      if (inQuietHours(now)) {
        const due = await readNextPing();
        if (due !== null && now.getTime() >= due) await writeNextPing(pickNextPing(now, Math.random, gap));
        return;
      }

      const countToday = await readPingCount(now);
      let fire = false;

      // 一、她自己排的时间到了（plan_ping：她说「晚点再找你」）
      const due = await readNextPing();
      if (due !== null && now.getTime() >= due) {
        if (countToday >= limits.maxPerDay) {
          await clearNextPing(); // 配额用完，别留一颗哑弹到明天
        } else {
          fire = true;
        }
      }

      // 二、她的行踪换了一段（换地方 / 换时段）——要不要开口交给纯判断
      if (!fire) {
        const decision = decidePresencePing({
          now,
          seenKey: await readPresenceSeen(),
          countToday,
          lastPingAt: await readLastPingAt(),
          maxPerDay: limits.maxPerDay,
          minGapMs: limits.minGapMs,
        });
        if (decision.markSeen) await writePresenceSeen(presenceKey(now));
        if (!decision.fire) return;
        fire = true;
      }

      firing.current = true;
      try {
        // 按话题召回一篇记忆再开口（她这次接得上上次的事）；召回失败不挡发。
        let seed: string | null = null;
        if (p.seedProvider) {
          try {
            seed = (await p.seedProvider()) ?? null;
          } catch {
            seed = null;
          }
        }
        // 负面心情档（被烦 / 被戳穿 / 被顶嘴）不带进主动消息；调用方没给就现读素材。
        const volatileMoods = p.volatileMoods ?? (await readVolatileMoods());
        const speech = await writePing({
          transport,
          apiKey: p.settings.apiKey,
          baseUrl: p.settings.baseUrl,
          model: p.settings.model,
          memories: p.memories,
          dreamState: p.dreamState,
          mood: p.mood,
          blocks: p.session.blocks,
          deep: p.settings.proactiveDeepMemory,
          userName: p.settings.userName,
          volatileMoods,
          pingLog,
          seed,
        });
        if (speech) {
          await pushPingNotification(speech);
          const next = withPing(p.session, speech);
          p.setSession(next);
          await p.persist(next);
          await bumpPingCount(now);
          await writeLastPingAt(new Date());
          await writePresenceSeen(presenceKey(now));
          await clearNextPing();
          // 记账：下次开口前先看看这条，别每次都像第一次想起他。
          try {
            await writePingLog(appendPingLog(pingLog, { at: now.toISOString(), text: speech, replyDelayMs: null }));
          } catch {
            /* 档案写不进去，不该把这一条已发出的消息算成失败 */
          }
        }
      } catch (e) {
        // 一次没写成不算故障；别把开关关掉，别把配额记成已用
        live.current.onError("她想找你但没说成：" + (e instanceof Error ? e.message : String(e)));
      } finally {
        firing.current = false;
      }
    };

    const timer = window.setInterval(() => void tick(), 60_000);
    void tick();
    return () => window.clearInterval(timer);
  }, [enabled, opts.settings.apiKey, transport]);
}
