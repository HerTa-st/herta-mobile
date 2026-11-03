/**
 * 聊天回合 → NMS pending_turns。
 *
 * 钩子里不直接碰 store：这里保证单例打开、写入排队、失败不打扰用户。
 * Web 开发/没有原生存档时静默跳过（useMemory 会在 Web 回退旧库）。
 */
import { Capacitor } from "@capacitor/core";
import { createPendingWriter } from "@herta/nms";
import type { PendingWriter } from "@herta/nms";
import { getNmsStore } from "./controller.ts";

let writer: PendingWriter | null = null;
let writerReady: Promise<PendingWriter | null> | null = null;

async function ready(): Promise<PendingWriter | null> {
  if (!Capacitor.isNativePlatform()) return null;
  if (writer !== null) return writer;
  if (writerReady === null) {
    writerReady = getNmsStore()
      .then((store) => {
        writer = createPendingWriter(store);
        return writer;
      })
      .catch((error: unknown) => {
        console.log("[nms] pending writer 未就绪：" + String(error instanceof Error ? error.message : error));
        return null;
      })
      .finally(() => {
        writerReady = null;
      });
  }
  return writerReady;
}

export interface NmsTurnEnd {
  sessionId: string;
  turn: number;
  userText: string;
  assistantText: string;
  reason: "final" | "refused" | "aborted" | "error";
}

export function recordNmsTurn(input: NmsTurnEnd): void {
  if (input.userText.trim().length === 0 && input.assistantText.trim().length === 0) return;
  void ready().then((active) => {
    if (active === null) return;
    active.enqueue({
      sessionId: input.sessionId,
      turn: input.turn,
      userText: input.userText,
      assistantText: input.assistantText,
      now: Date.now(),
    });
  });
}

/** 仅供测试/退出前：等待队列落库。 */
export async function flushNmsTurns(): Promise<void> {
  const active = await ready();
  if (active !== null) await active.flush();
}
