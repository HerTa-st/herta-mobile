/**
 * 黑塔币分钟 K 的 Canvas 绘制。
 *
 * 时间轴是**动态**的（2026-10-30 用户决策，对齐网页版）：x 方向按已揭示的分钟根数 n
 * 等宽铺满绘图区（step = plotWidth / n，绝不预留未来格子），时间刻度只覆盖已揭示区间，
 * 午休分隔线只在已揭示进入下午后出现，当前未走完的 partial K 画淡。样板是网页版
 * `phantom-market/app.js` 的 `draw()`。
 *
 * 旧做法（已作废）是固定 240 格轴：一进页面就把全天 09:30–11:30 / 13:00–15:00 的
 * 网格和刻度画满，盘中只有左边一小段有 K，午休时右半屏全是空格子，看着像「时间轴提前画完」。
 *
 * 这里只管画：尺寸、dpr、hover 全由 CoinView 传进来，不碰 DOM、不读时钟、不拉数据。
 * 配色用设计文档的浅色版（涨粉、跌青），不照搬网页那张暗紫终端。
 */
import type { CoinBar } from "@herta/coin";

export interface CoinChartTheme {
  up: string;
  down: string;
  grid: string;
  axis: string;
  ma5: string;
  ma10: string;
  ma20: string;
  vwap: string;
  prevLine: string;
}

/** 设计文档「视觉」一节的浅色版行情配色。 */
export const COIN_CHART_THEME: CoinChartTheme = {
  up: "#d96a7a",
  down: "#4f9d8a",
  grid: "#e6eef0",
  axis: "#8a97a3",
  ma5: "#d9a66a",
  ma10: "#6fa8ad",
  ma20: "#a58ac9",
  vwap: "#6fa8ad",
  prevLine: "#b6c4cb",
};

/** 夜间（C）行情配色：青色信号 + 更亮的涨跌，网格压得很低。 */
export const COIN_CHART_THEME_DARK: CoinChartTheme = {
  up: "#ff6b7d",
  down: "#57e3b2",
  grid: "rgba(110, 231, 255, 0.08)",
  axis: "#6f8ea3",
  ma5: "#ffb86b",
  ma10: "#6ee7ff",
  ma20: "#c9a7ff",
  vwap: "#6ee7ff",
  prevLine: "#4a6b80",
};

export interface CoinChartOptions {
  /** CSS 像素宽高（不是 canvas.width/height——那两个含 dpr）。 */
  width: number;
  height: number;
  dpr: number;
  /** 已揭示的分钟 K，按 t 升序（FC 就是这么给的）；只画有的，不补未来。 */
  bars: CoinBar[];
  prevClose: number;
  /** bars 的下标（原始下标，不是过滤后的）；null = 不画十字光标。 */
  hover: number | null;
  theme?: CoinChartTheme;
}

/** 一天的分钟数（bar.t 的取值是 0..239）。绘制按已揭示根数动态铺，不再按这个画格子。 */
const SLOT_COUNT = 240;
/** 上午根数：t < 120 是上午，t >= 120 是下午；午休线落在两者之间。 */
const MORNING_SLOTS = 120;
const FONT = '10px "Herta Sans", "Noto Sans SC", "Noto Sans CJK SC", sans-serif';
const FONT_TINY = '9px "Herta Sans", "Noto Sans SC", "Noto Sans CJK SC", sans-serif';

/** 底部时间刻度的数量：手机 4~5 个、宽屏 6 个（再多数就挤在一起了）。 */
function timeLabelCount(width: number): number {
  if (width >= 480) return 6;
  if (width >= 340) return 5;
  return 4;
}

/** 一次绘制用到的几何；绘制与命中测试共用一套，避免对不上。 */
export interface CoinChartLayout {
  plotLeft: number;
  plotRight: number;
  plotWidth: number;
  /** 每根 K 占的宽度（= plotWidth / 已揭示根数）。 */
  step: number;
  /** 这次铺了几格，即传给它的已揭示根数。 */
  count: number;
  priceTop: number;
  priceBottom: number;
  volTop: number;
  volBottom: number;
}

