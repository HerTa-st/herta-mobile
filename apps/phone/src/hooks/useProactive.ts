import { useEffect, useMemo, useRef } from "react";
import type { Session } from "@herta/protocol";
import type { DreamState, MemoryRecord } from "@herta/core";
import { PRESENCE_PING_MAX_PER_DAY, decidePresencePing, presenceKey } from "@herta/core";
import { pickTransport } from "../transport.ts";
import { acquireKeepAlive } from "../nms/keepalive-lease.ts";
import {
  bumpPingCount,
  clearNextPing,
  inQuietHours,
  pickNextPing,
  pushPingNotification,
  readLastPingAt,
  readNextPing,
  readPingCount,
  readPresenceSeen,
  withPing,
  writeLastPingAt,
  writeNextPing,
  writePing,
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

      // 撞上睡觉时段：她自己排的时间往后推；行踪这一段直接作废，不补发——
      // 半夜弹一条「我想起你了」很吓人。
      if (inQuietHours(now)) {
        const due = await readNextPing();
        if (due !== null && now.getTime() >= due) await writeNextPing(pickNextPing(now));
        return;
      }

      const countToday = await readPingCount(now);
      let fire = false;

      // 一、她自己排的时间到了（plan_ping：她说「晚点再找你」）
      const due = await readNextPing();
      if (due !== null && now.getTime() >= due) {
        if (countToday >= PRESENCE_PING_MAX_PER_DAY) {
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
        });
        if (decision.markSeen) await writePresenceSeen(presenceKey(now));
        if (!decision.fire) return;
        fire = true;
      }

      firing.current = true;
      try {
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
