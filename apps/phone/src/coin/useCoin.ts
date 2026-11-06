/**
 * 黑塔币页的数据层：行情轮询 + 缓存回退 + 钱包 + 签到。
 *
 * 行为（契约 §4）：
 *   - 首次 `active` 时并行读钱包/缓存，再拉接口；成功落缓存，失败回退缓存并标离线；
 *   - `base === ""` 不请求，直接给「未配置行情接口」；
 *   - active 期间每 30s 拉一次；页面重新可见时立刻补拉；active=false / 卸载即停；
 *   - 首次拿到接口且本地无钱包 → 发 1000 HTC（成本价 = market.open），只发一次；
 *   - sign()：以最近一次成功行情的 serverTime 判断能不能签，入账后落库。
 *
 * 拉取统一走 `pickTransport().getText`：浏览器是 fetch，native 走原生 HTTP 通道（CORS 绕行）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CoinDailyResponse, CoinWallet, SigninCheck } from "@herta/coin";
import { applySignin, createWallet, signinCheck } from "@herta/coin";
import { pickTransport } from "../transport.ts";
import { loadCoinQuote, loadCoinWallet, saveCoinQuote, saveCoinWallet } from "./coin-storage.ts";
import { buildLocalQuote, hasSessionSeed, syncSeeds } from "./local-quote.ts";
import { readSeedCache, type SeedMap } from "./seeds.ts";

/** 行情轮询间隔：契约写死 30s。 */
const REFRESH_MS = 30_000;

export interface UseCoinOptions {
  /** 行情接口基址；空串表示没配置（页面会说明，不发请求）。 */
  base: string;
  /** 页面是不是开着：控制首次加载、30s 轮询与可见性补拉。 */
  active: boolean;
}

export interface UseCoinResult {
  loading: boolean;
  /** 最新成功数据；每次失败回退到最近一次成功/缓存。 */
  quote: CoinDailyResponse | null;
  /** quote 是不是缓存（不是本轮刚从接口拿到的）。 */
  cached: boolean;
  /** 无网/接口失败/未配置接口。 */
  offline: boolean;
  error: string | null;
  wallet: CoinWallet | null;
  signin: SigninCheck | null;
  signing: boolean;
  refresh(): Promise<void>;
  /** 返回给用户看的一句话（成功/失败）。 */
  sign(): Promise<string>;
}

