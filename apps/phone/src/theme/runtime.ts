import { assertThemeCss, rewriteCssUrls } from "./css.ts";
import { ThemeError, themeErrorMessage } from "./errors.ts";
import { parseThemeZip, THEME_ZIP_MAX_BYTES } from "./package.ts";
import { parseSkin } from "./skin.ts";
import {
  deleteTheme,
  listThemes,
  loadActiveThemeId,
  loadTheme,
  saveActiveThemeId,
  saveTheme,
  type InstalledThemeMeta,
} from "./store.ts";
import { APP_VERSION } from "./version.ts";

export { APP_VERSION } from "./version.ts";

/**
 * 主题运行时：注入 / 切换 / 回滚 / 卸载。
 *
 * 层叠顺序（从下到上）：
 *   1. App 内置 styles.css
 *   2. 主题 <style id="herta-theme-css">
 *   3. 用户覆盖层 <style id="herta-user-layer">（当前的脸 / 聊天背景 / 日月夜）
 *
 * 用户层由 App 自己写，主题包碰不到；所以主题盖不过用户显式设置。
 * 切回内置时把主题 <style> 整个移除，不在 DOM 里留空壳。
 */

const THEME_STYLE_ID = "herta-theme-css";
const USER_STYLE_ID = "herta-user-layer";

let objectUrls: string[] = [];
let queue: Promise<unknown> = Promise.resolve();

export interface ThemeSnapshot {
  themes: InstalledThemeMeta[];
  activeId: string;
  error: string | null;
}

/**
 * 用户显式设置永远排在主题之后。
 *
 * 这里只放三类守卫：当前的脸、聊天背景、日月夜。主题仍可改颜色 / 圆角 / 排版，
 * 但改不掉用户亲手设过的这三样。背景预设的颜色与纹理和 styles.css 保持一致；
 * 如果那边以后改预设，这里要跟着改（验收项「主题盖不过背景」靠它）。
 */
const USER_LAYER_CSS = `
:root[data-theme="light"] { color-scheme: light !important; }
:root[data-theme="dark"] { color-scheme: dark !important; }

img[data-herta-user="face"] {
  content: normal !important;
  display: revert !important;
  visibility: visible !important;
  opacity: 1 !important;
  filter: none !important;
  clip-path: none !important;
  transform: none !important;
  z-index: auto !important;
}

[data-herta-user="chat-bg"][data-bg="none"] { display: none !important; }
[data-herta-user="chat-bg"]:not([data-bg="none"]) {
  display: block !important;
  visibility: visible !important;
  opacity: 1 !important;
  filter: none !important;
}
[data-herta-user="chat-bg"]:not([data-bg="none"])::before,
[data-herta-user="chat-bg"]:not([data-bg="none"])::after {
  content: none !important;
  display: none !important;
}
[data-herta-user="chat-bg"][data-bg="custom"] {
  background-color: #0b141d !important;
  background-image: var(--herta-user-bg, none) !important;
  background-size: cover !important;
  background-position: 50% 50% !important;
  background-repeat: no-repeat !important;
}
[data-herta-user="chat-bg"][data-bg="dots"] {
  background-color: #f3faf9 !important;
  background-image:
    radial-gradient(circle at 50% 42%, rgba(255, 255, 255, 0.92) 0 26%, transparent 62%),
    radial-gradient(rgba(47, 125, 146, 0.30) 1.05px, transparent 1.45px) !important;
  background-size: cover, 16px 16px !important;
  background-position: 50% 50%, 0 0 !important;
  background-repeat: no-repeat, repeat !important;
}
[data-herta-user="chat-bg"][data-bg="dusk"] {
  background-color: #eef7f8 !important;
  background-image:
    radial-gradient(120% 80% at 14% 0%, rgba(255, 210, 190, 0.55), transparent 56%),
    radial-gradient(90% 62% at 86% 12%, rgba(160, 238, 250, 0.55), transparent 60%),
    linear-gradient(160deg, #f7fbfa 0%, #e8f4f4 56%, #ddefF2 100%) !important;
  background-size: cover !important;
  background-position: 50% 50% !important;
  background-repeat: no-repeat !important;
}
[data-herta-user="chat-bg"][data-bg="grid"] {
  background-color: #f6faf9 !important;
  background-image:
    linear-gradient(rgba(47, 125, 146, 0.10) 1px, transparent 1px),
    linear-gradient(90deg, rgba(47, 125, 146, 0.10) 1px, transparent 1px) !important;
  background-size: 18px 18px !important;
  background-position: 0 0 !important;
  background-repeat: repeat !important;
}
:root[data-theme="dark"] [data-herta-user="chat-bg"][data-bg="dots"] {
  background-color: #08131b !important;
  background-image:
    radial-gradient(circle at 50% 40%, rgba(110, 231, 255, 0.10) 0 24%, transparent 58%),
    radial-gradient(rgba(110, 231, 255, 0.16) 1.05px, transparent 1.45px) !important;
}
:root[data-theme="dark"] [data-herta-user="chat-bg"][data-bg="dusk"] {
  background-color: #07121a !important;
  background-image:
    radial-gradient(120% 80% at 14% 0%, rgba(255, 138, 110, 0.16), transparent 56%),
    radial-gradient(90% 62% at 86% 12%, rgba(38, 168, 200, 0.22), transparent 60%),
    linear-gradient(160deg, #08141d 0%, #061119 58%, #040b12 100%) !important;
}
:root[data-theme="dark"] [data-herta-user="chat-bg"][data-bg="grid"] {
  background-color: #08131b !important;
  background-image:
    linear-gradient(rgba(110, 231, 255, 0.09) 1px, transparent 1px),
    linear-gradient(90deg, rgba(110, 231, 255, 0.09) 1px, transparent 1px) !important;
}
`;

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function ensureLayers(): { theme: HTMLStyleElement; user: HTMLStyleElement } {
  let theme = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!theme) {
    theme = document.createElement("style");
    theme.id = THEME_STYLE_ID;
  }
  let user = document.getElementById(USER_STYLE_ID) as HTMLStyleElement | null;
  if (!user) {
    user = document.createElement("style");
    user.id = USER_STYLE_ID;
  }
  if (user.textContent !== USER_LAYER_CSS) user.textContent = USER_LAYER_CSS;
  // appendChild 会按调用顺序把节点移到 head 末尾：主题在前，用户层在后。
  document.head.appendChild(theme);
  document.head.appendChild(user);
  return { theme, user };
}

