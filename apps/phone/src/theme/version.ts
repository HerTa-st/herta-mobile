/**
 * App 版本只有一个出处：apps/phone/android/app/build.gradle 的 versionName。
 *
 * 构建时由 vite.config.mjs 读出来，define 成 __HERTA_APP_VERSION__；
 * 前端不再存第二份版本常量，免得发版时两处对不上。
 *
 * 主题的 minAppVersion 就靠它比较。注入失败时退回 0.0.0——那会让所有
 * 带 minAppVersion 的主题都装不上，比悄悄放行安全。
 */

declare const __HERTA_APP_VERSION__: string | undefined;

function injectedVersion(): string {
  try {
    return typeof __HERTA_APP_VERSION__ === "string" ? __HERTA_APP_VERSION__.trim() : "";
  } catch {
    return "";
  }
}

export const APP_VERSION = injectedVersion() || "0.0.0";

/** 只认 major.minor.patch，可带 -pre / +build 后缀；主题版本够用。 */
export function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** 比较两个语义化版本：a > b 返回正数，相等返回 0，a < b 返回负数。 */
export function compareVersion(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/** minAppVersion 不满足时给作者/用户看的一句话。 */
export function minVersionMessage(minAppVersion: string, current = APP_VERSION): string {
  return "这个主题需要 App " + minAppVersion + " 以上，当前是 " + current + "。";
}
