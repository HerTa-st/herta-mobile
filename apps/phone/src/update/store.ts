/**
 * 版本检查的状态：一份内存快照 + 一条 KV 缓存。
 *
 * 为什么要缓存：设置页是随手进进出出的地方，每翻一次就发一个请求既浪费也难看。
 * 缓存只存**清单**，不存「有没有新版」——版本号是比出来的，恢复出厂或装了新版包之后
 * 同一份清单该有不同的结论，存结论迟早算错。
 */
import { getKV, setKV } from "../storage.ts";
import { checkUpdate, judgeUpdate, type UpdateManifest, type UpdateVerdict } from "./check.ts";

/** 六小时内翻设置不再发请求。 */
export const CHECK_TTL_MS = 6 * 60 * 60 * 1000;

const KV_KEY = "update.check.v1";

interface CachedCheck {
  at: number;
  /** 当时线上最新的那份清单；没有再新的时候是 null。 */
  manifest: UpdateManifest | null;
}

export interface UpdateSnapshot {
  status: "idle" | "checking" | "done";
  /** 只有「确实有新版」才有值；拉不到、没新版都是 null。 */
  verdict: UpdateVerdict | null;
  checkedAt: number | null;
}

let snapshot: UpdateSnapshot = { status: "idle", verdict: null, checkedAt: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function emit(next: UpdateSnapshot): void {
  snapshot = next;
  for (const fn of listeners) fn();
}

export function getUpdateSnapshot(): UpdateSnapshot {
  return snapshot;
}

export function subscribeUpdate(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

async function readCache(): Promise<CachedCheck | null> {
  try {
    const got = await getKV<CachedCheck>(KV_KEY);
    if (!got || typeof got.at !== "number") return null;
    return got;
  } catch {
    return null;
  }
}

async function writeCache(value: CachedCheck): Promise<void> {
  try {
    await setKV(KV_KEY, value);
  } catch {
    // 缓存写不进去顶多下次多拉一次，不该让检查失败。
  }
}

/** 有新版才把清单塞进快照；没新版就清空，界面据此收起红点。 */
function toSnapshot(manifest: UpdateManifest | null, checkedAt: number, status: "done"): UpdateSnapshot {
  if (!manifest) return { status, verdict: null, checkedAt };
  const verdict = judgeUpdate(manifest);
  return { status, verdict: verdict.hasNew ? verdict : null, checkedAt };
}

export interface EnsureOptions {
  /** 跳过缓存，强制重拉（用户点「检查一次」）。 */
  force?: boolean;
  /** 测试用。 */
  now?: number;
}

/**
 * 拉一次（或者在缓存有效时直接用缓存）。
 *
 * 拉失败**不记缓存、不报错**：界面什么都不显示，下次进设置还能再试。
 */
export async function ensureUpdateChecked(options: EnsureOptions = {}): Promise<UpdateSnapshot> {
  if (inflight) {
    await inflight;
    return snapshot;
  }
  const now = options.now ?? Date.now();

  if (!options.force) {
    const cached = await readCache();
    if (cached && now - cached.at >= 0 && now - cached.at < CHECK_TTL_MS) {
      emit(toSnapshot(cached.manifest, cached.at, "done"));
      return snapshot;
    }
  }

  inflight = (async () => {
    emit({ ...snapshot, status: "checking" });
    const result = await checkUpdate();
    const at = Date.now();
    if (result.ok) {
      const manifest = result.verdict.hasNew ? result.verdict.manifest : null;
      await writeCache({ at, manifest });
      emit(toSnapshot(manifest, at, "done"));
      return;
    }
    // 静默：只把状态收回到 idle/done，不给界面任何「出错了」的信号。
    emit({ status: "done", verdict: null, checkedAt: snapshot.checkedAt });
  })();

  try {
    await inflight;
  } finally {
    inflight = null;
  }
  return snapshot;
}

/** 只给测试用：把内存状态和缓存清回初始。 */
export async function resetUpdateCheck(): Promise<void> {
  emit({ status: "idle", verdict: null, checkedAt: null });
  try {
    await setKV(KV_KEY, { at: 0, manifest: null });
  } catch {
    // 清不掉就算了。
  }
}
