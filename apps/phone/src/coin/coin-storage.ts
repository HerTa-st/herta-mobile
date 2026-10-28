/**
 * 黑塔币的钱包与行情缓存落盘（IndexedDB，复用 storage.ts 的 coin store）。
 *
 * 只存两条固定键：
 *   wallet —— CoinWallet
 *   quote  —— { savedAt, response: CoinDailyResponse }（最后一次成功拉到的行情）
 *
 * 用 storage.ts 的 `tx` 而不是自己开库：DB_VERSION / store 建表都在那边统一管。
 */

import type { CoinDailyResponse, CoinWallet } from "@herta/coin";
import { STORE_COIN, tx } from "../storage.ts";

/** keyPath 是 "key"，所以钱包记录要带 key 字段。 */
interface CoinWalletRecord {
  key: "wallet";
  value: CoinWallet;
}

interface CoinQuoteRecord {
  key: "quote";
  savedAt: string;
  response: CoinDailyResponse;
}

const WALLET_KEY = "wallet";
const QUOTE_KEY = "quote";

/** 读钱包；没有（或脏了）返回 null，调用方据此决定要不要发初始 1000。 */
export async function loadCoinWallet(): Promise<CoinWallet | null> {
  const got = await tx<CoinWalletRecord | undefined>(STORE_COIN, "readonly", (s) =>
    s.get(WALLET_KEY) as IDBRequest<CoinWalletRecord | undefined>
  );
  const wallet = got?.value;
  // 轻校验：备份恢复 / 手工改库都可能塞进半截数据，宁可当没有
  if (!wallet || typeof wallet !== "object" || !Number.isFinite(wallet.holdings) || !Number.isFinite(wallet.costPrice)) {
    return null;
  }
  return wallet;
}

export async function saveCoinWallet(wallet: CoinWallet): Promise<void> {
  await tx(STORE_COIN, "readwrite", (s) => s.put({ key: WALLET_KEY, value: wallet } satisfies CoinWalletRecord));
}

/** 读最后一次成功的行情缓存；没有（或脏了）返回 null。 */
export async function loadCoinQuote(): Promise<{ savedAt: string; response: CoinDailyResponse } | null> {
  const got = await tx<CoinQuoteRecord | undefined>(STORE_COIN, "readonly", (s) =>
    s.get(QUOTE_KEY) as IDBRequest<CoinQuoteRecord | undefined>
  );
  if (!got || typeof got.savedAt !== "string" || !got.response || typeof got.response.serverTime !== "string") {
    return null;
  }
  return { savedAt: got.savedAt, response: got.response };
}

export async function saveCoinQuote(response: CoinDailyResponse): Promise<void> {
  const savedAt = new Date().toISOString();
  await tx(STORE_COIN, "readwrite", (s) => s.put({ key: QUOTE_KEY, savedAt, response } satisfies CoinQuoteRecord));
}