export function useCoin(opts: UseCoinOptions): UseCoinResult {
  const { base, active } = opts;

  const [loading, setLoading] = useState(active);
  const [quote, setQuote] = useState<CoinDailyResponse | null>(null);
  const [cached, setCached] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<CoinWallet | null>(null);
  const [signing, setSigning] = useState(false);

  // 回调用 ref 拿最新值，避免因为 base/wallet 变了就重建定时器
  const baseRef = useRef(base);
  baseRef.current = base;
  const quoteRef = useRef<CoinDailyResponse | null>(null);
  const walletRef = useRef<CoinWallet | null>(null);
  const cachedRef = useRef(false);
  const offlineRef = useRef(false);
  const signingRef = useRef(false);

  /** 首次 active 的「并行读钱包/缓存」只做一次。 */
  const hydratedRef = useRef<Promise<void> | null>(null);
  /** 同一时刻只允许一个拉取在飞。 */
  const inflightRef = useRef<Promise<void> | null>(null);
  /** 初始 1000 HTC 只发一次（落库失败才允许下一轮重试）。 */
  const walletInitRef = useRef(false);
  /** 每日价格密钥（本地缓存 + 本轮拉到的）。K 线拿它在地算，不再向接口要 bars。 */
  const seedsRef = useRef<SeedMap>({});

  const seedStorage = (): Pick<Storage, "getItem" | "setItem"> | null => {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  };

  const setOfflineState = useCallback((value: boolean) => {
    offlineRef.current = value;
    setOffline(value);
  }, []);

  /* --------------------------------------------------------- 首次读缓存 */

  const hydrate = useCallback(async (): Promise<void> => {
    // 两块互不依赖，并行读；单块失败不拖累另一块
    const [storedWallet, storedQuote] = await Promise.all([
      loadCoinWallet().catch(() => null),
      loadCoinQuote().catch(() => null),
    ]);
    if (storedWallet) {
      walletRef.current = storedWallet;
      setWallet(storedWallet);
    }
    // 有今天（或昨天）的密钥就当场算一份：断网也能立刻出图，不必等接口
    const storage = seedStorage();
    seedsRef.current = readSeedCache(storage);
    const local = buildLocalQuote(Date.now(), seedsRef.current);
    if (local) {
      quoteRef.current = local;
      setQuote(local);
      cachedRef.current = false;
      setCached(false);
      return;
    }
    if (storedQuote) {
      quoteRef.current = storedQuote.response;
      setQuote(storedQuote.response);
      cachedRef.current = true;
      setCached(true);
    }
  }, []);

  const ensureHydrated = useCallback((): Promise<void> => {
    if (!hydratedRef.current) hydratedRef.current = hydrate();
    return hydratedRef.current;
  }, [hydrate]);

  /* ---------------------------------------------------------- 首次发币 */

  const ensureWallet = useCallback(async (fresh: CoinDailyResponse): Promise<void> => {
    if (walletRef.current || walletInitRef.current) return;
    walletInitRef.current = true;
    try {
      const created = createWallet(fresh.market.open, fresh.serverTime);
      await saveCoinWallet(created);
      walletRef.current = created;
      setWallet(created);
    } catch {
      walletInitRef.current = false; // 落库失败：下一轮再试
    }
  }, []);

  /* -------------------------------------------------------------- 拉取 */

  const runRefresh = useCallback(async (): Promise<void> => {
    const currentBase = baseRef.current.trim();
    if (!currentBase) {
      setOfflineState(true);
      setError("未配置行情接口");
      setLoading(false);
      return;
    }

    // 后台 30s 刷新也亮 loading：CoinView 的「重试/刷新」按钮靠它防连点
    setLoading(true);
    const nowMs = Date.now();

    try {
      // 密钥一场一把（周末/盘前要的是上一个交易日的）：没有就向服务端要；
      // 已经有了就地重算，不再拉 K 线数据。
      let seeds = seedsRef.current;
      if (!hasSessionSeed(nowMs, seeds)) {
        const synced = await syncSeeds(currentBase, (url) => pickTransport().getText(url), seedStorage());
        seeds = synced.seeds;
        seedsRef.current = seeds;
      }
      const fresh = buildLocalQuote(nowMs, seeds);
      if (!fresh) throw new Error("还没拿到这一场的价格密钥，连上就有了");
      quoteRef.current = fresh;
      setQuote(fresh);
      cachedRef.current = false;
      setCached(false);
      setOfflineState(false);
      setError(null);
      setLoading(false);
      void saveCoinQuote(fresh).catch(() => undefined); // 缓存失败不影响本轮展示
      await ensureWallet(fresh);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setOfflineState(true);
      setError(message);
      // 有旧数据就是回退缓存
      cachedRef.current = quoteRef.current !== null;
      setCached(cachedRef.current);
      setLoading(false);
    }
  }, [ensureWallet, setOfflineState]);

  const refresh = useCallback(async (): Promise<void> => {
    // 手点刷新可能早于首次读库完成：等一手，别让缓存晚到把刚拉的新数据盖掉
    await ensureHydrated();
    if (inflightRef.current) {
      await inflightRef.current;
      return;
    }
    const task = runRefresh();
    inflightRef.current = task;
    try {
      await task;
    } finally {
      if (inflightRef.current === task) inflightRef.current = null;
    }
  }, [ensureHydrated, runRefresh]);

  /* ------------------------------------------------ active：首拉 + 轮询 */

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

    // 拉完再排 30s（契约 §0）：慢请求不会把间隔挤成「还没回来就再拉」
    const schedule = () => {
      if (disposed) return;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void refresh().then(schedule);
      }, REFRESH_MS);
    };

    // 立刻拉一次；可见性恢复也走这里，顺带把 30s 的排期重排
    const kick = () => {
      if (disposed) return;
      clearTimer();
      void refresh().then(schedule);
    };

    void (async () => {
      await ensureHydrated();
      if (!disposed) kick();
    })();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") kick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, ensureHydrated, refresh]);

  /* --------------------------------------------------------- 签到状态 */

  // 拿到「最新行情 + 钱包」就算一次；每 30s 的新行情会让它跟着刷新
  const signin = useMemo<SigninCheck | null>(() => {
    if (!quote || !wallet) return null;
    try {
      return signinCheck({ wallet, sessionDate: quote.market.sessionDate, serverTime: quote.serverTime });
    } catch {
      return null;
    }
  }, [quote, wallet]);

  const sign = useCallback(async (): Promise<string> => {
    if (signingRef.current) return "正在签到…";
    await ensureHydrated(); // 钱包可能还在读库
    if (signingRef.current) return "正在签到…";
    const currentQuote = quoteRef.current;
    if (!currentQuote) {
      return offlineRef.current ? "签到需要联网" : "行情还没加载好，稍后再试";
    }
    if (offlineRef.current) return "签到需要联网";
    // 缓存行情（本轮还没成功连过服务器 / 上次拉取失败）不能签：服务器时间必须是刚拿到的
    if (cachedRef.current) return "签到需要联网";
    const currentWallet = walletRef.current;
    if (!currentWallet) return "钱包还没准备好，稍后再试";

    const check = signinCheck({
      wallet: currentWallet,
      sessionDate: currentQuote.market.sessionDate,
      serverTime: currentQuote.serverTime,
    });
    if (!check.canSign) return check.message;

    signingRef.current = true;
    setSigning(true);
    try {
      const next = applySignin({
        wallet: currentWallet,
        check,
        price: currentQuote.market.close, // 按签到当时实时价入账
        nowISO: new Date().toISOString(),
      });
      await saveCoinWallet(next);
      walletRef.current = next;
      setWallet(next);
      return "签到成功，+" + check.reward + " HTC";
    } catch (e) {
      return "签到没成功：" + (e instanceof Error ? e.message : String(e));
    } finally {
      signingRef.current = false;
      setSigning(false);
    }
  }, [ensureHydrated]);

  return {
    loading,
    quote,
    cached,
    offline,
    error,
    wallet,
    signin,
    signing,
    refresh,
    sign,
  };
}
