import { unzipSync } from "fflate";
import { assertThemeCss, THEME_CSS_MAX_BYTES } from "./css.ts";
import { ThemeError } from "./errors.ts";
import { parseSkin, type ThemeSkin } from "./skin.ts";
import { APP_VERSION } from "./version.ts";

/**
 * 主题包 = zip：根目录 skin.json + theme.css，可选 assets/。
 *
 * 复用 fflate（读 docx 那套已经带在包里），不引新依赖。
 * 解压前先按目录条目限尺寸与白名单，解压后再复核一遍——陌生人的包不能信。
 */

export const THEME_ZIP_MAX_BYTES = 4 * 1024 * 1024;
export const THEME_ASSETS_MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 200;
const ASSET_EXT_RE = /\.(woff2|png|jpg|webp|svg)$/i;
const EXECUTABLE_RE = /\.(js|mjs|cjs|wasm|node|html|htm)$/i;

export interface ThemePackage {
  skin: ThemeSkin;
  css: string;
  /** 键是包内路径，例如 assets/paper.png；值是原始字节。 */
  assets: Record<string, Uint8Array>;
}

function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ThemeError("encoding", what + " 不是 UTF-8 文本。");
  }
}

/**
 * 读包 + 校验。任何一条不合规都抛 ThemeError，message 直接给用户看。
 * 校验顺序：zip → 目录结构 → 体积/扩展名 → skin.json → theme.css。
 */
export function parseThemeZip(bytes: Uint8Array, appVersion = APP_VERSION): ThemePackage {
  if (bytes.byteLength > THEME_ZIP_MAX_BYTES) {
    throw new ThemeError("zip-size", "主题包不能超过 4 MB。");
  }

  let skinBytes: Uint8Array | undefined;
  let cssBytes: Uint8Array | undefined;
  const assets: Record<string, Uint8Array> = {};
  let assetTotal = 0;
  let entryCount = 0;

  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(bytes, {
      filter: (file) => {
        entryCount += 1;
        if (entryCount > MAX_ENTRIES) {
          throw new ThemeError("zip-entries", "主题包里的文件太多了（上限 " + MAX_ENTRIES + " 个）。");
        }

        const name = file.name.replace(/\\/g, "/");
        if (name.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(name) || /(^|\/)Thumbs\.db$/i.test(name)) {
          return false;
        }
        if (name.endsWith("/")) return false;
        if (!name || name.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(name)) {
          throw new ThemeError("zip-path", "主题包里有不安全的路径：" + file.name);
        }

        if (name === "skin.json") {
          if (file.originalSize > 64 * 1024) {
            throw new ThemeError("skin-size", "skin.json 太大了（上限 64 KB）。");
          }
          return true;
        }
        if (name === "theme.css") {
          if (file.originalSize > THEME_CSS_MAX_BYTES) {
            throw new ThemeError("css-size", "theme.css 不能超过 256 KB。");
          }
          return true;
        }
        if (name.startsWith("assets/")) {
          if (!ASSET_EXT_RE.test(name)) {
            throw new ThemeError(
              "asset-type",
              "assets/ 里只允许 .woff2 / .png / .jpg / .webp / .svg：" + name
            );
          }
          assetTotal += file.originalSize;
          if (assetTotal > THEME_ASSETS_MAX_BYTES) {
            throw new ThemeError("asset-size", "主题包的 assets/ 加起来不能超过 2 MB。");
          }
          return true;
        }

        if (EXECUTABLE_RE.test(name)) {
          throw new ThemeError("executable", "主题包不能包含可执行文件：" + name + "。");
        }
        if (/(^|\/)(skin\.json|theme\.css)$/.test(name)) {
          throw new ThemeError(
            "zip-root",
            "zip 根目录要直接放 skin.json 和 theme.css（不要多套一层目录）。"
          );
        }
        throw new ThemeError(
          "zip-extra",
          "主题包只允许 skin.json、theme.css 和 assets/，多了一个：" + name
        );
      },
    });
  } catch (err) {
    if (err instanceof ThemeError) throw err;
    throw new ThemeError("zip", "这个主题包解不开（可能不是 zip，或者文件坏了）。");
  }

  for (const [name, data] of Object.entries(zip)) {
    if (name === "skin.json") skinBytes = data;
    else if (name === "theme.css") cssBytes = data;
    else if (name.startsWith("assets/")) assets[name] = data;
  }

  if (!skinBytes) throw new ThemeError("zip-missing-skin", "主题包里没有 skin.json。");
  if (!cssBytes) throw new ThemeError("zip-missing-css", "主题包里没有 theme.css。");

  const css = decodeUtf8(cssBytes, "theme.css");
  assertThemeCss(css, assets);

  let rawSkin: unknown;
  try {
    rawSkin = JSON.parse(decodeUtf8(skinBytes, "skin.json"));
  } catch (err) {
    if (err instanceof ThemeError) throw err;
    throw new ThemeError("skin-json", "skin.json 不是合法的 JSON。");
  }

  return { skin: parseSkin(rawSkin, appVersion), css, assets };
}
