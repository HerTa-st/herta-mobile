import { useEffect, useMemo, useRef } from "react";
import type { Session } from "@herta/protocol";
import type { DreamState, MemoryRecord } from "@herta/core";
import { pickTransport } from "../transport.ts";
import { startKeepAlive, stopKeepAlive } from "../keepalive.ts";
import {
  inQuietHours,
  pickNextPing,
  pushPingNotification,
  readNextPing,
  withPing,
  writeNextPing,
  writePing,
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
    if (!enabled) {
      void stopKeepAlive();
      return;
    }
    void startKeepAlive();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !opts.settings.apiKey) return;

    const tick = async () => {
      const p = live.current;
      if (firing.current || p.busy || !p.session) return;
      try {
        const due = await readNextPing();
        if (due === null) {
          await writeNextPing(pickNextPing());
          return;
        }
        if (Date.now() < due) return;
        // 到点了，但撞上睡觉时段：往后推，不补发——半夜弹一条「我想起你了」很吓人
        if (inQuietHours()) {
          await writeNextPing(pickNextPing());
          return;
        }
        firing.current = true;
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
        });
        if (speech) {
          await pushPingNotification(speech);
          const next = withPing(p.session, speech);
          p.setSession(next);
          await p.persist(next);
        }
      } catch (e) {
        // 一次没写成不算故障；下一条照排，别把开关关掉
        live.current.onError("她想找你但没说成：" + (e instanceof Error ? e.message : String(e)));
      } finally {
        firing.current = false;
        await writeNextPing(pickNextPing());
      }
    };

    const timer = window.setInterval(() => void tick(), 60_000);
    void tick();
    return () => window.clearInterval(timer);
  }, [enabled, opts.settings.apiKey, transport]);
}
