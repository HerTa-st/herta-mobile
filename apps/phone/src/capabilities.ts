/**
 * 手机本身的能力：提醒、日历、状态、分享、打开别的东西。
 *
 * 这一层只管"调得动调不动"，不管"该不该"——该不该在 devtools 的开关与工具描述里。
 * 每个函数失败时都抛一句能念给人听的中文：她看不到控制台。
 *
 * 浏览器里（npm run dev）这些插件不可用，一律明说"只在手机上生效"，
 * 不要假装成功——假成功会在真机上变成"她说了但什么都没发生"。
 */

import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Calendar } from "@capacitor/calendar";
import { Device } from "@capacitor/device";
import { Network } from "@capacitor/network";
import { AppLauncher } from "@capacitor/app-launcher";
import { Share } from "@capacitor/share";
import { getKV, setKV } from "./storage.ts";

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

function needNative(what: string): void {
  if (!isNative()) throw new Error(what + "只在手机上生效（浏览器里没有系统通知/日历）。");
}

/* ------------------------------------------------------------------ 提醒 */

export interface ReminderRecord {
  /** 通知 id（Android 要求 int32）。 */
  id: number;
  /** 标题：她的一句话。 */
  title: string;
  /** 正文：事情本身。 */
  text: string;
  /** 一次性的是 ISO 时间；重复的是 "HH:MM"。 */
  when: string;
  repeat: "once" | "daily" | "weekly";
  /** repeat=weekly 时用，1=周一 … 7=周日。 */
  weekday?: number;
}

const REMINDER_KEY = "reminders";

export async function listReminders(): Promise<ReminderRecord[]> {
  return (await getKV<ReminderRecord[]>(REMINDER_KEY)) ?? [];
}

async function saveReminders(list: ReminderRecord[]): Promise<void> {
  await setKV(REMINDER_KEY, list);
}

export async function ensureNotificationPermission(): Promise<void> {
  needNative("到点提醒");
  const state = await LocalNotifications.checkPermissions();
  if (state.display === "granted") return;
  const asked = await LocalNotifications.requestPermissions();
  if (asked.display !== "granted") {
    throw new Error("系统没给通知权限——去设置里打开「通知」，不然到点她喊不出声。");
  }
}

/**
 * 排一条提醒。
 *
 * 一次性用 at；每天用 on.hour/minute；每周再加上 weekday。
 * 重复提醒不写 at——写了会变成"到那一刻之后每天"，而不是"每天这个点"。
 */
export async function scheduleReminder(record: ReminderRecord): Promise<void> {
  await ensureNotificationPermission();
  const schedule =
    record.repeat === "once"
      ? { at: new Date(record.when), allowWhileIdle: true }
      : record.repeat === "daily"
        ? { on: { hour: Number(record.when.slice(0, 2)), minute: Number(record.when.slice(3, 5)) }, repeats: true, allowWhileIdle: true }
        : {
            on: {
              weekday: record.weekday ?? 1,
              hour: Number(record.when.slice(0, 2)),
              minute: Number(record.when.slice(3, 5)),
            },
            repeats: true,
            allowWhileIdle: true,
          };

  await LocalNotifications.schedule({
    notifications: [
      {
        id: record.id,
        title: record.title.slice(0, 60),
        body: record.text.slice(0, 180),
        schedule: schedule as never,
      },
    ],
  });

  const list = await listReminders();
  await saveReminders([...list.filter((r) => r.id !== record.id), record]);
}

export async function cancelReminder(id: number): Promise<void> {
  needNative("取消提醒");
  const list = await listReminders();
  const hit = list.find((r) => r.id === id);
  if (!hit) throw new Error("没有编号 " + id + " 的提醒。");
  await LocalNotifications.cancel({ notifications: [{ id }] });
  await saveReminders(list.filter((r) => r.id !== id));
}

/* ------------------------------------------------------------------ 日历 */

