import { Capacitor, registerPlugin } from "@capacitor/core";

interface BackButtonData {
  canGoBack: boolean;
}

interface AppPlugin {
  addListener(
    event: "backButton",
    callback: (data: BackButtonData) => void
  ): Promise<{ remove(): Promise<void> | void }>;
  exitApp(): Promise<void>;
}

/**
 * 系统返回键接缝（ADR-0002：返回键在这批统一，不再逐页确认）。
 *
 * 安卓的返回键在 Activity 层，WebView 收不到；Capacitor 的办法是原生 App 插件
 * 往 JS 抛 backButton。这里不 import "@capacitor/app"（没装的包会让打包直接挂），
 * 只用 core 的 registerPlugin 造一个代理：android 工程里真的登记了 App 插件，
 * 下面这段就生效；没登记就退到 popstate（浏览器 / dev）。
 *
 * handler 返回 true = 页面栈吃掉了这次返回；false = 交还系统。
 */
export function systemBackAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("App");
}

export function connectSystemBack(handler: (event: BackButtonData) => boolean): () => void {
  let disposed = false;
  const detachers: Array<() => void> = [];

  if (systemBackAvailable()) {
    const app = registerPlugin<AppPlugin>("App");
    void app
      .addListener("backButton", (event) => {
        if (handler(event)) return;
        // 栈空：把这次返回还给系统。WebView 有历史就先退历史，没有就退出 App。
        if (event.canGoBack) window.history.back();
        else void app.exitApp();
      })
      .then((handle) => {
        if (disposed) void handle.remove();
        else detachers.push(() => void handle.remove());
      })
      .catch(() => {
        /* 插件没登记：下面的 popstate 兜底 */
      });
  }

  if (typeof window !== "undefined") {
    const onPopState = () => {
      handler({ canGoBack: window.history.length > 1 });
    };
    window.addEventListener("popstate", onPopState);
    detachers.push(() => window.removeEventListener("popstate", onPopState));
  }

  return () => {
    disposed = true;
    for (const detach of detachers.splice(0)) detach();
  };
}
