/**
 * 常驻服务开关。
 *
 * 只在真机上有效；浏览器里什么都不做（那里没有"后台"这回事）。
 * 起不来也不报错到界面上——多半是通知权限被关了，那是用户的选择，不是故障。
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

interface KeepAlivePlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 打开本应用的系统详情页（电池优化白名单在那儿三层深）。 */
  openSystemSettings(): Promise<void>;
}

const HertaKeepAlive = registerPlugin<KeepAlivePlugin>("HertaKeepAlive");

export async function startKeepAlive(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    await HertaKeepAlive.start();
    return true;
  } catch {
    return false;
  }
}

export async function openAppSettings(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    await HertaKeepAlive.openSystemSettings();
    return true;
  } catch {
    return false;
  }
}

export async function stopKeepAlive(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await HertaKeepAlive.stop();
  } catch {
    /* 已经停了 */
  }
}
