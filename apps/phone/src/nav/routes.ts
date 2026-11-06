/**
 * 整屏页的稳定标识（ADR-0002）。
 *
 * 页面只认 route 名，不认组件、不认布尔量。通知深链、返回栈、主题都读这一张表；
 * 以后加页面只在这里加一行，不在 App.tsx 里再造一个 useState。
 */

export type RouteName =
  | "chat"
  | "coin"
  | "broadcast"
  | "memory"
  | "memoryDetail"
  | "memoryGraph"
  | "settings"
  | "appearance"
  | "theme"
  | "capabilities"
  | "onboarding"
  | "toolLog"
  | "backup"
  | "designSystem"
  | "sponsors"
  | "devs"
  | "issues"
  | "usage"
  | "shot";

export interface RouteDef {
  /** 中文名：调试、无障碍读屏、以后「最近去过」都用它。 */
  label: string;
  /** 是不是整屏页（会压栈）。chat 是底，不算。 */
  fullscreen: boolean;
}

export const ROUTES: Record<RouteName, RouteDef> = {
  chat: { label: "对话", fullscreen: false },
  coin: { label: "黑塔币", fullscreen: true },
  broadcast: { label: "星际和平播报", fullscreen: true },
  memory: { label: "记忆网络", fullscreen: true },
  memoryDetail: { label: "记忆全文", fullscreen: true },
  memoryGraph: { label: "记忆网络全屏", fullscreen: true },
  settings: { label: "设置", fullscreen: true },
  appearance: { label: "外观 · 她的样子", fullscreen: true },
  theme: { label: "主题包", fullscreen: true },
  capabilities: { label: "她能做什么", fullscreen: true },
  onboarding: { label: "首次引导", fullscreen: true },
  toolLog: { label: "工具调用记录", fullscreen: true },
  backup: { label: "备份与迁移", fullscreen: true },
  designSystem: { label: "设计系统", fullscreen: true },
  // B13 关于三页：从设置的「关于」组压栈，返回键退回设置。
  sponsors: { label: "赞助名单", fullscreen: true },
  devs: { label: "开发人员", fullscreen: true },
  issues: { label: "已知问题", fullscreen: true },
  // B14 今日用量：从设置的「连接」组压栈，和用量明细是同一件事（就地）。
  usage: { label: "今日用量", fullscreen: true },
  shot: { label: "看图", fullscreen: true },
};

export function isRouteName(value: string): value is RouteName {
  return Object.prototype.hasOwnProperty.call(ROUTES, value);
}

/** 通知深链只认两个去处：播报提醒 → 播报页，开盘提醒 → 币页。 */
export type NotificationTarget = "broadcast" | "coin";

export function routeFromNotification(target: NotificationTarget): RouteName {
  return target === "broadcast" ? "broadcast" : "coin";
}
