/**
 * 黑塔币 · 用户密钥（谁在操作这个号）
 *
 * 2026-11 之前服务端完全信任请求里的 user 字段：任何人 curl 一下就能读别人的
 * 持仓、替别人下单。现在每个昵称配一把 48 位 hex 密钥：
 *
 *   1. 第一次连共享市场时向 /api/bind 领一把，存在本机；
 *   2. 之后每个身份类请求都带 X-Herta-Key 请求头（不进 URL、不进日志）；
 *   3. 服务端只存 sha256(salt+secret)，**换手机或清数据就找不回来了**——
 *      界面上要提醒用户，丢了只能找管理员换发。
 *
 * 服务端没开鉴权（AUTH_MODE=off）时 /api/bind 会回 auth_disabled，
 * 这里当成「不需要密钥」并记一个 6 小时的标记，免得每 30 秒白试一次。
 * 同一份安装包在开/关两种模式下都能用。
 */

export const COIN_KEY_HEADER = "X-Herta-Key";

/** 昵称 -> 密钥。单独一个存储键，不混进 settings（settings 会被整份导出）。 */
const KEYS_KEY = "herta.coin.keys.v1";
/** 「服务端还没开鉴权」的时间戳，避免反复领取。 */
const OFF_KEY = "herta.coin.auth.off.v1";
const OFF_TTL_MS = 6 * 60 * 60 * 1000;

const KEY_RE = /^[0-9a-f]{48}$/;

export function isCoinKey(value: unknown): value is string {
  return typeof value === "string" && KEY_RE.test(value);
}

function readMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEYS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, string>): void {
  try {
    localStorage.setItem(KEYS_KEY, JSON.stringify(map));
  } catch {
    /* 存储满了也不能让页面挂，顶多下次重新领 */
  }
}

export function getCoinKey(user: string): string {
  if (!user) return "";
  const value = readMap()[user];
  return isCoinKey(value) ? value : "";
}

export function setCoinKey(user: string, key: string): void {
  if (!user || !isCoinKey(key)) return;
  const map = readMap();
  map[user] = key;
  writeMap(map);
}

export function clearCoinKey(user: string): void {
  if (!user) return;
  const map = readMap();
  if (!(user in map)) return;
  delete map[user];
  writeMap(map);
}

/** 密钥 → 请求头。没有或不合法就返回空对象，不会往请求里塞垃圾。 */
export function coinKeyHeaders(key: string | null | undefined): Record<string, string> {
  return isCoinKey(key) ? { [COIN_KEY_HEADER]: key } : {};
}

/** 整份密钥表（换机打包用）。只回合法的，脏数据不带出去。 */
export function exportCoinKeys(): Record<string, string> {
  const map = readMap();
  const out: Record<string, string> = {};
  for (const [name, key] of Object.entries(map)) {
    if (name && isCoinKey(key)) out[name] = key;
  }
  return out;
}

/** 本机已经有密钥的昵称（恢复时用来判断「合并别覆盖」）。 */
export function listCoinKeyNames(): string[] {
  return Object.keys(exportCoinKeys());
}

/**
 * 把包里的密钥写回本机。
 * @returns 真正写进去的条数（包里的脏数据会被丢掉）
 */
export function importCoinKeys(map: Record<string, string> | undefined): number {
  if (!map) return 0;
  let written = 0;
  for (const [name, key] of Object.entries(map)) {
    if (!name || !isCoinKey(key)) continue;
    setCoinKey(name, key);
    written += 1;
  }
  return written;
}

function authKnownOff(): boolean {
  try {
    const raw = Number(localStorage.getItem(OFF_KEY));
    return Number.isFinite(raw) && raw > 0 && Date.now() - raw < OFF_TTL_MS;
  } catch {
    return false;
  }
}

function markAuthOff(): void {
  try {
    localStorage.setItem(OFF_KEY, String(Date.now()));
  } catch {
    /* 记不住就记不住，最多多试几次 */
  }
}

type PostFn = (
  url: string,
  opts: { headers: Record<string, string>; body: string }
) => Promise<{ status: number; body: string }>;

/**
 * 领一把新密钥。
 * @returns 密钥；返回空串表示「服务端没开鉴权，不用密钥」
 */
export async function claimCoinKey(
  base: string,
  user: string,
  post: PostFn,
  existing?: string | null
): Promise<string> {
  const url = base.replace(/\/+$/, "") + "/api/bind";
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...coinKeyHeaders(existing ?? ""),
  };
  const res = await post(url, { headers, body: JSON.stringify({ user }) });

  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    json = null;
  }
  const code = json && typeof json.error === "string" ? json.error : "";

  if (res.status === 200) {
    if (isCoinKey(json?.secret)) return json!.secret as string;
    // 带着自己的旧钥匙来，服务端只确认「是你的」，不会再给一遍明文
    if (json && json.secret === null) {
      if (isCoinKey(existing)) return existing;
      throw new Error("这台设备上没有这个昵称的密钥，换回原来那台设备登录");
    }
  }
  if (res.status === 409 && code === "auth_disabled") return "";
  if (res.status === 409 && code === "already_bound") {
    throw new Error("这个昵称已经被别的设备绑定过；换回原来那台，或找管理员换发密钥");
  }
  const msg = json && typeof json.message === "string" ? json.message : "接口 " + res.status;
  throw new Error("领取密钥失败：" + msg);
}

/**
 * 拿这个昵称的密钥；本机没有就现领一把。
 * @returns 空串表示服务端没开鉴权，请求不用带密钥
 */
export async function ensureCoinKey(base: string, user: string, post: PostFn): Promise<string> {
  if (!base || !user) return "";
  const existing = getCoinKey(user);
  if (existing) return existing;
  if (authKnownOff()) return "";
  const secret = await claimCoinKey(base, user, post, "");
  if (isCoinKey(secret)) setCoinKey(user, secret);
  else markAuthOff();
  return secret;
}