/**
 * 按已揭示根数铺满绘图区的布局：n 根就 n 个等宽格，绝不预留未来格子。
 * `barsLength` 传这次要画的根数（drawCoinChart 用过滤后的可画根数，barIndexOf 用 bars.length）。
 */
export function coinChartLayout(width: number, height: number, barsLength: number): CoinChartLayout {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 0;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 0;
  const padLeft = safeWidth >= 240 ? 42 : 32;
  const padRight = 10;
  const padTop = 14;
  const padBottom = 16;
  const gap = 8;
  const plotLeft = padLeft;
  const plotRight = Math.max(plotLeft + 1, safeWidth - padRight);
  const plotWidth = plotRight - plotLeft;
  const bodyHeight = Math.max(1, safeHeight - padTop - padBottom - gap);
  const priceHeight = Math.max(1, bodyHeight * 0.8);
  const priceTop = padTop;
  const priceBottom = priceTop + priceHeight;
  const volTop = priceBottom + gap;
  const volBottom = priceTop + bodyHeight;
  const rawCount = Number.isFinite(barsLength) ? Math.floor(barsLength) : 0;
  const count = rawCount > 0 ? rawCount : 0;
  const step = plotWidth / Math.max(1, count);
  return { plotLeft, plotRight, plotWidth, step, count, priceTop, priceBottom, volTop, volBottom };
}

function fmt2(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : "--";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** 主题色是 #rrggbb，成交量柱要按 alpha 画淡；解析不了就退回原色。 */
function rgba(hex: string, alpha: number): string {
  if (typeof hex !== "string" || hex.length !== 7 || hex[0] !== "#") return hex;
  const n = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return hex;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** 按 t 升序排出的原始下标；绘制位置与 hover 映射都按这个顺序。 */
function sortOrder(bars: CoinBar[]): number[] {
  const order = bars.map((_, i) => i);
  order.sort((a, b) => {
    const ta = Number.isFinite(bars[a].t) ? bars[a].t : 0;
    const tb = Number.isFinite(bars[b].t) ? bars[b].t : 0;
    return ta - tb;
  });
  return order;
}

function isDrawable(bar: CoinBar): boolean {
  return (
    Number.isFinite(bar.o) &&
    Number.isFinite(bar.h) &&
    Number.isFinite(bar.l) &&
    Number.isFinite(bar.c)
  );
}

function priceExtent(bars: CoinBar[], prevClose: number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const bar of bars) {
    if (Number.isFinite(bar.l) && bar.l < min) min = bar.l;
    if (Number.isFinite(bar.h) && bar.h > max) max = bar.h;
  }
  // 昨收也要在可见范围里，否则虚线跑到画布外，等于没画。
  if (Number.isFinite(prevClose)) {
    min = Math.min(min, prevClose);
    max = Math.max(max, prevClose);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    const mid = Number.isFinite(prevClose) ? prevClose : 0;
    return { min: mid - 1, max: mid + 1 };
  }
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.005, 0.01);
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

interface MaPoint {
  /** 在可画 bars（按 t 升序）里的下标，用来算 x；动态轴下不能再用 t 当格子号。 */
  i: number;
  v: number;
}

function movingAverage(bars: CoinBar[], period: number): MaPoint[] {
  const out: MaPoint[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    sum += bars[i].c;
    if (i >= period) sum -= bars[i - period].c;
    if (i >= period - 1) out.push({ i, v: sum / period });
  }
  return out;
}

/** 均价线：Σ(o+c)/2*v ÷ Σv（和契约里 turnover 同一个口径）。 */
function vwapLine(bars: CoinBar[]): MaPoint[] {
  const out: MaPoint[] = [];
  let weighted = 0;
  let volume = 0;
  let plain = 0;
  let count = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const mid = (bar.o + bar.c) / 2;
    if (!Number.isFinite(mid)) continue;
    const v = Number.isFinite(bar.v) && bar.v > 0 ? bar.v : 0;
    weighted += mid * v;
    volume += v;
    plain += mid;
    count += 1;
    if (volume > 0) out.push({ i, v: weighted / volume });
    else if (count > 0) out.push({ i, v: plain / count });
  }
  return out;
}

