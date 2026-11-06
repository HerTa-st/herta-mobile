/**
 * B16 · 版本更新提示。
 *
 * 自建分发没有商店推更新，用户不会自己知道有新版本。这里只做一件事：
 * **GET 一个静态 json，比对版本号**。
 *
 * 铁律（设计文档 §6.5）：不上报任何设备或用户信息——不传昵称、不传机型、
 * 不传当前版本、不加任何查询串。服务端只能看到「有人取了这个文件」。
 *
 * 拉不到一律当「没这回事」：抛错、404、超时、坏 JSON 都只是 `ok: false`，
 * 由调用方静默处理。版本检查不该是启动失败的原因。
 */
import { APP_VERSION, compareVersion, parseVersion } from "../theme/version.ts";

/** 站点根目录那份，和宣传页同一个 bucket。 */
export const UPDATE_URL = "https://www.herta-st-gp.top/version.json";

/** 超过这个时间还没回应就算了：宁可不知道，也别卡着启动。 */
export const UPDATE_TIMEOUT_MS = 5000;

export interface UpdateManifest {
  latest: string;
  /** 低于这个版本就必须更新；没写就是不强制。 */
  min: string | null;
  url: string;
  note: string | null;
}

export interface UpdateVerdict {
  manifest: UpdateManifest;
  hasNew: boolean;
  /** 当前版本低于 min：这一版不能跳过。 */
  must: boolean;
}

/**
 * 把远程那份 json 收成可信的形状。
 *
 * 任何一处不成立就整份丢掉：一份半对的清单会让人去下载一个不存在的地址，
 * 或者拿一个写坏的版本号吓人。
 */
export function parseUpdateManifest(raw: unknown): UpdateManifest | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;

  const latest = typeof doc.latest === "string" ? doc.latest.trim() : "";
  if (latest === "" || parseVersion(latest) === null) return null;

  const url = typeof doc.url === "string" ? doc.url.trim() : "";
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return null;

  let min: string | null = null;
  if (typeof doc.min === "string" && doc.min.trim() !== "") {
    min = doc.min.trim();
    // 写坏的 min 不能拿来吓人：宁可当它没写。
    if (parseVersion(min) === null) min = null;
  }

  const note = typeof doc.note === "string" && doc.note.trim() !== "" ? doc.note.trim() : null;

  return { latest, min, url, note };
}

/** 拿当前版本比一比。current 只在测试里换。 */
export function judgeUpdate(manifest: UpdateManifest, current: string = APP_VERSION): UpdateVerdict {
  const hasNew = compareVersion(manifest.latest, current) > 0;
  const must = hasNew && manifest.min !== null && compareVersion(current, manifest.min) < 0;
  return { manifest, hasNew, must };
}

/**
 * 读哪一份。发布包只认 UPDATE_URL；开发时可以用 ?update=/mock/version.json
 * 造一个「有新版」的自己看——不然这条路径永远只能在真发版那天验证。
 */
export function resolveUpdateSource(): string {
  try {
    // 必须直接写 import.meta.env.DEV：Vite 构建时按 define 替换，绕一层就不生效。
    if (import.meta.env.DEV === true && typeof location !== "undefined") {
      const asked = new URLSearchParams(location.search).get("update");
      if (asked && asked.trim()) return asked.trim();
    }
  } catch {
    // Node（单元测试）里没有 import.meta.env，当发布模式。
  }
  return UPDATE_URL;
}

export type UpdateCheckResult = { ok: true; verdict: UpdateVerdict } | { ok: false; detail: string };

export interface CheckUpdateOptions {
  /** 只在测试里换；默认用构建注入的那个版本。 */
  current?: string;
  url?: string;
  timeoutMs?: number;
  /** 测试塞一个假的进来，不碰真网络。 */
  fetchImpl?: typeof fetch;
}

export async function checkUpdate(options: CheckUpdateOptions = {}): Promise<UpdateCheckResult> {
  const current = options.current ?? APP_VERSION;
  const url = options.url ?? resolveUpdateSource();
  const timeoutMs = options.timeoutMs ?? UPDATE_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { ok: false, detail: "这个环境里没有 fetch。" };

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    // 只有 GET + 一个 accept：不带任何设备、用户或版本信息。
    const response = await doFetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) return { ok: false, detail: "版本文件没取到（服务器回 " + response.status + "）。" };

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return { ok: false, detail: "版本文件读不懂（不是合法 JSON）。" };
    }

    const manifest = parseUpdateManifest(raw);
    if (!manifest) return { ok: false, detail: "版本文件缺字段，不敢照着它提示。" };
    return { ok: true, verdict: judgeUpdate(manifest, current) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/abort/i.test(message)) return { ok: false, detail: "等了 " + Math.round(timeoutMs / 1000) + " 秒没回应。" };
    return { ok: false, detail: "请求发不出去，可能没连上网。" };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
