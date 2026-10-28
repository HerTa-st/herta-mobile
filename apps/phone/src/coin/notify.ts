/**
 * 开盘提醒：周一~周五 09:30 各一条本地通知（Capacitor LocalNotifications）。
 *
 * 口径（契约 §4 / 设计决策 13）：
 *   - 每个工作日一条 `schedule.on = { weekday, hour: 9, minute: 30 }` + `repeats: true` + `allowWhileIdle: true`；
 *   - 通知 id 固定 730000..730004，extra `{ route: "coin" }`，点击后由 App 打开黑塔币页；
 *   - 开关状态存 `localStorage["herta.coin.reminder"]`；
 *   - 浏览器环境一律 `unsupported`，不报错（enable 只返回状态）。
 *
 * 排程会随每次开 app 由 `syncCoinReminder()` 补一遍：Android 各版本对重复闹钟的后台限制不一样，
 * 补排比相信「上次排的一定还在」可靠。失败一律静默——通知没排上不该影响任何主流程。
 */

import { Capacitor } from "@capacitor/core";
import { LocalNotifications, Weekday } from "@capacitor/local-notifications";
import type { LocalNotificationSchema } from "@capacitor/local-notifications";
import { rewardForStreak } from "@herta/coin";
import { loadCoinWallet } from "./coin-storage.ts";

export type CoinReminderPermission = "granted" | "denied" | "prompt" | "unsupported";

export interface CoinReminderState {
  permission: CoinReminderPermission;
  enabled: boolean;
}

/** 开关状态的本地持久化键。 */
const REMINDER_KEY = "herta.coin.reminder";

const REMINDER_TITLE = "黑塔币 · 开盘";

/** 周一~周五，与 REMINDER_IDS 一一对应。 */
const REMINDER_WEEKDAYS = [Weekday.Monday, Weekday.Tuesday, Weekday.Wednesday, Weekday.Thursday, Weekday.Friday];

/** 固定的 5 个通知 id（契约 §4）。 */
const REMINDER_IDS = [730000, 730001, 730002, 730003, 730004];

/** 通知 id 列表（测试/排查用；外部不要改）。 */
export function coinNotificationIds(): number[] {
  return [...REMINDER_IDS];
}

function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

function storedEnabled(): boolean {
  try {
    return localStorage.getItem(REMINDER_KEY) === "1";
  } catch {
    return false;
  }
}

function setStoredEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(REMINDER_KEY, "1");
    else localStorage.removeItem(REMINDER_KEY);
  } catch {
    /* 隐私模式 / 存储被禁：开关状态丢了也不影响排程 */
  }
}

function normalizePermission(display: string | undefined): CoinReminderPermission {
  if (display === "granted") return "granted";
  if (display === "denied") return "denied";
  return "prompt";
}

async function currentPermission(): Promise<CoinReminderPermission> {
  if (!isNative()) return "unsupported";
  try {
    const status = await LocalNotifications.checkPermissions();
    return normalizePermission(status.display);
  } catch {
    return "prompt";
  }
}

/** 正文里的 +N HTC 取「当前连签的下一档」；没钱包/没签过就按默认 10。 */
async function reminderBody(): Promise<string> {
  let streak = 0;
  try {
    const wallet = await loadCoinWallet();
    if (wallet?.lastSign && Number.isFinite(wallet.lastSign.streak) && wallet.lastSign.streak > 0) {
      streak = Math.floor(wallet.lastSign.streak);
    }
  } catch {
    /* 读不到钱包就用默认值 */
  }
  const reward = rewardForStreak(streak + 1);
  return "开盘了，签到可以拿 +" + reward + " HTC。";
}

function reminderFor(id: number, weekday: Weekday, body: string, exact: boolean): LocalNotificationSchema {
  return {
    id,
    title: REMINDER_TITLE,
    body,
    schedule: {
      on: { weekday, hour: 9, minute: 30 },
      repeats: true,
      allowWhileIdle: true,
    },
    extra: { route: "coin" },
    ...(exact ? {} : { isExactNotification: false }),
  };
}

/**
 * 排 5 条工作日提醒。先取消旧的同名 id，避免重复排程叠出两条。
 * 精确闹钟权限没给时（Android 12+）退成非精确——9:30 的提醒晚几分钟也好过没有。
 */
async function scheduleReminders(): Promise<void> {
  if (!isNative()) return;
  const body = await reminderBody();
  try {
    await LocalNotifications.cancel({ notifications: REMINDER_IDS.map((id) => ({ id })) });
  } catch {
    /* 没有旧的就算了 */
  }
  const notifications = REMINDER_IDS.map((id, i) => reminderFor(id, REMINDER_WEEKDAYS[i], body, true));
  try {
    await LocalNotifications.schedule({ notifications });
  } catch {
    await LocalNotifications.schedule({
      notifications: REMINDER_IDS.map((id, i) => reminderFor(id, REMINDER_WEEKDAYS[i], body, false)),
    });
  }
}

/* ------------------------------------------------------------------ API */

/** 当前权限与开关状态。浏览器环境恒为 `{ permission: "unsupported", enabled: false }`。 */
export async function coinReminderState(): Promise<CoinReminderState> {
  const permission = await currentPermission();
  if (permission === "unsupported") return { permission, enabled: false };
  // 用户在系统设置里收回权限后，不再显示「已开启」
  return { permission, enabled: storedEnabled() && permission === "granted" };
}

/** 开启：申请权限 → 排 5 条 → 记开关。浏览器只返回状态，不报错。 */
export async function enableCoinReminder(): Promise<CoinReminderState> {
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

  setStoredEnabled(true);
  try {
    await scheduleReminders();
  } catch {
    /* 排程失败静默：下次开 app 的 sync 会再补 */
  }
  return { permission: "granted", enabled: true };
}

/** 关闭：删开关 + 取消 5 条已排程。不报错。 */
export async function disableCoinReminder(): Promise<void> {
  setStoredEnabled(false);
  if (!isNative()) return;
  try {
    await LocalNotifications.cancel({ notifications: REMINDER_IDS.map((id) => ({ id })) });
  } catch {
    /* 取消失败静默 */
  }
}

/** 每次开 app 调一遍：开关开着且权限还在才补排；失败静默。 */
export async function syncCoinReminder(): Promise<void> {
  if (!isNative() || !storedEnabled()) return;
  try {
    const permission = await currentPermission();
    if (permission !== "granted") return;
    await scheduleReminders();
  } catch {
    /* 失败静默：下次开 app 再补 */
  }
}

/**
 * 点击通知后的回调。只认 extra.route === "coin" 的那几条。
 * 返回取消监听的函数；浏览器环境直接返回空函数。
 */
export async function onCoinNotificationTap(handler: () => void): Promise<() => void> {
  if (!isNative()) return () => undefined;
  try {
    const listener = await LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
      const route = action?.notification?.extra?.route;
      if (route === "coin") handler();
    });
    return () => {
      void listener.remove().catch(() => undefined);
    };
  } catch {
    return () => undefined;
  }
}
