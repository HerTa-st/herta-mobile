/**
 * 黑塔币分钟 K 的 Canvas 绘制。
 *
 * 时间轴固定 240 格：0 = 09:30，119 = 11:29，120 = 13:00，239 = 14:59，
 * 午休分隔线落在 119 与 120 之间。固定格子是为了「同一根 K 线一天里位置不变」——
 * 盘前只出来几根也停在开盘位置，不会随 bars 变多左右横跳。
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

export interface CoinChartOptions {
  /** CSS 像素宽高（不是 canvas.width/height——那两个含 dpr）。 */
  width: number;
  height: number;
  dpr: number;
  /** 已揭示的分钟 K，按 t 升序（FC 就是这么给的）；只画有的，不补未来。 */
  bars: CoinBar[];
  prevClose: number;
  /** bars 的下标；null = 不画十字光标。 */
  hover: number | null;
  theme?: CoinChartTheme;
}

const SLOT_COUNT = 240;
const MORNING_SLOTS = 120;
const FONT = '10px -apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif';
const FONT_TINY = '9px -apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif';

/** 时间轴刻度（只标这几个，手机屏放不下每分钟）。 */
const TIME_TICKS = [0, 60, MORNING_SLOTS, 180, SLOT_COUNT - 1];

interface Geometry {
  plotLeft: number;
  plotRight: number;
  plotWidth: number;
  slotWidth: number;
  priceTop: number;
  priceBottom: number;
  volTop: number;
  volBottom: number;
}