async function ensureCalendar(write: boolean): Promise<void> {
  needNative("日历");
  const state = await Calendar.checkPermissions();
  const ok = write ? state.writeCalendar === "granted" : state.readCalendar === "granted";
  if (ok) return;
  const asked = await Calendar.requestPermissions({
    permissions: write ? ["writeCalendar", "readCalendar"] : ["readCalendar"],
  });
  const granted = write ? asked.writeCalendar === "granted" : asked.readCalendar === "granted";
  if (!granted) {
    throw new Error("系统没给日历权限——去设置里允许，不然她看不到也写不进去。");
  }
}

export interface EventBrief {
  title: string;
  start: number;
  end: number;
  allDay?: boolean;
}

export async function upcomingEvents(days = 7): Promise<EventBrief[]> {
  await ensureCalendar(false);
  const now = Date.now();
  const until = now + Math.max(1, days) * 24 * 60 * 60 * 1000;
  const res = await Calendar.findEvents({ startDate: now, endDate: until });
  const events = (res as { events?: { title?: string; startDate?: number; endDate?: number; isAllDay?: boolean }[] }).events ?? [];
  return events
    .filter((e) => typeof e.startDate === "number")
    .map((e) => ({
      title: e.title ?? "（无标题）",
      start: e.startDate as number,
      end: (e.endDate as number) ?? ((e.startDate as number) + 3600_000),
      allDay: e.isAllDay,
    }))
    .sort((a, b) => a.start - b.start)
    .slice(0, 20);
}

export async function addEvent(e: { title: string; start: number; end: number; notes?: string }): Promise<void> {
  await ensureCalendar(true);
  await Calendar.createEvent({
    title: e.title,
    startDate: e.start,
    endDate: e.end,
    ...(e.notes ? { notes: e.notes } : {}),
  });
}

/* ------------------------------------------------------------------ 状态 */

export interface PhoneStatus {
  batteryLevel?: number;
  charging?: boolean;
  online?: boolean;
  networkType?: string;
  /** 本 App 占用与配额（不是整块磁盘的空闲——那要原生 StatFs）。 */
  storageUsed?: number;
  storageQuota?: number;
}

export async function phoneStatus(): Promise<PhoneStatus> {
  const out: PhoneStatus = {};
  try {
    const b = await Device.getBatteryInfo();
    if (typeof b.batteryLevel === "number") out.batteryLevel = Math.round(b.batteryLevel * 100);
    if (typeof b.isCharging === "boolean") out.charging = b.isCharging;
  } catch {
    /* 读不到就当没有 */
  }
  try {
    const n = await Network.getStatus();
    out.online = n.connected;
    out.networkType = n.connectionType;
  } catch {
    /* 同上 */
  }
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) {
      out.storageUsed = est.usage;
      out.storageQuota = est.quota;
    }
  } catch {
    /* 同上 */
  }
  return out;
}

/* ------------------------------------------------------------ 打开 / 分享 */

export async function openLink(url: string): Promise<void> {
  const ok = /^(https?:|mailto:|tel:|[a-z][a-z0-9+.-]*:)/i.test(url);
  if (!ok) throw new Error("这不像一个链接或 scheme：" + url.slice(0, 60));
  const res = await AppLauncher.openUrl({ url });
  if (res && res.completed === false) throw new Error("手机上没有能打开它的应用。");
}

export async function shareOut(input: { title?: string; text?: string; url?: string }): Promise<void> {
  await Share.share({
    ...(input.title ? { title: input.title } : {}),
    ...(input.text ? { text: input.text } : {}),
    ...(input.url ? { url: input.url } : {}),
    dialogTitle: "发到哪儿",
  });
}

/** 人类可读的字节数。 */
export function formatBytes(n: number | undefined): string {
  if (!n || n <= 0) return "不知道";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return v.toFixed(v >= 100 ? 0 : 1) + " " + units[i];
}
