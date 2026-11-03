/**
 * 共享市场数据层（v2）。
 *
 * - 打进共享市场（填了昵称）后，`/api/state` 每 30s 轮询一次；
 * - 买卖 / 签到 / 合并本地钱包都走 POST，成功后立刻重拉 state；
 * - 网络层复用 `pickTransport()`：浏览器 fetch、真机走原生 HTTP。
 *
 * 这里不存本地缓存：共享市场以服务端为准，离线就显示「离线」并保留上一次内存数据。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  coinClaimUrl,
  coinSigninUrl,
  coinStateUrl,
  coinTradeUrl,
  parseCoinState,
} from "@herta/coin";
import type { CoinMarketState } from "@herta/coin";
import { pickTransport } from "../transport.ts";

const REFRESH_MS = 30_000;

export interface UseMarketOptions {
  base: string;
  identity: string;
  active: boolean;
}

export interface UseMarketResult {
  state: CoinMarketState | null;
  loading: boolean;
  offline: boolean;
  error: string | null;
  busy: boolean;
  refresh(): Promise<void>;
  trade(side: "buy" | "sell", amount: number): Promise<string>;
  signin(): Promise<string>;
  claim(amount: number): Promise<string>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useMarket(opts: UseMarketOptions): UseMarketResult {
  const { base, identity, active } = opts;
  const [state, setState] = useState<CoinMarketState | null>(null);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const baseRef = useRef(base);
  baseRef.current = base;
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const refresh = useCallback(async (): Promise<void> => {
    const b = baseRef.current.trim();
    const u = identityRef.current.trim();
    if (!b || !u) return;
    setLoading(true);
    try {
      const text = await pickTransport().getText(coinStateUrl(b, u));
      const next = parseCoinState(text);
      setState(next);
      setOffline(false);
      setError(null);
    } catch (e) {
      setOffline(true);
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 换昵称：旧账号的数据不能继续显示
  useEffect(() => {
    setState(null);
    setError(null);
    setOffline(false);
  }, [identity]);

  // active 期间每 30s 拉一次；页面重新可见立刻补拉
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const schedule = () => {
      if (disposed) return;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void refresh().then(schedule);
      }, REFRESH_MS);
    };
    const kick = () => {
      if (disposed) return;
      clearTimer();
      void refresh().then(schedule);
    };

    kick();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") kick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, refresh]);

  const call = useCallback(async (url: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await pickTransport().post(url, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      json = null;
    }
    if (res.status < 200 || res.status >= 300) {
      const message = json && typeof json.message === "string" ? json.message : "接口 " + res.status;
      throw new Error(message);
    }
    return json ?? {};
  }, []);

  const trade = useCallback(
    async (side: "buy" | "sell", amount: number): Promise<string> => {
      setBusy(true);
      try {
        const json = await call(coinTradeUrl(baseRef.current), {
          user: identityRef.current.trim(),
          side,
          amount,
        });
        await refresh();
        const t = (json.trade ?? {}) as Record<string, unknown>;
        const price = typeof t.price === "number" ? t.price.toFixed(2) : "—";
        const fee = typeof t.fee === "number" ? t.fee.toFixed(2) : "—";
        return (side === "buy" ? "买入" : "卖出") + " " + amount + " HTC 成交，成交价 " + price + "，手续费 " + fee + " USDT";
      } finally {
        setBusy(false);
      }
    },
    [call, refresh]
  );

  const signin = useCallback(async (): Promise<string> => {
    setBusy(true);
    try {
      const json = await call(coinSigninUrl(baseRef.current), { user: identityRef.current.trim() });
      await refresh();
      const reward = typeof json.reward === "number" ? json.reward : 0;
      const streak = typeof json.streak === "number" ? json.streak : 0;
      return "签到成功，+" + reward + " HTC（连签 " + streak + " 天）";
    } finally {
      setBusy(false);
    }
  }, [call, refresh]);

  const claim = useCallback(
    async (amount: number): Promise<string> => {
      setBusy(true);
      try {
        const json = await call(coinClaimUrl(baseRef.current), {
          user: identityRef.current.trim(),
          amount,
        });
        await refresh();
        const merged = typeof json.mergedHtc === "number" ? json.mergedHtc : amount;
        return "已把 " + merged + " HTC 并入共享市场";
      } finally {
        setBusy(false);
      }
    },
    [call, refresh]
  );

  return { state, loading, offline, error, busy, refresh, trade, signin, claim };
}
