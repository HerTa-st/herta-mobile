import type { ReactNode } from "react";

/**
 * 组件槽位注册表（ADR-0004 L2）。
 *
 * 四块可以整块换掉：消息气泡与消息项 / 左轨+顶栏 / 输入条 / 开屏。
 * 但注册表只接受「随包实现」：source 必须显式写 "bundled"。
 * 主题包只有 CSS，没有 JS 入口；这里也没有 eval / new Function / 动态 import
 * 任何字符串，远端代码没有进来的路。
 *
 * 这一版先留边界：默认走 App 原本的实现，随包实现以后逐版加。
 */

export type SlotName = "message" | "railTopbar" | "composer" | "splash";

export interface SlotProps {
  /** 细分区：message 的 user/herta/sticker，railTopbar 的 rail/topbar。 */
  region?: string;
  /** App 原本的实现。随包实现可以忽略它，整块返回自己的节点。 */
  children?: ReactNode;
}

export interface BundledSlot {
  name: SlotName;
  /** 只能填 "bundled"：这是编译期随包代码的标志，不是远端字符串。 */
  source: "bundled";
  render(props: SlotProps): ReactNode;
}

const registry = new Map<SlotName, BundledSlot>();

export function registerBundledSlot(slot: BundledSlot): void {
  if (slot.source !== "bundled") {
    throw new Error("主题槽位只接受随包实现（source: \"bundled\"）。");
  }
  registry.set(slot.name, Object.freeze({ ...slot }));
}

export function hasBundledSlot(name: SlotName): boolean {
  return registry.has(name);
}

/** 槽位边界：没有随包实现时原样渲染 App 原本的内容。 */
export function Slot({ name, region, children }: { name: SlotName; region?: string; children: ReactNode }) {
  const impl = registry.get(name);
  return <>{impl ? impl.render({ region, children }) : children}</>;
}
