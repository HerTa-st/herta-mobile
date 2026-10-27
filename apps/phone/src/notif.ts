/**
 * 通知栏与媒体会话。
 *
 * 两者共用同一个系统授权（"通知使用权"）。授权只能用户自己去系统设置里开，
 * 所以这里先有 status / openSettings，再有读与控——顺序不能反。
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

export interface NotifRow {
  app: string;
  title: string;
  text: string;
  at: number;
}

interface NotifyPlugin {
  status(): Promise<{ enabled: boolean; connected: boolean }>;
  openSettings(): Promise<void>;
  recent(options: { limit: number }): Promise<{ notifications: NotifRow[] }>;
  nowPlaying(): Promise<{ playing: string }>;
  media(options: { action: "toggle" | "play" | "pause" | "next" | "previous" }): Promise<void>;
}

const HertaNotify = registerPlugin<NotifyPlugin>("HertaNotify");

export function isNativeEnv(): boolean {
  return Capacitor.isNativePlatform();
}

export async function notifyStatus(): Promise<{ enabled: boolean; connected: boolean }> {
  if (!isNativeEnv()) return { enabled: false, connected: false };
  try {
    return await HertaNotify.status();
  } catch {
    return { enabled: false, connected: false };
  }
}

export async function openNotifySettings(): Promise<boolean> {
  if (!isNativeEnv()) return false;
  try {
    await HertaNotify.openSettings();
    return true;
  } catch {
    return false;
  }
}

export async function recentNotifications(limit = 10): Promise<NotifRow[]> {
  const res = await HertaNotify.recent({ limit });
  return res.notifications ?? [];
}

export async function nowPlaying(): Promise<string> {
  const res = await HertaNotify.nowPlaying();
  return res.playing ?? "";
}

export async function mediaControl(action: "toggle" | "play" | "pause" | "next" | "previous"): Promise<void> {
  await HertaNotify.media({ action });
}
