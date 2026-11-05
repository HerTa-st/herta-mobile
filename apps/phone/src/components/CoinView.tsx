/**
 * 黑塔币行情页（全屏）。
 *
 * B7：**一套界面，两个账本**——
 *   - 昵称留空：本地账本（IndexedDB 钱包 + 本地签到 + 持仓）；
 *   - 填了昵称：共享市场（服务端账本、全服净买入推价、买卖、服务端签到、排行榜）。
 * 不再分两套 JSX；身份卡下面始终是同一组卡片，只是数据源不同。
 *
 * 行情/图表仍走 useCoin（/api/daily，30s；快讯随行情下发）；共享市场走 useMarket。
 * 样式一律在 styles/coin.css + styles.css 的「黑塔币」一节（coin- 前缀），这里不写内联 style。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from "react";
import "../styles/coin.css";
import {
  ACHIEVEMENTS,
  achievementProgress,
  formatAmount,
  formatHtc,
  formatPct,
  formatPrice,
  mergeAchievementIds,
  snapshotFromWallet,
} from "@herta/coin";
import type { AchievementSnapshot, CoinBar, CoinDailyResponse } from "@herta/coin";
import { COIN_CHART_THEME, COIN_CHART_THEME_DARK, barIndexOf, barTimeLabel, drawCoinChart } from "../coin/chart.ts";
import { useCoin } from "../coin/useCoin.ts";
import { useMarket } from "../coin/useMarket.ts";
import { saveCoinWallet } from "../coin/coin-storage.ts";
import { coinReminderState, enableCoinReminder } from "../coin/notify.ts";
import type { CoinReminderState } from "../coin/notify.ts";

export interface CoinViewProps {
  /** 行情接口基址；空串表示没配置（页面会显示「行情暂不可用」）。 */
  base: string;
  /** 共享市场昵称 / QQ 号；空串 = 单机模式。 */
  identity: string;
  /** 进入/退出共享市场（写回设置）。 */
  onIdentityChange(next: string): void;
  onClose(): void;
  /** 抽屉里那行涨跌幅要用；拿到/丢数据都通知一次。 */
  onQuoteChange?(quote: CoinDailyResponse | null): void;
}

/** 行情状态 → 徽标色调。文案直接用接口的 statusLabel。 */
const STATUS_TONE: Record<string, string> = {
  trading: "on",
  preopen: "warn",
  lunch: "warn",
  closed: "off",
  weekend: "off",
};

const STATUS_FALLBACK: Record<string, string> = {
  trading: "交易中",
  preopen: "盘前",
  lunch: "午休",
  closed: "已收盘",
  weekend: "休市",
};

const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_\-]{1,20}$/;

const NO_BARS: CoinBar[] = [];

/** 下拉多少像素触发刷新。 */
const PULL_TRIGGER = 46;

/** 单机钱包并进共享市场后置 1；本地账本就停用（只能合并一次）。 */
const COIN_MERGED_KEY = "herta.coin.merged.v1";
/** 下拉最多跟手多少像素。 */
const PULL_MAX = 72;

/** 界面上的签到卡片统一成这一份视图（本地 / 共享同一口径）。 */
interface SigninView {
  streak: number;
  canSign: boolean;
  signedToday: boolean;
  /** 下一次签到实际奖励（含 +5%）。 */
  nextReward: number;
  /** 下一次签到的连签加成百分比：0 或 5。 */
  bonusPct: number;
  daysToBonus: number;
  broken: boolean;
  message: string;
}

/** 涨跌方向：只在正负之外多一档「平」，红涨绿跌由 CSS 决定。 */
function toneOf(value: number): "up" | "down" | "flat" {
  if (value > 0.0001) return "up";
  if (value < -0.0001) return "down";
  return "flat";
}

