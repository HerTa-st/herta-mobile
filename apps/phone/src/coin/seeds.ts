/**
 * 每日价格密钥的客户端缓存与拉取。
 *
 * 口径见 docs/价格密钥-设计-2026-11-07.md：密钥留在服务端、每天随机生成，
 * 客户端只在「当天/历史交易日」各取一把，拿去本地算 K 线。
 * 拿不到就没有密钥——不拿日期派生备用钥匙（会和服务端算出两条线）。
 */

/** 从这一天起价格由服务端下发的随机密钥决定；之前的日期走旧规则（日期派生）。 */
export const COIN_CUTOVER = "2026-11-07";

const STORE_KEY = "herta.coin.seeds.v1";
const SEED_HEX = /^[0-9a-f]{32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type SeedMap = Record<string, string>;

export interface SeedPayload {
  version: number;
  cutover: string;
  seeds: SeedMap;
}

/** 上海墙上日期（UTC+8，无夏令时），YYYY-MM-DD。和坐标轴/服务端同一口径。 */
export function shanghaiDate(nowMs: number): string {
  const shifted = new Date(nowMs + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** 严格解析 /api/seeds 的响应：字段缺、密钥格式不对、JSON 坏了都抛中文 Error。 */
export function parseSeeds(text: string): SeedPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("密钥接口返回的不是 JSON");
  }
  if (!raw || typeof raw !== "object") throw new Error("密钥接口返回的不是对象");
  const obj = raw as Record<string, unknown>;
  const version = obj.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error("密钥接口的 version 不对：" + String(version));
  }
  const cutover = obj.cutover;
  if (typeof cutover !== "string" || !DATE_RE.test(cutover)) {
    throw new Error("密钥接口的 cutover 不是 YYYY-MM-DD：" + String(cutover));
  }
  const rawSeeds = obj.seeds;
  if (!rawSeeds || typeof rawSeeds !== "object" || Array.isArray(rawSeeds)) {
    throw new Error("密钥接口的 seeds 缺失或不是对象");
  }
  const seeds: SeedMap = {};
  for (const [date, seed] of Object.entries(rawSeeds as Record<string, unknown>)) {
    if (!DATE_RE.test(date)) throw new Error("密钥接口里有不合法的日期：" + date);
    if (typeof seed !== "string" || !SEED_HEX.test(seed)) {
      throw new Error("密钥接口里 " + date + " 的密钥格式不对");
    }
    seeds[date] = seed;
  }
  return { version, cutover, seeds };
}

/** 读本地缓存；坏了就当没缓存，不抛。 */
export function readSeedCache(storage: Pick<Storage, "getItem"> | null): SeedMap {
  if (!storage) return {};
  const text = storage.getItem(STORE_KEY);
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SeedMap = {};
    for (const [date, seed] of Object.entries(parsed as Record<string, unknown>)) {
      if (DATE_RE.test(date) && typeof seed === "string" && SEED_HEX.test(seed)) out[date] = seed;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeSeedCache(storage: Pick<Storage, "setItem"> | null, seeds: SeedMap): void {
  if (!storage) return;
  try {
    storage.setItem(STORE_KEY, JSON.stringify(seeds));
  } catch {
    // 存不下就算了：下一次进页面再拉
  }
}

/** 新旧合并：新拿到的覆盖旧的，旧日期保留（历史 K 线要用）。 */
export function mergeSeeds(cached: SeedMap, fresh: SeedMap): SeedMap {
  return { ...cached, ...fresh };
}

/** 某一天该用的密钥；没有就 null（调用方据此显示「今天还没拿到密钥」）。 */
export function secretForDate(seeds: SeedMap, date: string): string | null {
  if (date < COIN_CUTOVER) return null; // 旧日期不需要密钥，由本地算法按日期派生
  return seeds[date] ?? null;
}

/** 拉 /api/seeds?from=<cutover>；失败抛人话，调用方自己决定要不要用缓存顶着。 */
export async function fetchSeeds(
  base: string,
  fetchImpl: typeof fetch = fetch,
  from: string = COIN_CUTOVER
): Promise<SeedMap> {
  const url = base.replace(/\/+$/, "") + "/api/seeds?from=" + encodeURIComponent(from);
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("密钥接口 HTTP " + res.status);
  const payload = parseSeeds(await res.text());
  return payload.seeds;
}
