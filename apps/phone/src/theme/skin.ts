import { APP_VERSION, compareVersion, minVersionMessage, parseVersion } from "./version.ts";
import { ThemeError } from "./errors.ts";

/** skin.json 的身份证。缺 author / description 时继承空串，不拒绝老主题。 */
export interface ThemeSkin {
  id: string;
  name: string;
  author: string;
  version: string;
  minAppVersion: string;
  /** 契约版本；当前只认 1。 */
  contract: number;
  description: string;
}

export const CONTRACT_VERSION = 1;

function requiredText(raw: Record<string, unknown>, field: string, max: number): string {
  const value = raw[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new ThemeError("skin-field", "skin.json 缺少必填字段「" + field + "」。");
  }
  const text = value.trim();
  if (text.length > max) {
    throw new ThemeError("skin-field", "skin.json 的「" + field + "」太长了（上限 " + max + " 字）。");
  }
  return text;
}

function optionalText(raw: Record<string, unknown>, field: string, max: number): string {
  const value = raw[field];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new ThemeError("skin-field", "skin.json 的「" + field + "」应该是字符串。");
  }
  if (value.length > max) {
    throw new ThemeError("skin-field", "skin.json 的「" + field + "」太长了（上限 " + max + " 字）。");
  }
  return value.trim();
}

/**
 * 校验 skin.json。只做结构 / 版本 / 契约三件事：
 * - 字段缺失按默认继承（author / description 可省）；
 * - id 必须全小写，避免大小写在大小写不敏感的文件系统上撞车；
 * - minAppVersion 高于当前 App 直接拒绝，并说清「需要 X 以上」。
 */
export function parseSkin(raw: unknown, appVersion = APP_VERSION): ThemeSkin {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ThemeError("skin-json", "skin.json 不是一个 JSON 对象。");
  }
  const obj = raw as Record<string, unknown>;

  const id = requiredText(obj, "id", 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new ThemeError("skin-id", "主题 id 只能用小写字母、数字和连字符（例如 herta-paper）。");
  }
  if (id === "builtin") {
    throw new ThemeError("skin-id", "「builtin」是内置主题的保留 id，换一个。");
  }

  const name = requiredText(obj, "name", 80);
  const version = requiredText(obj, "version", 40);
  if (!parseVersion(version)) {
    throw new ThemeError("skin-version", "skin.json 的 version 要写成 1.0.0 这样（语义化版本）。");
  }

  const minAppVersion = requiredText(obj, "minAppVersion", 40);
  if (!parseVersion(minAppVersion)) {
    throw new ThemeError("skin-min-version", "skin.json 的 minAppVersion 要写成 0.32.0 这样（语义化版本）。");
  }
  if (compareVersion(minAppVersion, appVersion) > 0) {
    throw new ThemeError("app-too-old", minVersionMessage(minAppVersion, appVersion));
  }

  if (obj.contract !== CONTRACT_VERSION) {
    throw new ThemeError(
      "contract",
      "这个主题的契约版本是 " + String(obj.contract) + "，当前 App 只认 " + CONTRACT_VERSION + "。"
    );
  }

  return {
    id,
    name,
    author: optionalText(obj, "author", 80),
    version,
    minAppVersion,
    contract: CONTRACT_VERSION,
    description: optionalText(obj, "description", 500),
  };
}
