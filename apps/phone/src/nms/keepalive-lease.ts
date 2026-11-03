/**
 * HertaKeeperService 的引用计数租约。
 *
 * 原生插件只有 start/stop、没有状态查询；两个消费者（proactive、NMS 深睡）
 * 各自直接 start/stop 会互相踩。这里放一个 JS 单例：
 *   · 第一个 acquire 才真正 start；
 *   · 每个 reason 只记一次；重复 acquire 不会重复加引用；
 *   · 最后一个 release 才真正 stop。
 */
import { startKeepAlive, stopKeepAlive } from "../keepalive.ts";

const holders = new Set<string>();
let started = false;
let startPromise: Promise<boolean> | null = null;

/** 持有服务；返回释放函数（幂等）。 */
export function acquireKeepAlive(reason: string): () => void {
  holders.add(reason);
  if (!started) {
    started = true;
    startPromise = startKeepAlive().finally(() => {
      startPromise = null;
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseKeepAlive(reason);
  };
}

/** 释放某个 reason。 */
export function releaseKeepAlive(reason: string): void {
  holders.delete(reason);
  if (holders.size === 0 && started) {
    started = false;
    void startPromise?.finally(() => stopKeepAlive());
  }
}

/** 仅供 UI/测试：当前租约数。 */
export function keepAliveLeaseCount(): number {
  return holders.size;
}

/** 仅供测试：复位计数（不会 stop 服务）。 */
export function resetKeepAliveLeasesForTest(): void {
  holders.clear();
  started = false;
  startPromise = null;
}
