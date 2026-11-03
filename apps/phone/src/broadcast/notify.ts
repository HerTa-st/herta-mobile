/**
 * 每天 08:30 的播报提醒（Capacitor LocalNotifications）。
 *
 * 照黑塔币 coin/notify.ts 的写法：重复日排程 + allowWhileIdle；每次开 app 补排一遍
 * （Android 各版本对重复闹钟的后台限制不一样，补排比相信上次排的一定在更可靠）。
 * 和 coin 的区别：时间可配（config.notifyTime），且只有一条。
 */

import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { LocalNotificationSchema } from "@capacitor/local-notifications";
import { loadBroadcastConfig, saveBroadcastConfig } from "./storage.ts";

export type BroadcastPermission = "granted" | "denied" | "prompt" | "unsupported";

export interface BroadcastReminderState {
  permission: BroadcastPermission;
  enabled: boolean;
}

/** 固定通知 id：和 coin 的 730000..730004 错开。 */
const REMINDER_ID = 731000;
const ROUTE = "broadcast";
const TITLE = "黑塔";
const BODY = "今天的星际和平播报到了。";

function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

function normalizePermission(display: string | undefined): BroadcastPermission {
  if (display === "granted") return "granted";
  if (display === "denied") return "denied";
  return "prompt";
}

async function currentPermission(): Promise<BroadcastPermission> {
  if (!isNative()) return "unsupported";
  try {
    const status = await LocalNotifications.checkPermissions();
    return normalizePermission(status.display);
  } catch {
    return "prompt";
  }
}

function parseTime(value: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ""));
  if (!m) return { hour: 8, minute: 30 };
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

async function cancelReminder(): Promise<void> {
  if (!isNative()) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: REMINDER_ID }] });
  } catch {
    /* 取消失败静默 */
  }
}

async function scheduleReminder(config: { notifyTime: string }): Promise<void> {
  if (!isNative()) return;
  const { hour, minute } = parseTime(config.notifyTime);
  const base: LocalNotificationSchema = {
    id: REMINDER_ID,
    title: TITLE,
    body: BODY,
    schedule: { on: { hour, minute }, repeats: true, allowWhileIdle: true },
    extra: { route: ROUTE },
  };
  try {
    await LocalNotifications.schedule({ notifications: [base] });
  } catch {
    // Android 12+ 精确闹钟权限没给时退成非精确：晚几分钟也比不响好
    try {
      await LocalNotifications.schedule({ notifications: [{ ...base, isExactNotification: false }] });
    } catch {
      /* 排程失败静默：下次开 app 的 sync 会再补 */
    }
  }
}

/** 当前权限与开关状态；浏览器恒为 unsupported。 */
export async function broadcastReminderState(): Promise<BroadcastReminderState> {
  const permission = await currentPermission();
  if (permission === "unsupported") return { permission, enabled: false };
  const config = await loadBroadcastConfig();
  return { permission, enabled: config.notify && permission === "granted" };
}

/** 开启：申请权限 → 写配置 → 排程。浏览器只返回状态，不报错。 */
export async function enableBroadcastReminder(): Promise<BroadcastReminderState> {
  if (!isNative()) return { permission: "unsupported", enabled: false };

  let permission = await currentPermission();
  if (permission !== "granted") {
    try {
      permission = normalizePermission((await LocalNotifications.requestPermissions()).display);
    } catch {
      permission = await currentPermission();
    }
  }
  if (permission !== "granted") return { permission, enabled: false };

  const config = await loadBroadcastConfig();
  const saved = await saveBroadcastConfig({ ...config, notify: true });
  await scheduleReminder(saved);
  return { permission, enabled: true };
}

/** 关闭：写配置 + 取消。不报错。 */
export async function disableBroadcastReminder(): Promise<void> {
  const config = await loadBroadcastConfig();
  await saveBroadcastConfig({ ...config, notify: false });
  await cancelReminder();
}

/** 每次开 app / 改时间调一遍：开关开着且权限还在才补排；关着就取消。 */
export async function syncBroadcastReminder(): Promise<void> {
  if (!isNative()) return;
  try {
    const config = await loadBroadcastConfig();
    if (!config.notify) {
      await cancelReminder();
      return;
    }
    const permission = await currentPermission();
    if (permission !== "granted") return;
    await scheduleReminder(config);
  } catch {
    /* 失败静默：下次开 app 再补 */
  }
}

/** 点击通知后的回调：只认 extra.route === "broadcast"。 */
export async function onBroadcastNotificationTap(handler: () => void): Promise<() => void> {
  if (!isNative()) return () => undefined;
  try {
    const listener = await LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
      const route = action?.notification?.extra?.route;
      if (route === ROUTE) handler();
    });
    return () => {
      void listener.remove().catch(() => undefined);
    };
  } catch {
    return () => undefined;
  }
}
