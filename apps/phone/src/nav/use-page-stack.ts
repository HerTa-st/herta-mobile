import { useCallback, useRef, useState } from "react";
import type { RouteName } from "./routes.ts";
import {
  closePage,
  isPageOpen,
  isPageTop,
  popPage,
  pushPage,
  resetStack,
  topPage,
  topParam,
  type PageStack,
} from "./stack.ts";

/**
 * 页面栈的 React 皮。
 *
 * 为什么返回布尔：返回键那条回调要知道「这次有没有被页面吃掉」。吃了就拦，
 * 没吃就交还系统（该退 App 就退 App）。
 */
export interface PageStackApi {
  stack: PageStack;
  /** 栈顶页；空栈 = 在对话页。 */
  top: RouteName | null;
  canGoBack: boolean;
  push(name: RouteName, param?: unknown): void;
  /** 退一页；返回 false 表示本来就在对话页。 */
  back(): boolean;
  close(name: RouteName): void;
  reset(): void;
  isOpen(name: RouteName): boolean;
  isTop(name: RouteName): boolean;
  paramOf<T>(name: RouteName): T | null;
  /** 给系统返回键读最新栈：effect 闭包会拿到旧值，这里永远读 ref。 */
  read(): PageStack;
}

export function usePageStack(): PageStackApi {
  const [stack, setStack] = useState<PageStack>(() => resetStack());
  const ref = useRef<PageStack>(stack);
  ref.current = stack;

  const push = useCallback((name: RouteName, param?: unknown) => {
    setStack((current) => pushPage(current, name, param));
  }, []);

  const pop = useCallback((): boolean => {
    const had = ref.current.length > 0;
    if (had) setStack((current) => popPage(current));
    return had;
  }, []);

  const close = useCallback((name: RouteName) => {
    setStack((current) => closePage(current, name));
  }, []);

  const reset = useCallback(() => setStack(resetStack()), []);

  /** 返回键回调里读最新栈：必须是稳定引用，否则监听会每次渲染重挂。 */
  const read = useCallback(() => ref.current, []);

  const top = topPage(stack)?.name ?? null;

  return {
    stack,
    top,
    canGoBack: stack.length > 0,
    push,
    back: pop,
    close,
    reset,
    isOpen: (name) => isPageOpen(stack, name),
    isTop: (name) => isPageTop(stack, name),
    paramOf: <T,>(name: RouteName) => topParam<T>(stack, name),
    read,
  };
}
