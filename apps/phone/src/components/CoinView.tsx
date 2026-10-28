/**
 * 黑塔币行情页（全屏）。
 *
 * 数据全在 useCoin 里：拉取、30s 轮询、缓存回退、钱包、签到。
 * 这个文件只做三件事：把数据摆成设计文档的七个板块、把 canvas 手势翻成 hover 下标、把
 * 签到/提醒的操作接到 useCoin 与 coin/notify 上。
 *
 * 样式一律在 styles.css 末尾「黑塔币」一节（coin- 前缀），这里不写内联 style。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { formatAmount, formatPct, formatPrice, rewardForStreak } from "@herta/coin";
import type { CoinBar, CoinDailyResponse } from "@herta/coin";
import { barIndexOf, barTimeLabel, drawCoinChart } from "../coin/chart.ts";
import { useCoin } from "../coin/useCoin.ts";
import { coinReminderState, enableCoinReminder } from "../coin/notify.ts";
import type { CoinReminderState } from "../coin/notify.ts";

export interface CoinViewProps {
  /** 行情接口基址；空串表示没配置（页面会显示「行情暂不可用」）。 */
  base: string;
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

export function CoinView({ base, onClose, onQuoteChange }: CoinViewProps) {
  const coin = useCoin({ base, active: true });
  const { quote, wallet, signin, cached, offline, loading, error, signing } = coin;
  const market = quote?.market ?? null;
  const bars = market?.bars ?? NO_BARS;
  const prevClose = market?.prevClose ?? 0;
  const hasBars = bars.length > 0;

  // ---- 抽屉小字：行情一变就通知 app 一次 ----
  // 放 ref 里，App 每次渲染传新箭头函数也不会让这个 effect 反复跑。
  const quoteHandler = useRef(onQuoteChange);
  quoteHandler.current = onQuoteChange;
  useEffect(() => {
    quoteHandler.current?.(quote);
  }, [quote]);

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
    });
  }, [bars, prevClose, hover]);

  const paintRef = useRef(paint);
  paintRef.current = paint;

  // 尺寸变化（转屏、抽屉动画、键盘收起）后重画；canvas.clientWidth 是 CSS 像素，dpr 每次现取。
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
    // 拖到还没走到的格子里就保持最后一根，不闪回。
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

  // ---- 签到 ----
  const [signNote, setSignNote] = useState<string | null>(null);
  const handleSign = () => {
    void (async () => {
      try {
        const message = await coin.sign();
        setSignNote(message);
      } catch (err) {
        setSignNote("签到没成功：" + (err instanceof Error ? err.message : String(err)));
      }
    })();
  };

  // ---- 持仓 ----
  const price = market?.close ?? null;
  const marketValue = wallet && price !== null ? wallet.holdings * price : null;
  const pnl = market && wallet ? wallet.holdings * (market.close - market.prevClose) : null;
  const pnlPct = market?.changePct ?? null;
  const costPrice = wallet?.costPrice ?? null;

  const signReward = signin ? `签到 +${signin.reward} HTC` : "签到";
  const message = market
    ? market.statusLabel || STATUS_FALLBACK[market.status] || market.status
    : "";
  const tone = market ? STATUS_TONE[market.status] ?? "off" : "off";

  return (
    <div className="coinView" role="dialog" aria-label="黑塔币行情">
      <header className="coinHead">
        <button className="coinBack" type="button" onClick={onClose} aria-label="返回聊天">
          ←
        </button>
        <span className="coinTitle">黑塔币 · HTC/USDT</span>
        {market && <span className={"coinBadge " + tone}>{message}</span>}
        {offline && <span className="coinOffline">离线</span>}
      </header>

      <div className="coinScroll">
        {market ? (
          <>
            <section className="coinPriceBar" aria-label="行情">
              <div className="coinPriceTop">
                <span className={"coinLast " + toneOf(market.changePct)}>
                  {formatPrice(market.close)}
                </span>
                <span className={"coinChange " + toneOf(market.changePct)}>
                  {formatPct(market.changePct)}
                </span>
                <span className="coinUnit">USDT</span>
              </div>
              <dl className="coinStats">
                <div>
                  <dt>今开</dt>
                  <dd>{formatPrice(market.open)}</dd>
                </div>
                <div>
                  <dt>最高</dt>
                  <dd>{formatPrice(market.high)}</dd>
                </div>
                <div>
                  <dt>最低</dt>
                  <dd>{formatPrice(market.low)}</dd>
                </div>
                <div>
                  <dt>成交量</dt>
                  <dd>{formatAmount(market.volume)}</dd>
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
                  // 长按是我们自己的手势：别让 WebView 弹出原生菜单/选中文字
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

            <section className="coinCard coinPosCard" aria-label="我的持仓">
              <h2 className="coinCardTitle">我的持仓</h2>
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
                      {pnl !== null && pnlPct !== null && (
                        <em className="coinPosPct">{formatPct(pnlPct)}</em>
                      )}
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
                    <p className="coinSignNext">
                      明天签到 +{rewardForStreak(signin.currentStreak + 1)} HTC
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="coinCardNote">连上服务器才知道今天能不能签。</p>
              )}
              {offline && <p className="coinSignOffline">签到需要联网</p>}
              {signNote && <p className="coinSignNote">{signNote}</p>}
            </section>

            <section className="coinCard coinTradeCard" aria-label="交易">
              <button type="button" className="coinBtn coinBtnTrade" disabled>
                交易功能开发中
              </button>
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
