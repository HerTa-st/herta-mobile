/**
 * 聊天回合 → pending_turns。
 *
 * turn-stopping 不能阻塞 UI：写入先进入内存队列，异步按序 insert；
 * (session_id, turn) 唯一，重复写幂等。turn 由调用方给（会话内 user 块计数）。
 */
import type { NmsStore } from "./store.ts";

export interface NmsTurnEndInput {
  sessionId: string;
  turn: number | null;
  userText: string;
  assistantText?: string;
  now?: number;
}

export interface PendingWriter {
  enqueue(input: NmsTurnEndInput): void;
  flush(): Promise<void>;
  pending(): number;
}

/**
 * 造一个写入队列。内部串行，失败只记录并继续；调用方可在测试里 await flush。
 */
export function createPendingWriter(store: NmsStore, options: { onError?: (error: unknown) => void } = {}): PendingWriter {
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;
  const report = options.onError ?? ((error: unknown) => console.log("[nms] pending 写入失败：" + String(error instanceof Error ? error.message : error)));

  function enqueue(input: NmsTurnEndInput): void {
    const userText = String(input.userText ?? "").trim();
    const assistantText = String(input.assistantText ?? "").trim();
    if (userText.length === 0 && assistantText.length === 0) return;
    queued += 1;
    tail = tail.then(async () => {
      try {
        await store.insertPendingTurn({
          sessionId: input.sessionId,
          turn: input.turn,
          userText,
          assistantText,
          persona: "herta",
          workspace: null,
          now: input.now,
        });
      } catch (error) {
        report(error);
      } finally {
        queued -= 1;
      }
    });
  }

  return {
    enqueue,
    async flush() {
      await tail;
    },
    pending() {
      return queued;
    },
  };
}

/** 会话内 user 块计数：没有现成 turn 编号时用它。 */
export function countUserTurns(blocks: readonly { role?: string; kind?: string }[]): number {
  let count = 0;
  for (const block of blocks) {
    const role = block.role ?? block.kind;
    if (role === "user") count += 1;
  }
  return count;
}
