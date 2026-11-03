/**
 * 黑塔币行情页（全屏）。
 *
 * 两种模式：
 *   - 单机（没填昵称）：行情 + 本地钱包 + 本地签到（v1 行为）；
 *   - 共享市场（填了昵称）：服务端账本、全服净买入推价、买卖、服务端签到、排行榜。
 *
 * 行情/图表仍走 useCoin（/api/daily，30s）；共享市场走 useMarket（/api/state，30s）。
 * 样式一律在 styles.css 末尾「黑塔币」一节（coin- 前缀），这里不写内联 style。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import "../styles/coin.css";
import { formatAmount, formatPct, formatPrice, rewardForStreak } from "@herta/coin";
import type { CoinBar, CoinDailyResponse } from "@herta/coin";
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

export function CoinView({ base, identity, onIdentityChange, onClose, onQuoteChange }: CoinViewProps) {
  const coin = useCoin({ base, active: true });
  const { quote, wallet, signin, cached, offline, loading, error, signing } = coin;
  const marketMode = identity.trim().length > 0;
  const api = useMarket({ base, identity, active: marketMode });
  const server = api.state;

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

  const displayMarket = marketMode ? server?.market ?? null : daily;
  const price = marketMode ? server?.market.price ?? null : daily?.close ?? null;
  const changePct = marketMode ? server?.market.changePct ?? null : daily?.changePct ?? null;
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

  // ---- 单机签到 ----
  const [signNote, setSignNote] = useState<string | null>(null);
  const handleSign = () => {
    void (async () => {
      try {
        setSignNote(await coin.sign());
      } catch (err) {
        setSignNote("签到没成功：" + errorText(err));
      }
    })();
  };

  // ---- 共享市场操作 ----
  const [marketNote, setMarketNote] = useState<string | null>(null);
  const [claimNote, setClaimNote] = useState<string | null>(null);
  const [tradeAmount, setTradeAmount] = useState("100");

  const handleMarketSignin = () => {
    void (async () => {
      try {
        setMarketNote(await api.signin());
      } catch (err) {
        setMarketNote("签到没成功：" + errorText(err));
      }
    })();
  };

  const handleTrade = (side: "buy" | "sell") => {
    const amount = Number(tradeAmount);
    if (!Number.isInteger(amount) || amount <= 0) {
      setMarketNote("数量要填正整数");
      return;
    }
    void (async () => {
      try {
        setMarketNote(await api.trade(side, amount));
      } catch (err) {
        setMarketNote("交易没成功：" + errorText(err));
      }
    })();
  };

  const handleClaim = () => {
    const localHtc = Math.max(0, Math.floor(wallet?.holdings ?? 0));
    void (async () => {
      try {
        setClaimNote(await api.claim(localHtc));
        if (wallet) {
          await saveCoinWallet({ ...wallet, holdings: 0, updatedAt: new Date().toISOString() });
        }
      } catch (err) {
        setClaimNote("合并没成功：" + errorText(err));
      }
    })();
  };

  // ---- 单机持仓 ----
  const marketValue = wallet && daily ? wallet.holdings * daily.close : null;
  const pnl = daily && wallet ? wallet.holdings * (daily.close - daily.prevClose) : null;
  const pnlPct = daily?.changePct ?? null;
  const costPrice = wallet?.costPrice ?? null;

  const signReward = signin ? `签到 +${signin.reward} HTC` : "签到";

  const renderChart = () => (
    <section className="coinCard coinChartCard" aria-label="分钟 K 图">
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
    <section className="coinCard coinIdentityCard" aria-label="共享市场">
      <h2 className="coinCardTitle">共享市场</h2>
      {marketMode ? (
        <div className="coinIdentityRow">
          <span className="coinIdentityName">{identity}</span>
          <span className="coinIdentityTag">已进入</span>
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
            填昵称就进共享市场：大家的买卖一起推动价格。留空 = 单机模式（本地钱包 + 本地签到）。
          </p>
        </>
      )}
      {identityNote && <p className="coinSignNote">{identityNote}</p>}
    </section>
  );

  const renderMarket = () => {
    if (!server) {
      return (
        <div className="coinEmpty" role="alert">
          <p className="coinEmptyTitle">{api.loading ? "正在连接共享市场…" : "共享市场连不上"}</p>
          <p className="coinEmptyNote">{api.error || "检查接口地址和网络，或者换个昵称试试。"}</p>
          <button type="button" className="coinBtn" onClick={() => void api.refresh()} disabled={api.loading}>
            {api.loading ? "正在连…" : "重试"}
          </button>
        </div>
      );
    }
    const limits = server.limits;
    const user = server.user;
    const amount = Number(tradeAmount);
    const amountOk = Number.isInteger(amount) && amount > 0 && amount <= limits.maxOrder;
    const canTrade = server.market.status === "trading" && !api.busy && !api.offline;
    const canBuy = canTrade && amountOk && user.todayBuy < limits.buyPerDay;
    const canSell = canTrade && amountOk && user.todaySell < limits.sellPerDay;
    const estFee = amountOk ? amount * server.market.price * limits.feeRate : 0;
    const estCost = amountOk ? amount * server.market.price + estFee : 0;

    return (
      <>
        <section className="coinPriceBar" aria-label="共享市场行情">
          <div className="coinPriceTop">
            <span className={"coinLast " + toneOf(server.market.changePct)}>{formatPrice(server.market.price)}</span>
            <span className={"coinChange " + toneOf(server.market.changePct)}>{formatPct(server.market.changePct)}</span>
            <span className="coinUnit">USDT</span>
          </div>
          <dl className="coinStats">
            <div>
              <dt>今开</dt>
              <dd>{formatPrice(server.market.open)}</dd>
            </div>
            <div>
              <dt>最高</dt>
              <dd>{formatPrice(server.market.high)}</dd>
            </div>
            <div>
              <dt>最低</dt>
              <dd>{formatPrice(server.market.low)}</dd>
            </div>
            <div>
              <dt>净买入</dt>
              <dd>{signedAmount(server.market.netBuy)} HTC</dd>
            </div>
          </dl>
          <p className="coinSrc">
            共享价 · 冲击 {server.market.impactPct >= 0 ? "+" : ""}
            {server.market.impactPct.toFixed(2)}% · 基准 {formatPrice(server.market.basePrice)}
          </p>
        </section>

        {api.offline && (
          <div className="coinOfflineBar" role="status">
            <span>离线 · 显示上次状态</span>
            <button type="button" onClick={() => void api.refresh()} disabled={api.loading}>
              {api.loading ? "刷新中…" : "重试"}
            </button>
          </div>
        )}

        {daily && renderChart()}

        {!user.merged && (
          <section className="coinCard coinMergeCard" aria-label="合并单机钱包">
            <h2 className="coinCardTitle">合并单机钱包</h2>
            <p className="coinCardNote">
              本地还有 {formatAmount(wallet?.holdings ?? 0)} HTC。合并进共享市场后单机钱包就停用（只能合并一次）。
            </p>
            <button type="button" className="coinBtn coinBtnPrimary" onClick={handleClaim} disabled={api.busy}>
              {api.busy ? "合并中…" : "并入共享市场"}
            </button>
            {claimNote && <p className="coinSignNote">{claimNote}</p>}
          </section>
        )}

        <section className="coinCard coinPosCard" aria-label="共享市场账户">
          <h2 className="coinCardTitle">我的共享市场账户</h2>
          <dl className="coinPosGrid">
            <div>
              <dt>持有</dt>
              <dd>{formatAmount(user.htc)} HTC</dd>
            </div>
            <div>
              <dt>USDT</dt>
              <dd>{formatAmount(user.usdt)}</dd>
            </div>
            <div>
              <dt>总市值</dt>
              <dd>{formatAmount(user.value)} USDT</dd>
            </div>
            <div>
              <dt>成本价</dt>
              <dd>{formatPrice(user.cost)}</dd>
            </div>
            <div>
              <dt>今日买入</dt>
              <dd>
                {user.todayBuy}/{limits.buyPerDay} 次
              </dd>
            </div>
            <div>
              <dt>今日卖出</dt>
              <dd>
                {user.todaySell}/{limits.sellPerDay} 次
              </dd>
            </div>
          </dl>
        </section>

        <section className="coinCard coinSignCard" aria-label="签到">
          <h2 className="coinCardTitle">签到</h2>
          <p className="coinSignMsg">
            连签 {user.signin.streak} 天 · {user.signin.signedToday ? "今天已签" : "下次 +" + user.signin.nextReward + " HTC"}
          </p>
          {user.signin.canSign ? (
            <button type="button" className="coinBtn coinBtnPrimary" onClick={handleMarketSignin} disabled={api.busy || api.offline}>
              {api.busy ? "签到中…" : "签到 +" + user.signin.nextReward + " HTC"}
            </button>
          ) : user.signin.signedToday ? (
            <p className="coinSignNext">明天签到 +{user.signin.nextReward} HTC</p>
          ) : (
            <p className="coinSignNext">{badgeMessage}，暂时不能签</p>
          )}
          {marketNote && <p className="coinSignNote">{marketNote}</p>}
        </section>

        <section className="coinCard coinTradeCard" aria-label="交易">
          <h2 className="coinCardTitle">交易</h2>
          <p className="coinCardNote">
            市价成交 · 手续费 {(limits.feeRate * 100).toFixed(1)}% · 同一昵称 {(limits.cooldownMs / 1000).toFixed(0)} 秒一单 · 单笔最多{" "}
            {limits.maxOrder} HTC
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
            预计金额 {formatAmount(estCost)} USDT（含手续费 {estFee.toFixed(2)} USDT）
          </p>
          <div className="coinTradeBtns">
            <button type="button" className="coinBtn coinBtnBuy" onClick={() => handleTrade("buy")} disabled={!canBuy}>
              买入
            </button>
            <button type="button" className="coinBtn coinBtnSell" onClick={() => handleTrade("sell")} disabled={!canSell}>
              卖出
            </button>
          </div>
          {server.market.status !== "trading" && <p className="coinSignOffline">休市时间不能交易（工作日 09:30–11:30 / 13:00–15:00）</p>}
          {marketNote && <p className="coinSignNote">{marketNote}</p>}
        </section>

        <section className="coinCard coinLeaderCard" aria-label="排行榜">
          <h2 className="coinCardTitle">排行榜 · 持仓市值</h2>
          {server.leaderboard.length === 0 ? (
            <p className="coinCardNote">还没有人上榜。</p>
          ) : (
            <ol className="coinLeaderList">
              {server.leaderboard.map((row) => (
                <li key={row.name} className={row.name === identity ? "isMe" : undefined}>
                  <span className="coinLeaderRank">{row.rank}</span>
                  <span className="coinLeaderName">{row.name}</span>
                  <span className="coinLeaderValue">{formatAmount(row.value)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

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
  };

  return (
    <div className="coinView" role="dialog" aria-label="黑塔币行情">
      <header className="coinHead">
        <button className="coinBack" type="button" onClick={onClose} aria-label="返回聊天">
          ←
        </button>
        <span className="coinTitle">黑塔币 · HTC/USDT</span>
        {displayMarket && <span className={"coinBadge " + badgeTone}>{badgeMessage}</span>}
        {marketMode ? (
          api.offline && <span className="coinOffline">离线</span>
        ) : (
          offline && <span className="coinOffline">离线</span>
        )}
      </header>

      <div className="coinScroll">
        {renderIdentity()}

        {marketMode ? (
          renderMarket()
        ) : daily ? (
          <>
            <section className="coinPriceBar" aria-label="行情">
              <div className="coinPriceTop">
                <span className={"coinLast " + toneOf(daily.changePct)}>{formatPrice(daily.close)}</span>
                <span className={"coinChange " + toneOf(daily.changePct)}>{formatPct(daily.changePct)}</span>
                <span className="coinUnit">USDT</span>
              </div>
              <dl className="coinStats">
                <div>
                  <dt>今开</dt>
                  <dd>{formatPrice(daily.open)}</dd>
                </div>
                <div>
                  <dt>最高</dt>
                  <dd>{formatPrice(daily.high)}</dd>
                </div>
                <div>
                  <dt>最低</dt>
                  <dd>{formatPrice(daily.low)}</dd>
                </div>
                <div>
                  <dt>成交量</dt>
                  <dd>{formatAmount(daily.volume)}</dd>
                </div>
              </dl>
              <p className="coinSrc">行情与网页同源 · 30s 刷新</p>
            </section>

            {(offline || cached) && (
              <div className="coinOfflineBar" role="status">
                <span>{offline ? "离线 · 显示上次缓存" : "缓存行情"}</span>
                <button type="button" onClick={() => void coin.refresh()} disabled={loading}>
                  {loading ? "刷新中…" : "重试"}
                </button>
              </div>
            )}

            {renderChart()}

            <section className="coinCard coinPosCard" aria-label="我的持仓">
              <h2 className="coinCardTitle">我的持仓（单机）</h2>
              {wallet ? (
                <dl className="coinPosGrid">
                  <div>
                    <dt>持有</dt>
                    <dd>{formatAmount(wallet.holdings)} HTC</dd>
                  </div>
                  <div>
                    <dt>市值</dt>
                    <dd>{marketValue === null ? "--" : formatAmount(marketValue) + " USDT"}</dd>
                  </div>
                  <div>
                    <dt>今日盈亏</dt>
                    <dd className={pnl === null ? "" : toneOf(pnl)}>
                      {pnl === null ? "--" : signedAmount(pnl) + " USDT"}
                      {pnl !== null && pnlPct !== null && <em className="coinPosPct">{formatPct(pnlPct)}</em>}
                    </dd>
                  </div>
                  <div>
                    <dt>成本价</dt>
                    <dd>{costPrice === null ? "--" : formatPrice(costPrice)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="coinCardNote">还没激活钱包——拿到第一笔行情就送 1000 HTC。</p>
              )}
            </section>

            <section className="coinCard coinSignCard" aria-label="签到">
              <h2 className="coinCardTitle">签到</h2>
              {signin ? (
                <>
                  <p className="coinSignMsg">{signin.message}</p>
                  {signin.canSign ? (
                    <button
                      type="button"
                      className="coinBtn coinBtnPrimary"
                      onClick={handleSign}
                      disabled={signing || offline}
                    >
                      {signing ? "签到中…" : signReward}
                    </button>
                  ) : signin.reason === "already" ? (
                    <p className="coinSignNext">明天签到 +{rewardForStreak(signin.currentStreak + 1)} HTC</p>
                  ) : null}
                </>
              ) : (
                <p className="coinCardNote">连上服务器才知道今天能不能签。</p>
              )}
              {offline && <p className="coinSignOffline">签到需要联网</p>}
              {signNote && <p className="coinSignNote">{signNote}</p>}
            </section>

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
      </div>
    </div>
  );
}