/** 价格区 / 成交量副图 / 坐标轴留白都在这里算，命中测试与绘制共用一套，避免对不上。 */
function geometryOf(width: number, height: number): Geometry {
  const padLeft = width >= 240 ? 42 : 32;
  const padRight = 10;
  const padTop = 14;
  const padBottom = 16;
  const gap = 8;
  const plotLeft = padLeft;
  const plotRight = Math.max(plotLeft + 1, width - padRight);
  const bodyHeight = Math.max(1, height - padTop - padBottom - gap);
  const priceHeight = Math.max(1, bodyHeight * 0.8);
  const priceTop = padTop;
  const priceBottom = priceTop + priceHeight;
  const volTop = priceBottom + gap;
  const volBottom = priceTop + bodyHeight;
  return {
    plotLeft,
    plotRight,
    plotWidth: plotRight - plotLeft,
    slotWidth: (plotRight - plotLeft) / SLOT_COUNT,
    priceTop,
    priceBottom,
    volTop,
    volBottom,
  };
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

/** 按 t 升序排一份，绘制时位置与 MA 都按这个顺序算。 */
function sortedBars(bars: CoinBar[]): CoinBar[] {
  return bars.slice().sort((a, b) => a.t - b.t);
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
  t: number;
  v: number;
}

function movingAverage(bars: CoinBar[], period: number): MaPoint[] {
  const out: MaPoint[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    sum += bars[i].c;
    if (i >= period) sum -= bars[i - period].c;
    if (i >= period - 1) out.push({ t: bars[i].t, v: sum / period });
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
  for (const bar of bars) {
    const mid = (bar.o + bar.c) / 2;
    if (!Number.isFinite(mid)) continue;
    const v = Number.isFinite(bar.v) && bar.v > 0 ? bar.v : 0;
    weighted += mid * v;
    volume += v;
    plain += mid;
    count += 1;
    if (volume > 0) out.push({ t: bar.t, v: weighted / volume });
    else if (count > 0) out.push({ t: bar.t, v: plain / count });
  }
  return out;
}

/**
 * 画一屏分钟 K。不会抛错：宽高为 0、bars 为空都安全返回（空盘就只画网格和昨收线）。
 */
export function drawCoinChart(ctx: CanvasRenderingContext2D, opts: CoinChartOptions): void {
  const { width, height, dpr, bars, prevClose, hover } = opts;
  if (!ctx || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const theme = opts.theme ?? COIN_CHART_THEME;
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;

  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const g = geometryOf(width, height);
  const sorted = sortedBars(Array.isArray(bars) ? bars : []);
  const extent = priceExtent(sorted, prevClose);
  const span = extent.max - extent.min;
  const xFor = (t: number) => g.plotLeft + (clamp(t, 0, SLOT_COUNT - 1) + 0.5) * g.slotWidth;
  const yFor = (price: number) => g.priceTop + ((extent.max - price) / span) * (g.priceBottom - g.priceTop);
  const inPrice = (price: number) => Number.isFinite(price) && price >= extent.min && price <= extent.max;

  // ---- 网格 + 价格轴 ----
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

  // 竖向刻度每 30 格一条（120 处留给午休线，不重复画）
  const hourSlot = 30;
  ctx.strokeStyle = theme.grid;
  for (let slot = hourSlot; slot < SLOT_COUNT; slot += hourSlot) {
    if (slot === MORNING_SLOTS) continue;
    const x = Math.round(g.plotLeft + slot * g.slotWidth) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, g.priceTop);
    ctx.lineTo(x, g.volBottom);
    ctx.stroke();
  }

  // ---- 午休分隔线：119 / 120 之间 ----
  const noonX = Math.round(g.plotLeft + MORNING_SLOTS * g.slotWidth) + 0.5;
  ctx.save();
  ctx.globalAlpha = 0.32;
  ctx.strokeStyle = theme.axis;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(noonX, g.priceTop);
  ctx.lineTo(noonX, g.volBottom);
  ctx.stroke();
  ctx.restore();

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

  // 接口解析会把关，这里再做一层：坏掉的一根整根跳过，别让 NaN 顺着 MA 线污染整张图。
  const shown = sorted.filter(
    (bar) =>
      Number.isFinite(bar.o) &&
      Number.isFinite(bar.h) &&
      Number.isFinite(bar.l) &&
      Number.isFinite(bar.c)
  );
  if (shown.length === 0) {
    // 盘前/网络没数据：网格和昨收线已经画了，别让整块看着像坏了。
    ctx.restore();
    return;
  }

  // ---- 成交量柱（先画，压在图下方） ----
  let maxVolume = 0;
  for (const bar of shown) {
    if (Number.isFinite(bar.v) && bar.v > maxVolume) maxVolume = bar.v;
  }
  const volHeight = Math.max(1, g.volBottom - g.volTop);
  const bodyWidth = Math.max(1, Math.min(g.slotWidth * 0.68, 7));
  if (maxVolume > 0) {
    for (const bar of shown) {
      if (!Number.isFinite(bar.v) || bar.v <= 0) continue;
      const x = xFor(bar.t);
      const h = Math.max(1, (bar.v / maxVolume) * volHeight);
      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.fillStyle = bar.c >= bar.o ? theme.up : theme.down;
      ctx.fillRect(x - bodyWidth / 2, g.volBottom - h, bodyWidth, h);
      ctx.restore();
    }
  }

  // ---- K 线 ----
  for (const bar of shown) {
    const color = bar.c >= bar.o ? theme.up : theme.down;
    const x = xFor(bar.t);
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
    points.forEach((p, i) => {
      const x = xFor(p.t);
      const y = yFor(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  };
  drawLine(movingAverage(shown, 20), theme.ma20, false, 1);
  drawLine(movingAverage(shown, 10), theme.ma10, false, 1);
  drawLine(movingAverage(shown, 5), theme.ma5, false, 1);
  drawLine(vwapLine(shown), theme.vwap, true, 1);

  const last = shown[shown.length - 1];

  // ---- 十字光标（hover 时）：竖线 + 横线 + 时间标签 ----
  // hover 是 bars 的下标（契约），而这里画的是排过序、滤掉坏数据的那份：
  // 正常情况下两者一一对应；接口给的 bars 本来就是 t 升序。
  const hoverBar =
    typeof hover === "number" && Number.isInteger(hover) && hover >= 0 && hover < sorted.length
      ? sorted[hover]
      : null;
  if (hoverBar) {
    const hx = xFor(hoverBar.t);
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
    ctx.moveTo(xFor(last.t), latestY);
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
    const lx = clamp(xFor(hoverBar.t) - lw / 2 - 5, g.plotLeft, g.plotRight - lw - 10);
    const ly = g.volBottom + 2;
    ctx.fillStyle = theme.axis;
    roundRectPath(ctx, lx, ly, lw + 10, 14, 3);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, lx + 5, ly + 7);
  }

  // ---- 底部时间轴 ----
  if (!hoverBar) {
    ctx.font = FONT;
    ctx.fillStyle = theme.axis;
    ctx.textBaseline = "alphabetic";
    const axisY = g.volBottom + 12;
    TIME_TICKS.forEach((slot, i) => {
      const x = xFor(slot);
      ctx.textAlign = i === 0 ? "left" : i === TIME_TICKS.length - 1 ? "right" : "center";
      ctx.fillText(barTimeLabel(slot), clamp(x, g.plotLeft, g.plotRight), axisY);
    });
  }

  ctx.restore();
}

/**
 * 触点 → bars 下标。固定 240 格轴的命中：先算落在第几格，再核对这一格有没有数据。
 * 空槽 / 图外返回 null（CoinView 用它决定要不要动十字光标）。
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
  const g = geometryOf(width, height);
  if (x < g.plotLeft || x > g.plotRight) return null;
  const slot = Math.floor((x - g.plotLeft) / g.slotWidth);
  if (slot < 0 || slot >= SLOT_COUNT) return null;
  const count = Number.isFinite(barsLength) ? Math.floor(barsLength) : 0;
  if (slot >= count) return null;
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