function signedAmount(value: number): string {
  const text = formatAmount(Math.abs(value));
  return (value < 0 ? "-" : value > 0 ? "+" : "") + text;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 接口/服务端文案里偶尔还带着 USDT（老版本兼容）。B7 起界面一律叫「信用点」，
 * 但字段仍叫 usdt——所以只在显示层做这一层替换。
 */
function creditText(text: string): string {
  return text.replace(/USDT/g, "信用点");
}

export function CoinView({ base, identity, onIdentityChange, onClose, onQuoteChange }: CoinViewProps) {
  const coin = useCoin({ base, active: true });
  const { quote, wallet, signin, cached, offline, loading, error, signing } = coin;
  const marketMode = identity.trim().length > 0;
  const api = useMarket({ base, identity, active: marketMode });
  const server = api.state;
  const shared = marketMode ? server : null;

  /** 行情画布跟随 <html data-theme>；主题变了就重画。 */
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.dataset.theme === "dark");
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const daily = quote?.market ?? null;
  const bars = daily?.bars ?? NO_BARS;
  const prevClose = daily?.prevClose ?? 0;
  const hasBars = bars.length > 0;

  const displayMarket = shared?.market ?? daily ?? null;
  const price = shared ? shared.market.price : daily?.close ?? null;
  const changePct = shared ? shared.market.changePct : daily?.changePct ?? null;
  const badgeMessage = displayMarket
    ? displayMarket.statusLabel || STATUS_FALLBACK[displayMarket.status] || displayMarket.status
    : "";
  const badgeTone = displayMarket ? STATUS_TONE[displayMarket.status] ?? "off" : "off";

  // ---- 抽屉小字：行情一变就通知 app 一次 ----
  const quoteHandler = useRef(onQuoteChange);
  quoteHandler.current = onQuoteChange;
  useEffect(() => {
    quoteHandler.current?.(quote);
  }, [quote]);

  // ---- 共享市场昵称 ----
  const [nameDraft, setNameDraft] = useState(identity);
  const [identityNote, setIdentityNote] = useState<string | null>(null);
  useEffect(() => {
    setNameDraft(identity);
    // 换身份 = 换账本：上一个用户的提示不能留在新账本上
    setSignNote(null);
    setMarketNote(null);
    setClaimNote(null);
    setIdentityNote(null);
  }, [identity]);

  const handleEnterMarket = () => {
    const next = nameDraft.trim();
    if (!next) {
      setIdentityNote("先填个昵称或 QQ 号");
      return;
    }
    if (!NAME_RE.test(next)) {
      setIdentityNote("昵称只能包含中文、字母、数字、下划线、短横线，1~20 字");
      return;
    }
    setIdentityNote(null);
    onIdentityChange(next);
  };

  const handleLeaveMarket = () => {
    setIdentityNote(null);
    onIdentityChange("");
  };

  // ---- 画布 ----
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartSectionRef = useRef<HTMLElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);
  const hoverBar = hover !== null && hover >= 0 && hover < bars.length ? bars[hover] : null;

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawCoinChart(ctx, {
      width,
      height,
      dpr,
      bars,
      prevClose,
      hover: hover !== null && hover >= 0 && hover < bars.length ? hover : null,
      theme: dark ? COIN_CHART_THEME_DARK : COIN_CHART_THEME,
    });
  }, [bars, prevClose, hover, dark]);

  const paintRef = useRef(paint);
  paintRef.current = paint;

  useEffect(() => {
    paintRef.current();
    const wrap = wrapRef.current;
    let observer: ResizeObserver | null = null;
    if (wrap && typeof ResizeObserver === "function") {
      observer = new ResizeObserver(() => paintRef.current());
      observer.observe(wrap);
    }
    const onResize = () => paintRef.current();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  useEffect(() => {
    paint();
  }, [paint]);

  const hitTest = useCallback(
    (clientX: number, clientY: number): number | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return barIndexOf(clientX - rect.left, rect.width, rect.height, bars.length);
    },
    [bars.length]
  );

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    dragging.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 老 WebView 不支持 pointer capture 也能拖动，只是手指移出 canvas 后会断。
    }
    setHover(hitTest(e.clientX, e.clientY));
  };
  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return;
    const index = hitTest(e.clientX, e.clientY);
    if (index !== null) setHover(index);
  };
  const handlePointerEnd = () => {
    dragging.current = false;
  };

  /** 点快讯 → 定位到对应的分钟 K（十字光标落在那一根，并把它滚到屏幕中间）。 */
  const focusBar = (bar: number) => {
    if (!bars.length) return;
    setHover(Math.max(0, Math.min(bar, bars.length - 1)));
    chartSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // ---- 开盘提醒 ----
  const [reminder, setReminder] = useState<CoinReminderState | null>(null);
  const [reminderNote, setReminderNote] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    coinReminderState()
      .then((state) => {
        if (alive) setReminder(state);
      })
      .catch(() => {
        // 拿不到权限状态就按「没开」处理，不挡行情页。
      });
    return () => {
      alive = false;
    };
  }, []);
  const handleEnableReminder = () => {
    void enableCoinReminder()
      .then((state) => {
        setReminder(state);
        if (state.permission === "unsupported") {
          setReminderNote("这个环境发不了系统通知；装到手机上再开。");
        } else if (state.permission !== "granted") {
          setReminderNote("没拿到通知权限，去系统设置里允许 Herta 通知。");
        } else {
          setReminderNote(null);
        }
      })
      .catch(() => setReminderNote("开启失败，回头再试试。"));
  };

  // ---- 下拉刷新 ----
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pullStart = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const coinRefresh = coin.refresh;
  const apiRefresh = api.refresh;

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await coinRefresh();
      if (marketMode) await apiRefresh();
    } finally {
      setRefreshing(false);
    }
  }, [coinRefresh, apiRefresh, marketMode]);

  const handleTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (el && el.scrollTop <= 0) {
      pullStart.current = e.touches[0]?.clientY ?? null;
    } else {
      pullStart.current = null;
    }
  };
  const handleTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (pullStart.current === null) return;
    const y = e.touches[0]?.clientY;
    if (y === undefined) return;
    const dy = y - pullStart.current;
    if (dy <= 0) {
      setPull(0);
      return;
    }
    setPull(Math.min(PULL_MAX, dy * 0.55));
  };
  const handleTouchEnd = () => {
    const trigger = pull >= PULL_TRIGGER;
    pullStart.current = null;
    setPull(0);
    if (trigger && !refreshing) void refreshAll();
  };

  // ---- 签到（本地 / 共享同一套按钮） ----
  const [signNote, setSignNote] = useState<string | null>(null);
  const signinView: SigninView | null = shared
    ? {
        streak: shared.user.signin.streak,
        canSign: shared.user.signin.canSign && !api.offline,
        signedToday: shared.user.signin.signedToday,
        nextReward: shared.user.signin.nextReward,
        bonusPct: shared.user.signin.bonusPct,
        daysToBonus: shared.user.signin.daysToBonus,
        broken: shared.user.signin.broken,
        message: shared.user.signin.signedToday
          ? "今日已签到 · 连续 " + shared.user.signin.streak + " 天"
          : shared.user.signin.streak > 0
            ? "连续签到 " + shared.user.signin.streak + " 天 · 下次 +" + formatHtc(shared.user.signin.nextReward) + " HTC"
            : "还没开始 · 今天签到 +" + formatHtc(shared.user.signin.nextReward) + " HTC",
      }
    : signin
      ? {
          streak: signin.currentStreak,
          canSign: signin.canSign && !offline,
          signedToday: signin.reason === "already",
          nextReward: signin.reward,
          bonusPct: signin.bonusPct,
          daysToBonus: signin.daysToBonus,
          broken: signin.broken,
          message: signin.message,
        }
      : null;

  const handleSignin = () => {
    setSignNote(null);
    void (async () => {
      try {
        const note = shared ? await api.signin() : await coin.sign();
        setSignNote(creditText(note));
      } catch (err) {
        setSignNote("签到没成功：" + errorText(err));
      }
    })();
  };

  // ---- 共享市场操作 ----
  const [marketNote, setMarketNote] = useState<string | null>(null);
  const [claimNote, setClaimNote] = useState<string | null>(null);
  const [tradeAmount, setTradeAmount] = useState("100");
  // 合并后本地钱包已清零，但 useCoin 里的 wallet 还是旧对象；界面上先按 0 显示。
  // 落一个 localStorage 标记，重开 app 也不会把已停用的单机账本又放出来。
  const [localMerged, setLocalMerged] = useState(() => {
    try {
      return localStorage.getItem(COIN_MERGED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const handleTrade = (side: "buy" | "sell") => {
    const amount = Number(tradeAmount);
    if (!Number.isInteger(amount) || amount <= 0) {
      setMarketNote("数量要填正整数");
      return;
    }
    setMarketNote(null);
    void (async () => {
      try {
        setMarketNote(creditText(await api.trade(side, amount)));
      } catch (err) {
        setMarketNote("交易没成功：" + errorText(err));
      }
    })();
  };

  const handleClaim = () => {
    const localHtc = Math.max(0, Math.floor(wallet?.holdings ?? 0));
    setClaimNote(null);
    void (async () => {
      try {
        setClaimNote(creditText(await api.claim(localHtc)));
        setLocalMerged(true);
        try {
          localStorage.setItem(COIN_MERGED_KEY, "1");
        } catch {
          // 隐私模式/存储满：本次会话仍然停用，只是重开后会忘
        }
        if (wallet) {
          await saveCoinWallet({ ...wallet, holdings: 0, updatedAt: new Date().toISOString() });
        }
      } catch (err) {
        setClaimNote("合并没成功：" + errorText(err));
      }
    })();
  };

  // ---- 成就：本地实时判定 + 已解锁落库；共享以服务端返回为准 ----
  const localSnapshot = useMemo<AchievementSnapshot | null>(() => {
    if (marketMode || !wallet || !daily) return null;
    return snapshotFromWallet(wallet, daily.close);
  }, [marketMode, wallet, daily]);

  const localUnlocked = useMemo(() => {
    if (!wallet) return [] as string[];
    if (!localSnapshot) return wallet.achievements ?? [];
    return mergeAchievementIds(wallet.achievements, localSnapshot);
  }, [wallet, localSnapshot]);

  const savedAchRef = useRef("");
  useEffect(() => {
    if (marketMode || !wallet || !localSnapshot) return;
    const merged = mergeAchievementIds(wallet.achievements, localSnapshot);
    const walletKey = (wallet.achievements ?? []).join(",");
    const mergedKey = merged.join(",");
    if (mergedKey === walletKey || mergedKey === savedAchRef.current) return;
    savedAchRef.current = mergedKey;
    void saveCoinWallet({ ...wallet, achievements: merged, updatedAt: new Date().toISOString() }).catch(
      () => undefined
    );
  }, [marketMode, wallet, localSnapshot]);

  const serverSnapshot = useMemo<AchievementSnapshot | null>(() => {
    if (!server) return null;
    const user = server.user;
    return {
      ...user.achievementStats,
      netWorth: user.value,
      htc: user.htc,
      usdt: user.usdt,
      merged: user.merged,
      bankruptCount: user.bankruptCount,
    };
  }, [server]);

  const achievementsSnapshot = shared ? serverSnapshot : localSnapshot;
  const unlockedIds = shared ? shared.user.achievements : localUnlocked;
  const unlockedSet = new Set(unlockedIds);

  // ---- 单机持仓 ----
  const localHoldings = localMerged ? 0 : wallet?.holdings ?? null;
  const localMarketValue = localHoldings !== null && daily ? localHoldings * daily.close : null;
  const localPnl = daily && localHoldings !== null ? localHoldings * (daily.close - daily.prevClose) : null;
  const localPnlPct = daily?.changePct ?? null;

  const bonusLine = signinView
    ? signinView.streak >= 7
      ? "已享连签 +5%"
      : signinView.daysToBonus > 0
        ? "连签 7 天起 +5% · 还差 " + signinView.daysToBonus + " 天"
        : "下次签到起 +5%"
    : "";

  const renderChart = () => (
    <section className="coinCard coinChartCard" aria-label="分钟 K 图" ref={chartSectionRef}>
      <div className="coinChartWrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="coinCanvas"
          role="img"
          aria-label="分钟 K 线图，长按或拖动查看单根"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onContextMenu={(e) => e.preventDefault()}
        />
        {hoverBar && (
          <div className="coinOhlc">
            <span className="coinOhlcTime">{barTimeLabel(hoverBar.t)}</span>
            <span className="coinOhlcItem">
              开<b>{formatPrice(hoverBar.o)}</b>
            </span>
            <span className="coinOhlcItem">
              高<b>{formatPrice(hoverBar.h)}</b>
            </span>
            <span className="coinOhlcItem">
              低<b>{formatPrice(hoverBar.l)}</b>
            </span>
            <span className="coinOhlcItem">
              收<b className={toneOf(hoverBar.c - hoverBar.o)}>{formatPrice(hoverBar.c)}</b>
            </span>
            <span className="coinOhlcItem">
              量<b>{formatAmount(hoverBar.v)}</b>
            </span>
            <button
              type="button"
              className="coinOhlcClose"
              onClick={() => setHover(null)}
              aria-label="收起十字光标"
            >
              ✕
            </button>
          </div>
        )}
        {!hasBars && <p className="coinChartEmpty">开盘后才有分钟 K</p>}
      </div>
      <div className="coinLegend" aria-hidden="true">
        <span className="coinLegendItem ma5">MA5</span>
        <span className="coinLegendItem ma10">MA10</span>
        <span className="coinLegendItem ma20">MA20</span>
        <span className="coinLegendItem vwap">均价</span>
        <span className="coinLegendItem prev">昨收</span>
        <span className="coinLegendHint">{hoverBar ? "拖动看单根" : "长按/拖动看单根"}</span>
      </div>
    </section>
  );

  const renderIdentity = () => (
    <section className="coinCard coinIdentityCard" aria-label="身份与账本">
      <h2 className="coinCardTitle">身份 · 账本</h2>
      {marketMode ? (
        <div className="coinIdentityRow">
          <span className="coinIdentityName">{identity}</span>
          <span className="coinIdentityTag">共享市场</span>
          <button type="button" className="coinLinkBtn" onClick={handleLeaveMarket}>
            退出
          </button>
        </div>
      ) : (
        <>
          <div className="coinIdentityForm">
            <input
              className="coinIdentityInput"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="昵称 / QQ 号"
              maxLength={20}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleEnterMarket();
              }}
            />
            <button type="button" className="coinBtn coinBtnPrimary" onClick={handleEnterMarket}>
              进入
            </button>
          </div>
          <p className="coinCardNote">
            留空 = 单机本地账本（行情 / 签到 / 持仓）；填昵称 = 共享市场（大家买卖一起推价，收支记信用点）。
          </p>
        </>
      )}
      {identityNote && <p className="coinSignNote">{identityNote}</p>}
    </section>
  );

  const renderPriceBar = () => {
    if (!displayMarket) return null;
    const tone = toneOf(changePct ?? 0);
    return (
      <section className="coinPriceBar" aria-label="行情">
        <div className="coinPriceTop">
          <span className={"coinLast " + tone}>{price === null ? "—" : formatPrice(price)}</span>
          <span className={"coinChange " + tone}>{changePct === null ? "—" : formatPct(changePct)}</span>
          <span className="coinUnit">信用点</span>
          <span className="coinIdentityTag">永续</span>
        </div>
        <dl className="coinStats">
          <div>
            <dt>今开</dt>
            <dd>{formatPrice(displayMarket.open)}</dd>
          </div>
          <div>
            <dt>最高</dt>
            <dd>{formatPrice(displayMarket.high)}</dd>
          </div>
          <div>
            <dt>最低</dt>
            <dd>{formatPrice(displayMarket.low)}</dd>
          </div>
          {shared ? (
            <div>
              <dt>净买入</dt>
              <dd>{signedAmount(shared.market.netBuy)} HTC</dd>
            </div>
          ) : (
            <div>
              <dt>成交量</dt>
              <dd>{formatAmount(displayMarket.volume)}</dd>
            </div>
          )}
        </dl>
        <p className="coinSrc">
          {shared
            ? "共享价 · 冲击 " +
              (shared.market.impactPct >= 0 ? "+" : "") +
              shared.market.impactPct.toFixed(2) +
              "% · 基准 " +
              formatPrice(shared.market.basePrice)
            : "行情与网页同源 · 30s 刷新"}
        </p>
        <p className="coinSrc">交易时段 · 工作日 09:30–11:30 / 13:00–15:00</p>
      </section>
    );
  };

  const renderNews = () => {
    if (!daily) return null;
    const feed = quote?.news;
    const items = feed?.items ?? [];
    return (
      <details className="coinCard" aria-label="行情快讯">
        <summary className="coinCardTitle">
          快讯 {items.length}/{feed?.total ?? 0} 条 · 虚构
        </summary>
        {items.length === 0 ? (
          <p className="coinCardNote">开盘后快讯会按盘中时间逐条解锁。</p>
        ) : (
          <ul className="coinLeaderList">
            {items.map((item) => (
              <li
                key={item.bar + "-" + item.text}
                role="button"
                tabIndex={0}
                title="点击定位到这一分钟的 K 线"
                onClick={() => focusBar(item.bar)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    focusBar(item.bar);
                  }
                }}
              >
                <span className="coinLeaderRank">{item.time}</span>
                <span className={"coinChange " + item.dir}>
                  {item.tag}
                  {"●".repeat(item.strength)}
                </span>
                <span className="coinLeaderName">{item.text}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="coinCardNote">点一条，K 线会定位到它冲击的那一分钟；快讯由服务端随行情下发。</p>
      </details>
    );
  };

  const renderPosition = () => {
    const htcValue = shared ? shared.user.htc : localHoldings;
    const usdtValue = shared ? shared.user.usdt : null;
    const netWorth = shared ? shared.user.value : localMarketValue;
    const cost = shared ? shared.user.cost : wallet?.costPrice ?? null;
    return (
      <section className="coinCard coinPosCard" aria-label={shared ? "共享市场账户" : "我的持仓"}>
        <h2 className="coinCardTitle">{shared ? "我的共享市场账户" : "我的持仓（本地账本）"}</h2>
        {marketMode && !shared ? (
          <p className="coinCardNote">
            {api.loading ? "正在连接共享市场…" : "共享市场连不上：" + (api.error || "稍后再试。")}
          </p>
        ) : htcValue === null ? (
          <p className="coinCardNote">还没激活钱包——拿到第一笔行情就送 1000 HTC。</p>
        ) : (
          <dl className="coinPosGrid">
            <div>
              <dt>持有</dt>
              <dd>{formatHtc(htcValue)} HTC</dd>
            </div>
            <div>
              <dt>信用点</dt>
              <dd>{usdtValue === null ? "—（本地账本）" : formatAmount(usdtValue)}</dd>
            </div>
            <div>
              <dt>净资产</dt>
              <dd>{netWorth === null ? "--" : formatAmount(netWorth) + " 信用点"}</dd>
            </div>
            <div>
              <dt>成本价</dt>
              <dd>{cost === null ? "--" : formatPrice(cost)}</dd>
            </div>
            {shared ? (
              <>
                <div>
                  <dt>今日买入</dt>
                  <dd>
                    {shared.user.todayBuy}/{shared.limits.buyPerDay} 次
                  </dd>
                </div>
                <div>
                  <dt>今日卖出</dt>
                  <dd>
                    {shared.user.todaySell}/{shared.limits.sellPerDay} 次
                  </dd>
                </div>
              </>
            ) : (
              <>
                <div>
                  <dt>今日盈亏</dt>
                  <dd className={localPnl === null ? "" : toneOf(localPnl)}>
                    {localPnl === null ? "--" : signedAmount(localPnl) + " 信用点"}
                    {localPnl !== null && localPnlPct !== null && (
                      <em className="coinPosPct">{formatPct(localPnlPct)}</em>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>已连签</dt>
                  <dd>{signinView?.streak ?? 0} 天</dd>
                </div>
              </>
            )}
          </dl>
        )}
      </section>
    );
  };

  const renderSignin = () => {
    const busy = shared ? api.busy : signing;
    const isOffline = shared ? api.offline : offline;
    if (!shared && localMerged) {
      return (
        <section className="coinCard coinSignCard" aria-label="签到">
          <h2 className="coinCardTitle">签到</h2>
          <p className="coinCardNote">单机钱包已并入共享市场，本地签到停用；进共享市场再签。</p>
        </section>
      );
    }
    return (
      <section className="coinCard coinSignCard" aria-label="签到">
        <h2 className="coinCardTitle">签到</h2>
        {marketMode && !shared ? (
          <p className="coinCardNote">连上共享市场后才能签到；本地签到只在昵称留空时用。</p>
        ) : signinView ? (
          <>
            <p className="coinSignMsg">{signinView.message}</p>
            <p className="coinSignNext">
              {bonusLine}
              {signinView.canSign && signinView.bonusPct > 0 ? " · 本次 +5%" : ""}
            </p>
            {signinView.broken && (
              <p className="coinSignOffline">断签了，连续天数已归零；今天重新从第 1 天算起。</p>
            )}
            {signinView.canSign ? (
              <button
                type="button"
                className="coinBtn coinBtnPrimary"
                onClick={handleSignin}
                disabled={busy || isOffline}
              >
                {busy
                  ? "签到中…"
                  : "签到 +" +
                    formatHtc(signinView.nextReward) +
                    " HTC" +
                    (signinView.bonusPct > 0 ? "（+5%）" : "")}
              </button>
            ) : signinView.signedToday ? (
              <p className="coinSignNext">
                明天签到 +{formatHtc(signinView.nextReward)} HTC
                {signinView.bonusPct > 0 ? "（含 +5%）" : ""}
              </p>
            ) : null}
            {isOffline && <p className="coinSignOffline">签到需要联网</p>}
            {signNote && <p className="coinSignNote">{signNote}</p>}
          </>
        ) : (
          <p className="coinCardNote">连上服务器才知道今天能不能签。</p>
        )}
      </section>
    );
  };

  const renderAchievements = () => {
    if (marketMode && !shared) return null;
    if (!shared && !wallet) return null;
    const unlockedTitles = ACHIEVEMENTS.filter((item) => unlockedSet.has(item.id)).map((item) => item.title);
    return (
      <details className="coinCard" aria-label="成就">
        <summary className="coinCardTitle">
          成就 {unlockedIds.length}/{ACHIEVEMENTS.length}
        </summary>
        {unlockedTitles.length > 0 && <p className="coinCardNote">已解锁：{unlockedTitles.join(" · ")}</p>}
        <ul className="coinLeaderList">
          {ACHIEVEMENTS.map((item) => {
            const progress = achievementsSnapshot
              ? achievementProgress(item.id, achievementsSnapshot)
              : { value: 0, target: item.target, unlocked: false, ratio: 0 };
            return (
              <li key={item.id} className={progress.unlocked ? "isMe" : undefined}>
                <span className="coinLeaderRank">{progress.unlocked ? "✓" : "○"}</span>
                <span className="coinLeaderName">
                  {item.title}
                  <em className="coinPosPct">{item.desc}</em>
                </span>
                <span className="coinLeaderValue">
                  {progress.unlocked
                    ? "已解锁"
                    : Math.min(Math.floor(progress.value), progress.target) + "/" + progress.target}
                </span>
              </li>
            );
          })}
        </ul>
      </details>
    );
  };

  const renderTrade = () => {
    if (marketMode && !shared) {
      return (
        <section className="coinCard coinTradeCard" aria-label="交易">
          <h2 className="coinCardTitle">交易</h2>
          <p className="coinCardNote">连上共享市场后才能交易。</p>
        </section>
      );
    }
    if (!shared) {
      return (
        <section className="coinCard coinTradeCard" aria-label="交易">
          <h2 className="coinCardTitle">交易</h2>
          <p className="coinCardNote">
            单机账本只有行情、签到与持仓。填昵称进入共享市场后就能买卖，HTC 与信用点都记在服务端。
          </p>
        </section>
      );
    }
    const limits = shared.limits;
    const user = shared.user;
    const amount = Number(tradeAmount);
    const amountOk = Number.isInteger(amount) && amount > 0 && amount <= limits.maxOrder;
    const canTrade = shared.market.status === "trading" && !api.busy && !api.offline;
    const canBuy = canTrade && amountOk && user.todayBuy < limits.buyPerDay;
    const canSell = canTrade && amountOk && user.todaySell < limits.sellPerDay;
    const estFee = amountOk ? amount * shared.market.price * limits.feeRate : 0;
    const estCost = amountOk ? amount * shared.market.price + estFee : 0;
    return (
      <section className="coinCard coinTradeCard" aria-label="交易">
        <h2 className="coinCardTitle">交易</h2>
        <p className="coinCardNote">
          市价成交 · 手续费 {(limits.feeRate * 100).toFixed(1)}% · 同一昵称{" "}
          {(limits.cooldownMs / 1000).toFixed(0)} 秒一单 · 单笔最多 {limits.maxOrder} HTC
        </p>
        <div className="coinTradeRow">
          <input
            className="coinTradeInput"
            type="number"
            inputMode="numeric"
            min={1}
            max={limits.maxOrder}
            value={tradeAmount}
            onChange={(e) => setTradeAmount(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <span className="coinTradeUnit">HTC</span>
        </div>
        <p className="coinTradePreview">
          预计金额 {formatAmount(estCost)} 信用点（含手续费 {estFee.toFixed(2)} 信用点）
        </p>
        <div className="coinTradeBtns">
          <button type="button" className="coinBtn coinBtnBuy" onClick={() => handleTrade("buy")} disabled={!canBuy}>
            买入
          </button>
          <button type="button" className="coinBtn coinBtnSell" onClick={() => handleTrade("sell")} disabled={!canSell}>
            卖出
          </button>
        </div>
        {shared.market.status !== "trading" && (
          <p className="coinSignOffline">休市时间不能交易（工作日 09:30–11:30 / 13:00–15:00）</p>
        )}
        {marketNote && <p className="coinSignNote">{marketNote}</p>}
      </section>
    );
  };

  const renderLeaderboard = () => (
    <section className="coinCard coinLeaderCard" aria-label="排行榜">
      <h2 className="coinCardTitle">排行榜 · 净资产</h2>
      {shared ? (
        shared.leaderboard.length === 0 ? (
          <p className="coinCardNote">还没有人上榜。</p>
        ) : (
          <ol className="coinLeaderList">
            {shared.leaderboard.map((row) => (
              <li key={row.name} className={row.name === identity ? "isMe" : undefined}>
                <span className="coinLeaderRank">{row.rank}</span>
                <span className="coinLeaderName">{row.name}</span>
                <span className="coinLeaderValue">{formatAmount(row.value)} 信用点</span>
              </li>
            ))}
          </ol>
        )
      ) : (
        <p className="coinCardNote">填昵称进入共享市场后才有排行榜。</p>
      )}
    </section>
  );

  const renderMerge = () => {
    if (!shared) return null;
    if (shared.user.merged) {
      // 合并成功后卡片要收起来，但「并了多少」得留一句，不然像什么都没发生
      return claimNote ? <p className="coinCardNote">{claimNote}</p> : null;
    }
    return (
      <section className="coinCard coinMergeCard" aria-label="合并单机钱包">
        <h2 className="coinCardTitle">合并单机钱包</h2>
        <p className="coinCardNote">
          本地还有 {formatHtc(localHoldings ?? 0)} HTC。合并进共享市场后单机钱包就停用（只能合并一次）。
        </p>
        <button type="button" className="coinBtn coinBtnPrimary" onClick={handleClaim} disabled={api.busy}>
          {api.busy ? "合并中…" : "并入共享市场"}
        </button>
        {claimNote && <p className="coinSignNote">{claimNote}</p>}
      </section>
    );
  };

  const renderReminder = () => (
    <>
      {reminder && reminder.permission === "granted" && reminder.enabled ? (
        <p className="coinReminderOn">开盘提醒已开 · 工作日 09:30</p>
      ) : reminder ? (
        <div className="coinReminderRow">
          <span>开盘提醒未开启</span>
          <button type="button" className="coinReminderBtn" onClick={handleEnableReminder}>
            开启
          </button>
        </div>
      ) : null}
      {reminderNote && <p className="coinReminderNote">{reminderNote}</p>}
    </>
  );

  return (
    <div className="coinView" role="dialog" aria-label="黑塔币行情">
      <header className="coinHead">
        <button className="coinBack" type="button" onClick={onClose} aria-label="返回聊天">
          ←
        </button>
        <span className="coinTitle">黑塔币 · HTC/信用点</span>
        {displayMarket && <span className={"coinBadge " + badgeTone}>{badgeMessage}</span>}
        {marketMode ? (
          api.offline && <span className="coinOffline">离线</span>
        ) : (
          offline && <span className="coinOffline">离线</span>
        )}
      </header>

      <div
        className="coinScroll"
        ref={scrollRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {(pull > 0 || refreshing) && (
          <div className="coinOfflineBar" role="status">
            <span>{refreshing ? "刷新中…" : pull >= PULL_TRIGGER ? "松开刷新" : "下拉刷新"}</span>
          </div>
        )}

        {renderIdentity()}

        {marketMode && !shared && !daily ? (
          <div className="coinEmpty" role="alert">
            <p className="coinEmptyTitle">{api.loading ? "正在连接共享市场…" : "共享市场连不上"}</p>
            <p className="coinEmptyNote">{api.error || "检查接口地址和网络，或者换个昵称试试。"}</p>
            <button type="button" className="coinBtn" onClick={() => void api.refresh()} disabled={api.loading}>
              {api.loading ? "正在连…" : "重试"}
            </button>
          </div>
        ) : displayMarket ? (
          renderPriceBar()
        ) : loading ? (
          <p className="coinLoading">正在拉行情…</p>
        ) : (
          <div className="coinEmpty" role="alert">
            <p className="coinEmptyTitle">行情暂不可用</p>
            <p className="coinEmptyNote">
              {error || (offline ? "连不上行情接口，先看看设置里的接口地址。" : "稍后再试。")}
            </p>
            <button type="button" className="coinBtn" onClick={() => void coin.refresh()} disabled={loading}>
              {loading ? "正在拉…" : "重试"}
            </button>
          </div>
        )}

        {(offline || cached) && !shared && displayMarket && (
          <div className="coinOfflineBar" role="status">
            <span>{offline ? "离线 · 显示上次缓存" : "缓存行情"}</span>
            <button type="button" onClick={() => void coin.refresh()} disabled={loading}>
              {loading ? "刷新中…" : "重试"}
            </button>
          </div>
        )}

        {shared && api.offline && (
          <div className="coinOfflineBar" role="status">
            <span>离线 · 显示上次状态</span>
            <button type="button" onClick={() => void api.refresh()} disabled={api.loading}>
              {api.loading ? "刷新中…" : "重试"}
            </button>
          </div>
        )}

        {daily && renderChart()}
        {daily && renderNews()}
        {renderPosition()}
        {renderSignin()}
        {renderAchievements()}
        {renderTrade()}
        {renderLeaderboard()}
        {renderMerge()}
        {renderReminder()}

        <p className="coinReminderNote">
          行情、快讯与全部数据均为程序生成的虚构内容，仅用于娱乐与演示，不构成任何投资建议。
        </p>
      </div>
    </div>
  );
}
