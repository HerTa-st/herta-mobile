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
  ORDER_TTL_LABELS,
  achievementProgress,
  formatAmount,
  formatHtc,
  formatPct,
  formatPrice,
  mergeAchievementIds,
  shortPnl,
  snapshotFromWallet,
} from "@herta/coin";
import type {
  AchievementSnapshot,
  CoinBar,
  CoinDailyResponse,
  CoinOrderSide,
  CoinOrderTtl,
} from "@herta/coin";
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

/* ------------------------------------------------------- 分享卡（纯图） */

interface ShareCardData {
  state: "profit" | "empty" | "bankrupt";
  price: number;
  changePct: number;
  htc: number;
  cash: number;
  cost: number | null;
  marketValue: number;
  pnl: number;
  pnlPct: number;
  net: number;
  debt: number;
  bankruptCount: number;
  restartUsdt: number;
  short: { amount: number; entryPrice: number; leverage: number } | null;
}

function shareNum(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function sharePct(value: number): string {
  return (value >= 0 ? "+" : "") + value.toFixed(2) + "%";
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const ch of text) {
    const next = line + ch;
    if (ctx.measureText(next).width > maxWidth && line) {
      out.push(line);
      line = ch;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

/** 1080×1440，三态：盈利/亏损（浅色）、空仓（浅色虚线）、破产（深墨 + 红章）。 */
function drawShareCard(data: ShareCardData): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1440;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const W = 1080;
  const H = 1440;
  const mono = '"Consolas", "SFMono-Regular", monospace';
  const han = '"Microsoft YaHei", "PingFang SC", sans-serif';
  const INK = "#111417";
  const SOFT = "#3b4350";
  const MUT = "#717984";
  const ACC = "#2f7d92";
  const UP = "#c2554f";
  const DOWN = "#3f8f6b";
  const FAINT = "#969ea6";
  const bankrupt = data.state === "bankrupt";

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  if (bankrupt) {
    bg.addColorStop(0, "#090a0c");
    bg.addColorStop(1, "#1e1010");
  } else {
    bg.addColorStop(0, "#fafcfd");
    bg.addColorStop(1, "#f2f7f8");
  }
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 420);
  if (bankrupt) {
    glow.addColorStop(0, "rgba(194,85,79,0.26)");
    glow.addColorStop(1, "rgba(194,85,79,0)");
  } else {
    glow.addColorStop(0, "rgba(201,238,241,0.55)");
    glow.addColorStop(1, "rgba(201,238,241,0)");
  }
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  if (bankrupt) {
    const red = ctx.createRadialGradient(W / 2, H + 120, 40, W / 2, H + 120, 620);
    red.addColorStop(0, "rgba(233,118,106,0.28)");
    red.addColorStop(1, "rgba(233,118,106,0)");
    ctx.fillStyle = red;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.fillStyle = bankrupt ? "rgba(233,118,106,0.20)" : "rgba(47,125,146,0.10)";
  for (let y = 0; y < H; y += 22) {
    for (let x = 0; x < W; x += 22) {
      const d = Math.hypot(x + 60, y + 40) / (W * 0.5);
      const radius = Math.max(0, 3.2 * (1 - d));
      const alpha = 1 - Math.min(1, d * 1.15);
      if (radius > 0.6 && alpha > 0.08) {
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;

  const headColor = bankrupt ? "#e9766a" : ACC;
  ctx.fillStyle = headColor;
  ctx.font = "700 25px " + mono;
  ctx.fillText("HERTA COIN", 72, 92);
  ctx.fillStyle = bankrupt ? "#78828a" : MUT;
  ctx.font = "21px " + han;
  ctx.fillText(bankrupt ? "模拟宇宙交易所 · 破产记录" : "模拟宇宙交易所 · 虚构行情", 72, 130);
  ctx.strokeStyle = bankrupt ? "rgba(233,118,106,0.22)" : "rgba(17,20,23,0.10)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(72, 170);
  ctx.lineTo(W - 72, 170);
  ctx.stroke();

  if (bankrupt) {
    const netText = shareNum(data.net);
    ctx.fillStyle = "#b2acaa";
    ctx.font = "22px " + han;
    ctx.fillText("净资产", 72, 214);
    ctx.fillStyle = "#e9766a";
    ctx.font = "84px " + mono;
    ctx.fillText(netText, 66, 292);
    ctx.fillStyle = "#78828a";
    ctx.font = "21px " + han;
    ctx.fillText("已达负数 · 无下限", 72, 335);
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.moveTo(72, 376);
    ctx.lineTo(W - 72, 376);
    ctx.stroke();

    const rows: Array<[string, string]> = [
      ["负债合计", shareNum(data.debt)],
      ["破产次数", data.bankruptCount + " 次"],
      ["重开起点", "1,000 HTC / " + shareNum(data.restartUsdt) + " 信用点"],
    ];
    let y = 404;
    for (const [k, v] of rows) {
      ctx.fillStyle = "#78828a";
      ctx.font = "21px " + han;
      ctx.fillText(k, 72, y);
      ctx.fillStyle = "#b2acaa";
      if (/次|点/.test(v)) {
        ctx.font = "23px " + han;
        ctx.fillText(v, 72, y + 34);
      } else {
        ctx.font = "30px " + mono;
        ctx.textAlign = "right";
        ctx.fillText(v, W - 72, y + 34);
        ctx.textAlign = "left";
      }
      y += 86;
    }
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(72, 660);
    ctx.lineTo(W - 72, 660);
    ctx.stroke();

    ctx.save();
    ctx.translate(834, 995);
    ctx.rotate((-9 * Math.PI) / 180);
    ctx.strokeStyle = "rgba(233,118,106,0.76)";
    ctx.lineWidth = 8;
    roundRectPath(ctx, -170, -95, 340, 190, 14);
    ctx.stroke();
    ctx.fillStyle = "rgba(233,118,106,0.86)";
    ctx.font = "98px " + han;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("破产", 0, 6);
    ctx.restore();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    ctx.fillStyle = "rgba(233,118,106,0.55)";
    ctx.fillRect(72, 700, 3, 46);
    ctx.fillStyle = "#b2acaa";
    ctx.font = "24px " + han;
    ctx.fillText(
      data.bankruptCount > 0
        ? "破产 " + data.bankruptCount + " 次。你在这方面的确有天赋。"
        : "重开吧。这次别用同样的方式。",
      92,
      702
    );
    ctx.fillStyle = "#606a72";
    ctx.font = "22px " + mono;
    ctx.fillText("www.herta-st-gp.top", 72, 1300);
    return canvas.toDataURL("image/png");
  }

  ctx.fillStyle = SOFT;
  ctx.font = "22px " + han;
  ctx.fillText("HTC / 信用点", 72, 214);
  ctx.fillStyle = INK;
  ctx.font = "84px " + mono;
  const priceText = data.price.toFixed(2);
  ctx.fillText(priceText, 68, 288);
  const priceWidth = ctx.measureText(priceText).width;
  ctx.fillStyle = data.changePct >= 0 ? UP : DOWN;
  ctx.font = "30px " + mono;
  ctx.fillText(sharePct(data.changePct), 88 + priceWidth, 310);

  if (data.state === "empty") {
    ctx.strokeStyle = "rgba(17,20,23,0.28)";
    ctx.lineWidth = 2;
    ctx.setLineDash([15, 10]);
    roundRectPath(ctx, 72, 404, W - 144, 196, 20);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = "center";
    ctx.fillStyle = FAINT;
    ctx.font = "32px " + han;
    ctx.fillText("空仓", W / 2, 492);
    ctx.fillStyle = "#b0b6bc";
    ctx.font = "20px " + han;
    ctx.fillText("还没有持仓", W / 2, 532);
    ctx.textAlign = "left";

    ctx.fillStyle = MUT;
    ctx.font = "21px " + han;
    ctx.fillText("现金", 72, 650);
    ctx.fillStyle = SOFT;
    ctx.font = "38px " + mono;
    const cashText = shareNum(data.cash);
    ctx.fillText(cashText, 72, 695);
    ctx.fillStyle = MUT;
    ctx.font = "21px " + han;
    ctx.fillText("信用点", 84 + ctx.measureText(cashText).width, 693);

    ctx.fillStyle = MUT;
    ctx.font = "21px " + han;
    ctx.fillText("净资产", 72, 785);
    ctx.fillStyle = INK;
    ctx.font = "32px " + mono;
    ctx.fillText(shareNum(data.net), 72, 828);
    ctx.fillStyle = MUT;
    ctx.font = "21px " + han;
    ctx.fillText("破产", 72, 870);
    ctx.fillStyle = SOFT;
    ctx.font = "32px " + mono;
    ctx.fillText(String(data.bankruptCount), 72, 908);
    ctx.fillStyle = MUT;
    ctx.font = "21px " + han;
    ctx.fillText("次", 84 + ctx.measureText(String(data.bankruptCount)).width, 906);

    ctx.strokeStyle = "rgba(17,20,23,0.08)";
    ctx.beginPath();
    ctx.moveTo(72, 1096);
    ctx.lineTo(W - 72, 1096);
    ctx.stroke();
    ctx.fillStyle = "rgba(47,125,146,0.55)";
    ctx.fillRect(72, 1148, 3, 46);
    ctx.fillStyle = SOFT;
    ctx.font = "24px " + han;
    ctx.fillText("空着。挺诚实。", 92, 1178);
    ctx.fillStyle = MUT;
    ctx.font = "22px " + mono;
    ctx.fillText("www.herta-st-gp.top", 72, 1300);
    return canvas.toDataURL("image/png");
  }

  const cardY = 404;
  ctx.save();
  ctx.shadowColor = "rgba(32,45,58,0.14)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  roundRectPath(ctx, 72, cardY, W - 144, 206, 24);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = "rgba(17,20,23,0.10)";
  ctx.lineWidth = 2;
  roundRectPath(ctx, 72, cardY, W - 144, 206, 24);
  ctx.stroke();

  const qtyLabel = data.short
    ? "空头 " + shareNum(data.short.amount) + " HTC"
    : shareNum(data.htc) + " HTC";
  const rows: Array<[string, string]> = [
    ["持仓", qtyLabel],
    ["成本价", data.cost === null ? "—" : data.cost.toFixed(2)],
    ["市值", shareNum(data.marketValue)],
  ];
  let rowY = cardY + 42;
  for (const [k, v] of rows) {
    ctx.fillStyle = MUT;
    ctx.font = "21px " + han;
    ctx.fillText(k, 104, rowY);
    ctx.fillStyle = SOFT;
    ctx.font = "30px " + mono;
    ctx.textAlign = "right";
    ctx.fillText(v, W - 104, rowY);
    ctx.textAlign = "left";
    rowY += 58;
  }

  ctx.fillStyle = MUT;
  ctx.font = "21px " + han;
  ctx.fillText("浮动盈亏", 72, 665);
  ctx.fillStyle = data.pnl >= 0 ? UP : DOWN;
  ctx.font = "48px " + mono;
  ctx.fillText((data.pnl >= 0 ? "+" : "") + shareNum(data.pnl), 68, 715);
  ctx.font = "28px " + mono;
  ctx.fillText(sharePct(data.pnlPct), 70, 760);

  ctx.strokeStyle = "rgba(17,20,23,0.08)";
  ctx.beginPath();
  ctx.moveTo(72, 790);
  ctx.lineTo(W - 72, 790);
  ctx.stroke();

  ctx.fillStyle = MUT;
  ctx.font = "21px " + han;
  ctx.fillText("净资产", 72, 830);
  ctx.fillStyle = INK;
  ctx.font = "32px " + mono;
  ctx.fillText(shareNum(data.net), 72, 868);
  ctx.fillStyle = MUT;
  ctx.font = "21px " + han;
  ctx.fillText("破产", 72, 912);
  ctx.fillStyle = SOFT;
  ctx.font = "32px " + mono;
  ctx.fillText(String(data.bankruptCount), 72, 950);
  ctx.fillStyle = MUT;
  ctx.font = "21px " + han;
  ctx.fillText("次", 84 + ctx.measureText(String(data.bankruptCount)).width, 948);

  ctx.strokeStyle = "rgba(17,20,23,0.08)";
  ctx.beginPath();
  ctx.moveTo(72, 1096);
  ctx.lineTo(W - 72, 1096);
  ctx.stroke();
  ctx.fillStyle = "rgba(47,125,146,0.55)";
  ctx.fillRect(72, 1148, 3, 46);
  ctx.fillStyle = SOFT;
  ctx.font = "24px " + han;
  const quip = data.pnl >= 0 ? "运气不错。别当成能力。" : "你的操作很有观赏性。";
  const lines = wrapLines(ctx, quip, W - 180);
  lines.forEach((line, i) => ctx.fillText(line, 92, 1178 + i * 30));
  ctx.fillStyle = MUT;
  ctx.font = "22px " + mono;
  ctx.fillText("www.herta-st-gp.top", 72, 1300);
  return canvas.toDataURL("image/png");
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
    setOrderNote(null);
    setShortNote(null);
    setRestartNote(null);
    setShareImage(null);
    setShareNote(null);
    setShareViewer(false);
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
  const [orderSide, setOrderSide] = useState<CoinOrderSide>("buy");
  const [orderLimit, setOrderLimit] = useState("");
  const [orderTtl, setOrderTtl] = useState<CoinOrderTtl>("24h");
  const [orderNote, setOrderNote] = useState<string | null>(null);
  const [shortAmount, setShortAmount] = useState("100");
  const [shortNote, setShortNote] = useState<string | null>(null);
  const [restartNote, setRestartNote] = useState<string | null>(null);
  const [shareImage, setShareImage] = useState<string | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [shareViewer, setShareViewer] = useState(false);
  const [boardTab, setBoardTab] = useState<"value" | "debt">("value");
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

  const handleLimit = () => {
    const amount = Number(tradeAmount);
    const limit = Number(orderLimit);
    if (!Number.isInteger(amount) || amount <= 0) {
      setOrderNote("数量要填正整数");
      return;
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      setOrderNote("限价要填正数");
      return;
    }
    setOrderNote(null);
    void (async () => {
      try {
        setOrderNote(creditText(await api.limit(orderSide, amount, limit, orderTtl)));
      } catch (err) {
        setOrderNote("挂单没成功：" + errorText(err));
      }
    })();
  };

  const handleOpenShort = () => {
    const amount = Number(shortAmount);
    if (!Number.isInteger(amount) || amount <= 0) {
      setShortNote("数量要填正整数");
      return;
    }
    setShortNote(null);
    void (async () => {
      try {
        setShortNote(creditText(await api.openShort(amount)));
      } catch (err) {
        setShortNote("开空没成功：" + errorText(err));
      }
    })();
  };

  const handleCloseShort = (amount?: number) => {
    setShortNote(null);
    void (async () => {
      try {
        setShortNote(creditText(await api.closeShort(amount)));
      } catch (err) {
        setShortNote("平空没成功：" + errorText(err));
      }
    })();
  };

  const handleRestart = () => {
    if (!window.confirm("重开会清空持仓、挂单，并重置为 1000 HTC / 10000 信用点；破产次数 +1。继续？")) return;
    setRestartNote(null);
    void (async () => {
      try {
        setRestartNote(creditText(await api.restart()));
      } catch (err) {
        setRestartNote("重开没成功：" + errorText(err));
      }
    })();
  };

  const handleMakeShare = () => {
    const px = shared ? shared.market.price : daily?.close ?? null;
    if (px === null) {
      setShareNote("还没拿到价格，等行情加载完再生成。");
      return;
    }
    const htc = shared ? shared.user.htc : localHoldings ?? 0;
    const cash = shared ? shared.user.usdt : 0;
    const net = shared ? shared.user.value : htc * px;
    const cost = shared ? shared.user.cost : wallet?.costPrice ?? null;
    const short = shared?.user.short
      ? {
          amount: shared.user.short.amount,
          entryPrice: shared.user.short.entryPrice,
          leverage: shared.user.leverage,
        }
      : null;
    const prev = prevClose || px;
    const longPnl = htc * (px - prev);
    const shortPnlValue = shared?.user.short ? shortPnl(shared.user.short, px) : 0;
    const pnl = shared ? longPnl + shortPnlValue : localPnl ?? 0;
    const pnlPct = (pnl / Math.max(1, Math.abs(net - pnl))) * 100;
    const state: ShareCardData["state"] =
      shared && shared.user.value < 0 ? "bankrupt" : htc <= 0 && !short ? "empty" : "profit";
    const data: ShareCardData = {
      state,
      price: px,
      changePct: shared ? shared.market.changePct : daily?.changePct ?? 0,
      htc,
      cash,
      cost,
      marketValue: htc * px,
      pnl,
      pnlPct,
      net,
      debt: shared?.user.debt ?? 0,
      bankruptCount: shared?.user.bankruptCount ?? 0,
      restartUsdt: shared?.limits.restartUsdt ?? 10000,
      short,
    };
    try {
      const image = drawShareCard(data);
      if (!image) throw new Error("画布不可用");
      setShareImage(image);
      setShareNote("已生成 1080×1440 纯图；不含昵称。");
    } catch (err) {
      setShareNote("生成失败：" + errorText(err));
    }
  };

  const handleSaveShare = () => {
    if (!shareImage) return;
    void (async () => {
      try {
        const blob = await (await fetch(shareImage)).blob();
        const file = new File([blob], "herta-coin.png", { type: "image/png" });
        const nav = navigator as Navigator & {
          canShare?: (data?: ShareData) => boolean;
          share?: (data?: ShareData) => Promise<void>;
        };
        if (nav.canShare?.({ files: [file] }) && nav.share) {
          await nav.share({ files: [file], title: "黑塔币持仓" });
          setShareNote("已打开系统分享：可存相册，或发给 Herta。");
          return;
        }
        setShareViewer(true);
        setShareNote("系统分享不可用：长按原图，选「保存图片」或「分享」。");
      } catch {
        setShareViewer(true);
        setShareNote("系统分享没打开：长按原图，选「保存图片」或「分享」。");
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
              <dd style={netWorth !== null && netWorth < 0 ? { color: "#c2554f", fontWeight: 700 } : undefined}>
                {netWorth === null ? "--" : formatAmount(netWorth) + " 信用点"}
              </dd>
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
                <div>
                  <dt>欠款</dt>
                  <dd style={shared.user.debt > 0 ? { color: "#c2554f", fontWeight: 700 } : undefined}>
                    {formatAmount(shared.user.debt)}
                  </dd>
                </div>
                <div>
                  <dt>空头杠杆</dt>
                  <dd>{shared.user.short ? shared.user.leverage.toFixed(2) + "x" : "—"}</dd>
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
        {shared && shared.user.canRestart && (
          <div
            className="coinBankrupt"
            style={{
              marginTop: 14,
              padding: "12px 14px",
              borderRadius: 12,
              border: "1px solid rgba(194,85,79,0.35)",
              background: "rgba(194,85,79,0.08)",
            }}
          >
            <p className="coinSignMsg" style={{ color: "#c2554f", fontWeight: 700 }}>
              净资产为负 · 无下限
            </p>
            <p className="coinCardNote">
              欠款 {formatAmount(shared.user.debt)} 信用点 · 破产 {shared.user.bankruptCount} 次 · 只能平仓，不能开新仓。
            </p>
            <button
              type="button"
              className="coinBtn coinBtnBuy"
              onClick={handleRestart}
              disabled={api.busy || api.offline}
            >
              {api.busy ? "重开中…" : "重开：1000 HTC / " + formatAmount(shared.limits.restartUsdt) + " 信用点"}
            </button>
            {restartNote && <p className="coinSignNote">{restartNote}</p>}
          </div>
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
    const limitNum = Number(orderLimit);
    const limitOk = Number.isFinite(limitNum) && limitNum > 0;
    const canLimit = canTrade && amountOk && limitOk;
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
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid rgba(17,20,23,0.10)" }}>
          <p className="coinSignMsg" style={{ fontWeight: 700 }}>限价单 · 条件单</p>
          <p className="coinCardNote" style={{ marginTop: 4 }}>
            双向：买单价 ≤ 限价、卖单价 ≥ 限价时触发，由系统按当时市价成交。没有对手方，也不是订单簿。
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
            <button
              type="button"
              className={"coinBtn " + (orderSide === "buy" ? "coinBtnBuy" : "coinBtnSell")}
              onClick={() => setOrderSide("buy")}
              aria-pressed={orderSide === "buy"}
            >
              买
            </button>
            <button
              type="button"
              className={"coinBtn " + (orderSide === "sell" ? "coinBtnSell" : "coinBtnBuy")}
              onClick={() => setOrderSide("sell")}
              aria-pressed={orderSide === "sell"}
            >
              卖
            </button>
            <input
              className="coinTradeInput"
              type="number"
              inputMode="decimal"
              min={0.01}
              step="0.01"
              placeholder="限价"
              value={orderLimit}
              onChange={(e) => setOrderLimit(e.target.value.replace(/[^0-9.]/g, ""))}
              aria-label="限价"
              style={{ flex: 1, minWidth: 0 }}
            />
            <select
              className="coinTradeInput"
              value={orderTtl}
              onChange={(e) => setOrderTtl(e.target.value as CoinOrderTtl)}
              aria-label="有效期"
              style={{ width: 92 }}
            >
              {limits.orderTtls.map((ttl) => (
                <option key={ttl} value={ttl}>
                  {ORDER_TTL_LABELS[ttl]}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="coinBtn coinBtnPrimary"
            onClick={handleLimit}
            disabled={!canLimit}
            style={{ marginTop: 10, width: "100%" }}
          >
            {api.busy ? "提交中…" : "挂" + (orderSide === "buy" ? "买" : "卖") + "限价单"}
          </button>
          <p className="coinCardNote" style={{ marginTop: 8 }}>
            有效期 {ORDER_TTL_LABELS[orderTtl]}，到期未触价自动作废；只在有人下单/成交时顺手撮合，不跑定时扫盘。
          </p>
          {orderNote && <p className="coinSignNote">{orderNote}</p>}
        </div>
        {shared.market.status !== "trading" && (
          <p className="coinSignOffline">休市时间不能交易（工作日 09:30–11:30 / 13:00–15:00）</p>
        )}
        {marketNote && <p className="coinSignNote">{marketNote}</p>}
      </section>
    );
  };

  const renderOrders = () => {
    if (!shared) return null;
    const orders = shared.orders;
    return (
      <section className="coinCard" aria-label="共享挂单表">
        <h2 className="coinCardTitle">挂单表 · 全员可见</h2>
        <p className="coinCardNote">
          条件单，不是订单簿：没有对手方，价格触及后由系统按市价成交；到期作废。
        </p>
        {orders.length === 0 ? (
          <p className="coinCardNote">现在没有挂单。你挂一张，别人也能看到。</p>
        ) : (
          <ul className="coinLeaderList">
            {orders.map((order) => {
              const d = new Date(order.expiresAt);
              const pad = (n: number) => String(n).padStart(2, "0");
              const until =
                pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
              return (
                <li key={order.id} className={order.user === identity ? "isMe" : undefined}>
                  <span className={"coinLeaderRank " + (order.side === "buy" ? "up" : "down")}>
                    {order.side === "buy" ? "买" : "卖"}
                  </span>
                  <span className="coinLeaderName">
                    {order.user} · {formatHtc(order.amount)} HTC @ {formatPrice(order.limitPrice)}
                  </span>
                  <span className="coinLeaderValue">
                    {ORDER_TTL_LABELS[order.ttl]} · {until}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="coinCardNote">只在有人下单/成交时顺手撮合，不跑定时扫盘；过期单在下一次访问时清掉。</p>
      </section>
    );
  };

  const renderShort = () => {
    if (!shared) return null;
    const short = shared.user.short;
    const px = shared.market.price;
    const pnl = short ? shortPnl(short, px) : 0;
    const dailyInterest = short ? short.notional * shared.limits.interestRateDaily : 0;
    const canOpen =
      shared.market.status === "trading" &&
      !api.busy &&
      !api.offline &&
      shared.user.value > 0 &&
      !short;
    const amount = Number(shortAmount);
    const amountOk = Number.isInteger(amount) && amount > 0;
    return (
      <section className="coinCard" aria-label="空头仓位">
        <h2 className="coinCardTitle">空头 · 借币</h2>
        {short ? (
          <>
            <dl className="coinPosGrid">
              <div>
                <dt>空头数量</dt>
                <dd>{formatHtc(short.amount)} HTC</dd>
              </div>
              <div>
                <dt>开仓价</dt>
                <dd>{formatPrice(short.entryPrice)}</dd>
              </div>
              <div>
                <dt>名义价值</dt>
                <dd>{formatAmount(short.notional)} 信用点</dd>
              </div>
              <div>
                <dt>当前杠杆</dt>
                <dd>{shared.user.leverage.toFixed(2)}x</dd>
              </div>
              <div>
                <dt>浮动盈亏</dt>
                <dd className={toneOf(pnl)}>{signedAmount(pnl)} 信用点</dd>
              </div>
              <div>
                <dt>每天利息</dt>
                <dd>{formatAmount(dailyInterest)} 信用点</dd>
              </div>
            </dl>
            <p className="coinCardNote">
              借币日息 {(shared.limits.interestRateDaily * 100).toFixed(1)}% · 按开仓名义价值算 · 只计整天，零头保留。
              平空按市价买回，信用点可能被扣成负数。
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input
                className="coinTradeInput"
                type="number"
                inputMode="numeric"
                min={1}
                max={short.amount}
                value={shortAmount}
                onChange={(e) => setShortAmount(e.target.value.replace(/[^0-9]/g, ""))}
                aria-label="平空数量"
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                type="button"
                className="coinBtn coinBtnBuy"
                onClick={() => handleCloseShort(amount)}
                disabled={api.busy || api.offline || !amountOk || amount > short.amount}
              >
                {api.busy ? "平空中…" : "平空"}
              </button>
              <button
                type="button"
                className="coinBtn"
                onClick={() => handleCloseShort(short.amount)}
                disabled={api.busy || api.offline}
              >
                全平
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="coinCardNote">
              借 HTC 卖出，等价格跌了再买回。开仓上限 = 净资产 × {shared.limits.shortMaxLeverage}；
              净资产为负时只能平仓，不能开新仓。
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input
                className="coinTradeInput"
                type="number"
                inputMode="numeric"
                min={1}
                max={shared.limits.maxOrder}
                value={shortAmount}
                onChange={(e) => setShortAmount(e.target.value.replace(/[^0-9]/g, ""))}
                aria-label="开空数量"
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                type="button"
                className="coinBtn coinBtnSell"
                onClick={handleOpenShort}
                disabled={!canOpen || !amountOk}
              >
                {api.busy ? "开空中…" : "开空"}
              </button>
            </div>
            {shared.user.value <= 0 && (
              <p className="coinSignOffline">净资产已为负，只能平仓，不能开新仓。</p>
            )}
          </>
        )}
        {shared.market.status !== "trading" && (
          <p className="coinSignOffline">休市时间不能开平空（工作日 09:30–11:30 / 13:00–15:00）。</p>
        )}
        {shortNote && <p className="coinSignNote">{shortNote}</p>}
      </section>
    );
  };

  const renderShare = () => (
    <section className="coinCard" aria-label="持仓分享卡">
      <h2 className="coinCardTitle">持仓分享卡</h2>
      <p className="coinCardNote">
        纯图 1080×1440，不带昵称；按盈利 / 空仓 / 破产三态出图。先预览，再存相册或系统分享。
      </p>
      <button type="button" className="coinBtn coinBtnPrimary" onClick={handleMakeShare}>
        生成分享卡
      </button>
      {shareImage && (
        <div style={{ marginTop: 12 }}>
          <img
            src={shareImage}
            alt="黑塔币持仓分享卡"
            style={{ width: "100%", borderRadius: 12, border: "1px solid rgba(17,20,23,0.10)" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" className="coinBtn coinBtnPrimary" onClick={handleSaveShare}>
              保存 / 分享
            </button>
            <button type="button" className="coinBtn" onClick={() => setShareImage(null)}>
              收起
            </button>
          </div>
          <p className="coinCardNote">也可以长按图片，用系统菜单保存到相册或发给 Herta。</p>
        </div>
      )}
      {shareNote && <p className="coinSignNote">{shareNote}</p>}
    </section>
  );

  const renderLeaderboard = () => (
    <section className="coinCard coinLeaderCard" aria-label="排行榜">
      <h2 className="coinCardTitle">排行榜</h2>
      {shared ? (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button
              type="button"
              className={"coinBtn " + (boardTab === "value" ? "coinBtnPrimary" : "")}
              onClick={() => setBoardTab("value")}
              aria-pressed={boardTab === "value"}
            >
              净资产
            </button>
            <button
              type="button"
              className={"coinBtn " + (boardTab === "debt" ? "coinBtnPrimary" : "")}
              onClick={() => setBoardTab("debt")}
              aria-pressed={boardTab === "debt"}
            >
              欠款
            </button>
          </div>
          {boardTab === "value" ? (
            shared.leaderboard.length === 0 ? (
              <p className="coinCardNote">还没有人上榜。</p>
            ) : (
              <ol className="coinLeaderList">
                {shared.leaderboard.map((row) => (
                  <li key={row.name} className={row.name === identity ? "isMe" : undefined}>
                    <span className="coinLeaderRank">{row.rank}</span>
                    <span className="coinLeaderName">{row.name}</span>
                    <span
                      className="coinLeaderValue"
                      style={row.value < 0 ? { color: "#c2554f", fontWeight: 700 } : undefined}
                    >
                      {formatAmount(row.value)} 信用点
                    </span>
                  </li>
                ))}
              </ol>
            )
          ) : shared.debtLeaderboard.length === 0 ? (
            <p className="coinCardNote">没人欠钱。至少现在。</p>
          ) : (
            <ol className="coinLeaderList">
              {shared.debtLeaderboard.map((row) => (
                <li key={row.name} className={row.name === identity ? "isMe" : undefined}>
                  <span className="coinLeaderRank" style={{ color: "#c2554f" }}>{row.rank}</span>
                  <span className="coinLeaderName">
                    {row.name}
                    <em className="coinPosPct">负债 / 净资产 {row.ratio.toFixed(2)}</em>
                  </span>
                  <span className="coinLeaderValue" style={{ color: "#c2554f", fontWeight: 700 }}>
                    {formatAmount(row.debt)} 信用点
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className="coinCardNote">净资产为负的排在最后并标红；欠款榜按负债绝对值倒序，副指标是 负债 / 净资产。</p>
        </>
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
    <div className="coinView" data-part="panel" role="dialog" aria-label="黑塔币行情">
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
        {renderShort()}
        {renderSignin()}
        {renderAchievements()}
        {renderTrade()}
        {renderOrders()}
        {renderLeaderboard()}
        {renderShare()}
        {renderMerge()}
        {renderReminder()}

        <p className="coinReminderNote">
          行情、快讯与全部数据均为程序生成的虚构内容，仅用于娱乐与演示，不构成任何投资建议。
        </p>
      </div>

      {shareViewer && shareImage && (
        <div
          role="dialog"
          aria-label="分享卡原图"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "#0b0d0f",
            overflowY: "auto",
            padding: "14px 14px 28px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", color: "#f4f1ea" }}>
            <span style={{ fontSize: 15 }}>长按图片 → 保存图片 / 分享</span>
            <button
              type="button"
              className="coinBtn"
              onClick={() => setShareViewer(false)}
              style={{ color: "#f4f1ea", borderColor: "rgba(244,241,234,0.35)" }}
            >
              关闭
            </button>
          </div>
          <img
            src={shareImage}
            alt="黑塔币持仓分享卡原图"
            style={{ width: "100%", maxWidth: 720, display: "block", margin: "12px auto", borderRadius: 8 }}
          />
          <p style={{ color: "#b9b3a8", fontSize: 13, textAlign: "center", margin: 0 }}>
            这是 1080×1440 的纯图，不含昵称；系统菜单里可存相册或转发。
          </p>
        </div>
      )}
    </div>
  );
}