function revokeObjectUrls(urls: string[]): void {
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* 已经释放过就算了 */
    }
  }
}

async function applyTheme(id: string | null): Promise<void> {
  const layers = ensureLayers();
  if (!id) {
    layers.theme.textContent = "";
    layers.theme.remove();
    delete document.documentElement.dataset.hertaTheme;
    saveActiveThemeId("");
    const old = objectUrls;
    objectUrls = [];
    revokeObjectUrls(old);
    return;
  }

  const stored = await loadTheme(id);
  if (!stored) throw new ThemeError("missing", "这个主题已经不在本机了。");

  // App 可能被降级 / 主题包可能被改过：每次应用都重新校验一遍。
  parseSkin(stored.skin, APP_VERSION);
  assertThemeCss(stored.css, stored.assets);
  const rewritten = rewriteCssUrls(stored.css, stored.assets);

  const old = objectUrls;
  objectUrls = rewritten.objectUrls;
  layers.theme.textContent = rewritten.css;
  document.documentElement.dataset.hertaTheme = id;
  saveActiveThemeId(id);
  revokeObjectUrls(old);
}

async function snapshot(error: string | null): Promise<ThemeSnapshot> {
  const themes = await listThemes();
  let activeId = loadActiveThemeId();
  if (activeId && !themes.some((theme) => theme.id === activeId)) {
    activeId = "";
    saveActiveThemeId("");
  }
  return { themes, activeId, error };
}

function failed(err: unknown): string {
  return "主题没装上：" + themeErrorMessage(err);
}

/** 启动时应用上次选的主题；失败就回到内置，不把 App 卡在坏主题里。 */
export async function bootstrapTheme(): Promise<ThemeSnapshot> {
  return enqueue(async () => {
    ensureLayers();
    const themes = await listThemes();
    let activeId = loadActiveThemeId();
    if (activeId && !themes.some((theme) => theme.id === activeId)) {
      activeId = "";
      saveActiveThemeId("");
    }
    if (!activeId) {
      await applyTheme(null).catch(() => undefined);
      return { themes, activeId: "", error: null };
    }
    try {
      await applyTheme(activeId);
      return { themes, activeId, error: null };
    } catch (err) {
      saveActiveThemeId("");
      await applyTheme(null).catch(() => undefined);
      return { themes, activeId: "", error: "上次的主题没应用上：" + themeErrorMessage(err) };
    }
  });
}

/** 切换主题；失败回滚到切换前那一个，不把界面留在半截状态。 */
export async function activateTheme(id: string | null): Promise<ThemeSnapshot> {
  return enqueue(async () => {
    const previous = loadActiveThemeId();
    try {
      await applyTheme(id);
      return snapshot(null);
    } catch (err) {
      await applyTheme(previous || null).catch(() => undefined);
      return snapshot(themeErrorMessage(err));
    }
  });
}

/** 装包 → 落库 → 立即切换。装失败时不动当前主题。 */
export async function installThemeFromBytes(bytes: Uint8Array): Promise<ThemeSnapshot> {
  return enqueue(async () => {
    try {
      const parsed = parseThemeZip(bytes, APP_VERSION);
      await saveTheme({
        id: parsed.skin.id,
        skin: parsed.skin,
        css: parsed.css,
        assets: parsed.assets,
        installedAt: Date.now(),
      });
      await applyTheme(parsed.skin.id);
      return snapshot(null);
    } catch (err) {
      return snapshot(failed(err));
    }
  });
}

/** 链接导入（一期分发方式）。CORS / 404 都要翻成一句人话。 */
export async function installThemeFromUrl(url: string): Promise<ThemeSnapshot> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return snapshot("主题链接要以 http:// 或 https:// 开头。");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(trimmed, { cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      return snapshot("下载主题失败：服务器回了 " + response.status + "。");
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > THEME_ZIP_MAX_BYTES) {
      return snapshot("主题包不能超过 4 MB。");
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > THEME_ZIP_MAX_BYTES) {
      return snapshot("主题包不能超过 4 MB。");
    }
    return await installThemeFromBytes(new Uint8Array(buffer));
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return snapshot("下载主题超时了（20 秒）。");
    }
    return snapshot("下载主题失败：" + themeErrorMessage(err));
  } finally {
    clearTimeout(timer);
  }
}

/** 卸载；如果卸的正是当前主题，先回内置再删库。 */
export async function uninstallTheme(id: string): Promise<ThemeSnapshot> {
  return enqueue(async () => {
    try {
      if (loadActiveThemeId() === id) await applyTheme(null);
      await deleteTheme(id);
      return snapshot(null);
    } catch (err) {
      return snapshot("卸载失败：" + themeErrorMessage(err));
    }
  });
}
