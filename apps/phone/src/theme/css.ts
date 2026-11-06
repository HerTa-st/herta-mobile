import { ThemeError } from "./errors.ts";

/**
 * theme.css 的静态校验与注入前处理。
 *
 * 铁律：主题只能随包（CSS + 素材），不能执行代码、不能联网。
 * 所以这里做两道：
 * 1. 静态拒绝 @import / 远程 url / expression / javascript: 等；
 * 2. 把包内相对 url（只认 assets/）换成 blob: URL，注入时离线可用。
 */

export const THEME_CSS_MAX_BYTES = 256 * 1024;

const URL_RE = /url\(\s*(['"]?)([^)]*?)\1\s*\)/gi;
const LIGHT_SELECTOR_RE = /\[\s*data-theme\s*=\s*(['"]?)light\1\s*\]/i;
const DARK_SELECTOR_RE = /\[\s*data-theme\s*=\s*(['"]?)dark\1\s*\]/i;

/** 保留长度地把注释替换成空格：这样 URL 匹配拿到的 index 还能对回原文。 */
function maskComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));
}

interface CssUrlMatch {
  index: number;
  length: number;
  value: string;
  quote: string;
}

function scanUrls(source: string): CssUrlMatch[] {
  const matches: CssUrlMatch[] = [];
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(source)) !== null) {
    matches.push({ index: match.index, length: match[0].length, value: match[2].trim(), quote: match[1] });
  }
  return matches;
}

function assetKeyOf(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new ThemeError("css-url", "theme.css 里有无法识别的 url()：" + raw);
  }
  const withoutQuery = decoded.split(/[?#]/, 1)[0] ?? "";
  const parts: string[] = [];
  for (const part of withoutQuery.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) {
        throw new ThemeError("css-url", "theme.css 不能引用包外的文件：" + raw);
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const key = parts.join("/");
  if (!key.startsWith("assets/") || key === "assets/") {
    throw new ThemeError(
      "css-url",
      "theme.css 只能引用包内 assets/ 下的文件（相对路径）；它引用了：" + raw
    );
  }
  return key;
}

function assertUrlAllowed(raw: string, assets: Record<string, Uint8Array>): void {
  if (!raw || raw.startsWith("#")) return;
  const lower = raw.toLowerCase();
  if (lower.startsWith("data:")) return;
  if (lower.startsWith("//")) {
    throw new ThemeError("css-remote", "主题必须离线可用：theme.css 里不能引用远程地址（" + raw + "）。");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    throw new ThemeError("css-remote", "主题必须离线可用：theme.css 里不能引用外部协议地址（" + raw + "）。");
  }
  if (raw.startsWith("/")) {
    throw new ThemeError("css-url", "theme.css 不能引用 App 内的绝对路径：" + raw + "。请放进主题包的 assets/。");
  }
  const key = assetKeyOf(raw);
  if (!assets[key]) {
    throw new ThemeError("css-asset-missing", "theme.css 引用了包里没有的文件：" + key + "。");
  }
}

/**
 * 注入前校验。抛出的 ThemeError 会直接把中文原因显示给用户，
 * 所以每句话都要能读懂「哪儿不对、怎么改」。
 */
export function assertThemeCss(source: string, assets: Record<string, Uint8Array>): void {
  if (!source.trim()) {
    throw new ThemeError("css-empty", "theme.css 是空的。");
  }
  if (new TextEncoder().encode(source).byteLength > THEME_CSS_MAX_BYTES) {
    throw new ThemeError("css-size", "theme.css 不能超过 256 KB。");
  }

  const masked = maskComments(source);
  if (/@\s*import\b/i.test(masked)) {
    throw new ThemeError("css-import", "theme.css 里不能出现 @import：主题必须离线自足。");
  }
  if (/expression\s*\(/i.test(masked)) {
    throw new ThemeError("css-unsafe", "theme.css 里不能出现 expression()。");
  }
  if (/javascript\s*:/i.test(masked)) {
    throw new ThemeError("css-unsafe", "theme.css 里不能出现 javascript: 地址。");
  }
  if (/-moz-binding\s*:/i.test(masked) || /(^|[;{])\s*behavior\s*:/i.test(masked)) {
    throw new ThemeError("css-unsafe", "theme.css 里不能出现 behavior / -moz-binding。");
  }

  for (const url of scanUrls(masked)) {
    assertUrlAllowed(url.value, assets);
  }

  if (!LIGHT_SELECTOR_RE.test(masked) || !DARK_SELECTOR_RE.test(masked)) {
    throw new ThemeError(
      "css-theme-pair",
      '主题 CSS 要同时写亮色和暗色两套：:root[data-theme="light"] 与 :root[data-theme="dark"]。'
    );
  }
}

const MIME: Record<string, string> = {
  woff2: "font/woff2",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function mimeOf(key: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(key)?.[1]?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

/**
 * 把相对 url 换成 blob:，返回新 CSS 和需要回收的 object URL。
 * assets 已经在安装时校验过扩展名与总量；这里只负责映射。
 */
export function rewriteCssUrls(
  source: string,
  assets: Record<string, Uint8Array>
): { css: string; objectUrls: string[] } {
  const masked = maskComments(source);
  const urls = scanUrls(masked);
  if (urls.length === 0) return { css: source, objectUrls: [] };

  const objectUrls: string[] = [];
  let out = "";
  let cursor = 0;
  try {
    for (const url of urls) {
      if (!url.value || url.value.startsWith("#") || url.value.toLowerCase().startsWith("data:")) continue;
      const key = assetKeyOf(url.value);
      const bytes = assets[key];
      if (!bytes) {
        throw new ThemeError("css-asset-missing", "theme.css 引用了包里没有的文件：" + key + "。");
      }
      const objectUrl = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeOf(key) }));
      objectUrls.push(objectUrl);
      out += source.slice(cursor, url.index) + 'url("' + objectUrl + '")';
      cursor = url.index + url.length;
    }
    out += source.slice(cursor);
    return { css: out, objectUrls };
  } catch (err) {
    for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
    throw err;
  }
}
