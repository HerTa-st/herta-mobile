import type { RouteName } from "./routes.ts";

/** 栈里的一页：名字 + 自己的参数（记忆全文、看图那几片图…）。栈只存，不解释。 */
export interface PageEntry {
  name: RouteName;
  param?: unknown;
}

export type PageStack = readonly PageEntry[];

export const EMPTY_STACK: PageStack = [];

/**
 * 压一页。两条规矩：
 *   - chat 是底，压它等于清栈；
 *   - 同一页只挂一份（重复点入口不该叠出三层设置）。
 */
export function pushPage(stack: PageStack, name: RouteName, param?: unknown): PageStack {
  if (name === "chat") return EMPTY_STACK;
  if (stack.some((entry) => entry.name === name)) return stack;
  return [...stack, param === undefined ? { name } : { name, param }];
}

export function popPage(stack: PageStack): PageStack {
  return stack.length > 0 ? stack.slice(0, -1) : stack;
}

/** 关某一页：它在栈顶就直接退，不在栈顶就把它从中间摘掉。 */
export function closePage(stack: PageStack, name: RouteName): PageStack {
  const top = stack[stack.length - 1];
  if (top && top.name === name) return stack.slice(0, -1);
  return stack.filter((entry) => entry.name !== name);
}

export function resetStack(): PageStack {
  return EMPTY_STACK;
}

export function topPage(stack: PageStack): PageEntry | null {
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

export function isPageOpen(stack: PageStack, name: RouteName): boolean {
  return stack.some((entry) => entry.name === name);
}

export function isPageTop(stack: PageStack, name: RouteName): boolean {
  const top = topPage(stack);
  return top !== null && top.name === name;
}

/** 取栈顶那一页的参数；栈顶不是它就给 null（不顺着栈往下翻）。 */
export function topParam<T>(stack: PageStack, name: RouteName): T | null {
  const top = topPage(stack);
  return top && top.name === name ? ((top.param as T | undefined) ?? null) : null;
}
