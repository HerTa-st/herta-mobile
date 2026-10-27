/**
 * 无障碍：读当前屏幕、按文字点一下。
 *
 * 权限只能用户自己去系统设置里开，而且白名单存在**原生**那边（SharedPreferences）——
 * 服务自己要判断"这个 App 许不许"，判断依据和判断对象必须住在一起。
 * 这里只负责把状态说清楚、把白名单读出来给 UI 看。
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

export interface AppRow {
  pkg: string;
  label: string;
}

interface A11yPlugin {
  status(): Promise<{ enabled: boolean; connected: boolean }>;
  openSettings(): Promise<void>;
  getWhitelist(): Promise<{ packages: string[] }>;
  setWhitelist(options: { packages: string[] }): Promise<void>;
  listApps(): Promise<{ apps: AppRow[] }>;
  snapshot(options: { max: number }): Promise<{ package: string; lines: string[] }>;
  tap(options: { text: string }): Promise<{ note: string }>;
}

const HertaA11y = registerPlugin<A11yPlugin>("HertaA11y");

export async function a11yStatus(): Promise<{ enabled: boolean; connected: boolean }> {
  if (!Capacitor.isNativePlatform()) return { enabled: false, connected: false };
  try {
    return await HertaA11y.status();
  } catch {
    return { enabled: false, connected: false };
  }
}

export async function openA11ySettings(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    await HertaA11y.openSettings();
    return true;
  } catch {
    return false;
  }
}

export async function getWhitelist(): Promise<string[]> {
  if (!Capacitor.isNativePlatform()) return [];
  try {
    return (await HertaA11y.getWhitelist()).packages ?? [];
  } catch {
    return [];
  }
}

export async function setWhitelist(packages: string[]): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await HertaA11y.setWhitelist({ packages });
}

export async function listApps(): Promise<AppRow[]> {
  if (!Capacitor.isNativePlatform()) return [];
  try {
    return (await HertaA11y.listApps()).apps ?? [];
  } catch {
    return [];
  }
}

export async function readScreen(max = 60): Promise<{ pkg: string; lines: string[] }> {
  const res = await HertaA11y.snapshot({ max });
  return { pkg: res.package, lines: res.lines ?? [] };
}

export async function tapText(text: string): Promise<string> {
  const res = await HertaA11y.tap({ text });
  return res.note;
}