/**
 * 画一屏分钟 K。不会抛错：宽高为 0、bars 为空都安全返回（空盘就只画网格和昨收线）。
 */
export function drawCoinChart(ctx: CanvasRenderingContext2D, opts: CoinChartOptions): void {
  const { width, height, dpr, hover } = opts;
  if (!ctx || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const prevClose = opts.prevClose;
  const theme = opts.theme ?? COIN_CHART_THEME;
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;

  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // 按 t 升序排好，只留 OHLC 有效的根（接口解析会把关，这里再挡一层，
  // 别让一根 NaN 顺着 MA 线污染整张图），同时记下「原始下标 → 可画位置」的映射：
  // hover 用的是原始 bars 下标，过滤之后位置要对得上。
  const rawBars = Array.isArray(opts.bars) ? opts.bars : [];
  const order = sortOrder(rawBars);
  const bars: CoinBar[] = [];
  const visibleAt = new Array<number>(rawBars.length).fill(-1);
  for (const rawIndex of order) {
    const bar = rawBars[rawIndex];
    if (!isDrawable(bar)) continue;
    visibleAt[rawIndex] = bars.length;
    bars.push(bar);
  }

  // 动态轴：已揭示几根就铺几格，x 跟着行情向右生长，绝不预留未来格子。
  const g = coinChartLayout(width, height, bars.length);
  const extent = priceExtent(bars, prevClose);
  const span = extent.max - extent.min;
  const xFor = (index: number) => g.plotLeft + (index + 0.5) * g.step;
  const yFor = (price: number) => g.priceTop + ((extent.max - price) / span) * (g.priceBottom - g.priceTop);
  const inPrice = (price: number) => Number.isFinite(price) && price >= extent.min && price <= extent.max;

  // ---- 网格 + 左侧价格轴（竖向不留网格，只保留午休分隔线） ----
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.grid;
  ctx.font = FONT;
  ctx.fillStyle = theme.axis;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const priceRows = 4;
  for (let i = 0; i <= priceRows; i += 1) {
    const price = extent.max - (span * i) / priceRows;
    const y = g.priceTop + ((g.priceBottom - g.priceTop) * i) / priceRows;
    ctx.beginPath();
    ctx.moveTo(g.plotLeft, Math.round(y) + 0.5);
    ctx.lineTo(g.plotRight, Math.round(y) + 0.5);
    ctx.stroke();
    if (g.plotLeft > 28) ctx.fillText(fmt2(price), g.plotLeft - 6, y);
  }

  // 成交量副图上沿
  ctx.strokeStyle = theme.grid;
  ctx.beginPath();
  ctx.moveTo(g.plotLeft, Math.round(g.volTop) + 0.5);
  ctx.lineTo(g.plotRight, Math.round(g.volTop) + 0.5);
  ctx.stroke();

  // ---- 昨收虚线 ----
  if (inPrice(prevClose)) {
    const y = yFor(prevClose);
    ctx.save();
    ctx.strokeStyle = theme.prevLine;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(g.plotLeft, y);
    ctx.lineTo(g.plotRight, y);
    ctx.stroke();
    ctx.restore();
    ctx.font = FONT_TINY;
    ctx.fillStyle = theme.axis;
    // 标签放右端：左端从 09:30 起就有 K 线，放在那边会被蜡烛压在下面
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(`昨收 ${fmt2(prevClose)}`, g.plotRight - 4, y - 3);
  }

  if (bars.length === 0) {
    // 盘前/网络没数据：网格和昨收线已经画了，别让整块看着像坏了。
    ctx.restore();
    return;
  }

  // ---- 午休分隔线：只有已揭示进入下午才画；上午还没走完时不画未来的分隔线 ----
  let morningCount = 0;
  for (const bar of bars) if (bar.t < MORNING_SLOTS) morningCount += 1;
  if (morningCount > 0 && morningCount < bars.length) {
    const lunchX = Math.round(g.plotLeft + morningCount * g.step) + 0.5;
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = theme.axis;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(lunchX, g.priceTop);
    ctx.lineTo(lunchX, g.volBottom);
    ctx.stroke();
    ctx.restore();

    // 9px 小字跟着分隔线，和网页版一样放顶部
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = theme.axis;
    ctx.font = FONT_TINY;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("午休", lunchX, g.priceTop + 2);
    ctx.restore();
  }

  // ---- 成交量柱（先画，压在图下方） ----
  let maxVolume = 0;
  for (const bar of bars) {
    if (Number.isFinite(bar.v) && bar.v > maxVolume) maxVolume = bar.v;
  }
  const volHeight = Math.max(1, g.volBottom - g.volTop);
  const bodyWidth = Math.max(1, Math.min(g.step * 0.68, 10));
  if (maxVolume > 0) {
    for (let i = 0; i < bars.length; i += 1) {
      const bar = bars[i];
      if (!Number.isFinite(bar.v) || bar.v <= 0) continue;
      const x = xFor(i);
      const h = Math.max(1, (bar.v / maxVolume) * volHeight);
      // 当前分钟还没走完：成交量画得比完整根更淡
      ctx.fillStyle = rgba(bar.c >= bar.o ? theme.up : theme.down, bar.partial ? 0.28 : 0.42);
      ctx.fillRect(x - bodyWidth / 2, g.volBottom - h, bodyWidth, h);
    }
  }

  // ---- K 线 ----
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const color = bar.c >= bar.o ? theme.up : theme.down;
    const alpha = bar.partial ? 0.75 : 1;
    const x = xFor(i);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yFor(bar.h));
    ctx.lineTo(x, yFor(bar.l));
    ctx.stroke();
    const top = yFor(Math.max(bar.o, bar.c));
    const bottom = yFor(Math.min(bar.o, bar.c));
    ctx.fillStyle = color;
    ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, Math.max(1, bottom - top));
    ctx.restore();
  }

  // ---- 均线（MA20 先画，压在最下面） + 均价线 ----
  const drawLine = (points: MaPoint[], color: string, dashed: boolean, lineWidth: number) => {
    if (points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (dashed) ctx.setLineDash([4, 3]);
    ctx.beginPath();
    points.forEach((p, idx) => {
      const x = xFor(p.i);
      const y = yFor(p.v);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  };
  drawLine(movingAverage(bars, 20), theme.ma20, false, 1);
  drawLine(movingAverage(bars, 10), theme.ma10, false, 1);
  drawLine(movingAverage(bars, 5), theme.ma5, false, 1);
  drawLine(vwapLine(bars), theme.vwap, true, 1);

  const last = bars[bars.length - 1];

  // ---- 十字光标（hover 时）：竖线 + 横线 + 时间标签 ----
  // hover 是原始 bars 下标，先经 visibleAt 映射成可画位置，再按动态 step 定位。
  const hoverRaw = typeof hover === "number" && Number.isInteger(hover) ? hover : -1;
  const hoverIndex = hoverRaw >= 0 && hoverRaw < visibleAt.length ? visibleAt[hoverRaw] : -1;
  const hoverBar = hoverIndex >= 0 ? bars[hoverIndex] : null;
  if (hoverBar) {
    const hx = xFor(hoverIndex);
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = theme.axis;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hx, g.priceTop);
    ctx.lineTo(hx, g.volBottom);
    ctx.stroke();
    if (inPrice(hoverBar.c)) {
      const hy = yFor(hoverBar.c);
      ctx.beginPath();
      ctx.moveTo(g.plotLeft, hy);
      ctx.lineTo(g.plotRight, hy);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- 最新价标签 ----
  const latestY = inPrice(last.c) ? yFor(last.c) : null;
  if (!hoverBar && latestY !== null) {
    const color = last.c >= last.o ? theme.up : theme.down;
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = color;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(g.plotLeft, latestY);
    ctx.lineTo(g.plotRight, latestY);
    ctx.stroke();
    ctx.restore();
    ctx.font = FONT;
    const text = fmt2(last.c);
    const tw = ctx.measureText(text).width;
    const tagX = g.plotRight - tw - 12;
    const tagY = latestY - 8;
    ctx.fillStyle = color;
    roundRectPath(ctx, tagX, tagY, tw + 8, 16, 3);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, tagX + 4, tagY + 8);
  }

  // ---- 十字光标的价格标签（盖在最新价的位置，悬停时以它为准） ----
  if (hoverBar && inPrice(hoverBar.c)) {
    const color = hoverBar.c >= hoverBar.o ? theme.up : theme.down;
    const text = fmt2(hoverBar.c);
    ctx.font = FONT;
    const tw = ctx.measureText(text).width;
    const tagX = g.plotRight - tw - 12;
    const tagY = clamp(yFor(hoverBar.c) - 8, g.priceTop - 2, g.priceBottom - 14);
    ctx.fillStyle = color;
    roundRectPath(ctx, tagX, tagY, tw + 8, 16, 3);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, tagX + 4, tagY + 8);

    // 底部时间标签
    const label = barTimeLabel(hoverBar.t);
    ctx.font = FONT;
    const lw = ctx.measureText(label).width;
    const lx = clamp(xFor(hoverIndex) - lw / 2 - 5, g.plotLeft, g.plotRight - lw - 10);
    const ly = g.volBottom + 2;
    ctx.fillStyle = theme.axis;
    roundRectPath(ctx, lx, ly, lw + 10, 14, 3);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, lx + 5, ly + 7);
  }

  // ---- 底部时间轴：只标已揭示区间（首 = 第一根、末 = 最后一根），按屏宽决定刻度数 ----
  if (!hoverBar) {
    ctx.font = FONT;
    ctx.fillStyle = theme.axis;
    ctx.textBaseline = "alphabetic";
    const axisY = g.volBottom + 12;
    const labelCount = Math.min(timeLabelCount(width), bars.length);
    let lastIndex = -1;
    for (let lc = 0; lc < labelCount; lc += 1) {
      const index = labelCount <= 1 ? 0 : Math.round((lc * (bars.length - 1)) / (labelCount - 1));
      if (index === lastIndex) continue;
      lastIndex = index;
      const x = xFor(index);
      ctx.textAlign = lc === 0 ? "left" : lc === labelCount - 1 ? "right" : "center";
      ctx.fillText(barTimeLabel(bars[index].t), clamp(x, g.plotLeft, g.plotRight), axisY);
    }
  }

  ctx.restore();
}

/**
 * 触点 → bars 原始下标。动态轴命中：先按「已揭示根数」铺出的 step 算落在第几格，
 * 再核对这一格有没有数据。空数据 / 图外返回 null（CoinView 用它决定要不要动十字光标）。
 */
export function barIndexOf(x: number, width: number, height: number, barsLength: number): number | null {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  if (x < 0 || x > width) return null;
  const g = coinChartLayout(width, height, barsLength);
  if (g.count <= 0) return null;
  if (x < g.plotLeft || x > g.plotRight) return null;
  const slot = Math.floor((x - g.plotLeft) / g.step);
  if (slot < 0 || slot >= g.count) return null;
  return slot;
}

/** 0 = 09:30 … 119 = 11:29，120 = 13:00 … 239 = 14:59。 */
export function barTimeLabel(index: number): string {
  const i = clamp(Number.isFinite(index) ? Math.floor(index) : 0, 0, SLOT_COUNT - 1);
  const minutes = i < MORNING_SLOTS ? 9 * 60 + 30 + i : 13 * 60 + (i - MORNING_SLOTS);
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}
