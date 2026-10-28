/**
 * 手机本身的能力：提醒、日历、状态、分享、打开别的东西。
 *
 * 这一层只管"调得动调不动"，不管"该不该"——该不该在 devtools 的开关与工具描述里。
 * 每个函数失败时都抛一句能念给人听的中文：她看不到控制台。
 *
 * 浏览器里（npm run dev）这些插件不可用，一律明说"只在手机上生效"，
 * 不要假装成功——假成功会在真机上变成"她说了但什么都没发生"。
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Calendar } from "@capacitor/calendar";
import { Device } from "@capacitor/device";
import { Network } from "@capacitor/network";
import { AppLauncher } from "@capacitor/app-launcher";
import { Share } from "@capacitor/share";
/** 自己写的定位插件：LocationManager 一次询问，不碰 Play Services（省四兆）。 */
const HertaLocation = registerPlugin<{
  getCurrent(): Promise<{ latitude: number; longitude: number; accuracy?: number }>;
}>("HertaLocation");
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
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
  /** 上一次把这条说进对话的时间。同一次到点只说一次——她不该每次打开 App 都把八点那句话重说一遍。 */
  spokenAt?: string;
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

/**
 * 这条提醒"最近一次该响"是什么时候。
 *
 * 一次性：到点那一刻；每天：今天这个点（还没到就用昨天）；每周：往前找到最近那个星期几。
 * 响过之后的时间点才算"该说"——时间在未来的不算。
 */
export function lastOccurrence(record: ReminderRecord, now: Date = new Date()): Date | null {
  const at = (day: Date, hh: number, mm: number) => {
    const d = new Date(day);
    d.setHours(hh, mm, 0, 0);
    return d;
  };
  if (record.repeat === "once") {
    const when = new Date(record.when);
    return Number.isNaN(when.getTime()) || when > now ? null : when;
  }
  const hh = Number(record.when.slice(0, 2));
  const mm = Number(record.when.slice(3, 5));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;

  if (record.repeat === "daily") {
    const today = at(now, hh, mm);
    if (today <= now) return today;
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return at(yesterday, hh, mm);
  }

  // weekly：1=周一…7=周日，JS 的 getDay 是 0=周日
  const want = record.weekday ?? 1;
  for (let back = 0; back <= 7; back += 1) {
    const day = new Date(now);
    day.setDate(day.getDate() - back);
    const iso = day.getDay() === 0 ? 7 : day.getDay();
    if (iso !== want) continue;
    const occ = at(day, hh, mm);
    if (occ <= now) return occ;
  }
  return null;
}

export interface DueReminder {
  record: ReminderRecord;
  at: Date;
}

/**
 * 已经响过、但还没说进对话的那些。
 *
 * 为什么要有这一步：系统通知只是一条通知，她并没有"说过话"。用户点开 App 看到通知
 * 却看到对话里什么都没有，就是这里漏了补齐。打开 App 时补一次，补完记 spokenAt。
 */
export async function dueReminders(now: Date = new Date()): Promise<DueReminder[]> {
  const list = await listReminders();
  const out: DueReminder[] = [];
  for (const record of list) {
    const at = lastOccurrence(record, now);
    if (!at) continue;
    const spoken = record.spokenAt ? new Date(record.spokenAt) : null;
    if (spoken && spoken >= at) continue;
    out.push({ record, at });
  }
  return out;
}

/** 记下"这条已经说过了"，免得下次打开又说一遍。 */
export async function markReminderSpoken(id: number, at: Date): Promise<void> {
  const list = await listReminders();
  await saveReminders(list.map((r) => (r.id === id ? { ...r, spokenAt: at.toISOString() } : r)));
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

/* ------------------------------------------------------------ 定位 / 相机 */

export interface Fix {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

/**
 * 现在在哪儿。
 *
 * 只给坐标，不做逆地理编码——那要另一个付费接口，而"纬度 31.23, 东经 121.47"
 * 已经够她自己判断（她本来就知道今天在哪个城市）。
 */
export async function whereAmI(): Promise<Fix> {
  needNative("定位");
  const fix = await HertaLocation.getCurrent();
  if (typeof fix?.latitude !== "number" || typeof fix?.longitude !== "number") {
    throw new Error("没定位到。");
  }
  return { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy };
}

/**
 * 拍一张。
 *
 * 两条路都用它：她自己的「打开相机」工具（拍完只拿到一段描述），
 * 以及用户点回形针里的「拍照」发给她（data URL 直接进看图管线）。
 * 插件走 ACTION_IMAGE_CAPTURE 调系统相机，所以 Android 不需要 App 自己申请 CAMERA 权限
 * （插件清单里也没声明它）；以后若改成内嵌取景才要补。
 */
export async function snapPhoto(): Promise<{ data: string; mediaType: string }> {
  needNative("相机");
  const photo = await Camera.getPhoto({
    quality: 80,
    width: 1280,
    resultType: CameraResultType.DataUrl,
    source: CameraSource.Camera,
    saveToGallery: false,
  });
  if (!photo.dataUrl) throw new Error("拍完了但没拿到图。");
  return { data: photo.dataUrl, mediaType: "image/" + (photo.format || "jpeg") };
}

/**
 * 相机失败翻成人话。
 *
 * 取消不是错误——她自己误触和别人点开又退出都很常见，不该弹一行红字。
 * 权限被拒和「没有相机」要分开说，因为用户能做的事不一样。
 */
export function cameraFailureText(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/cancel/i.test(message)) return null;
  // 当前这条分支实际走不到：@capacitor/camera v8 的清单里没有 CAMERA 权限，
  // 它走 ACTION_IMAGE_CAPTURE 调系统相机，根本不会申请权限。留着是防以后换成 CameraX 内嵌取景。
  if (/denied|permission/i.test(message)) {
    return "相机权限没给——去系统设置里允许「相机」，再试一次。";
  }
  if (/no camera|doesn't have a camera|not available/i.test(message)) {
    return "这台设备没有可用的相机。";
  }
  // 别把插件的英文原文直接上屏。原话留给控制台，人看的只有这一句。
  console.warn("相机失败：", err);
  return "相机没能打开，也没说清原因。再试一次；还不行就看看系统里相机是不是被别的应用占着。";
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
