/**
 * 开屏竖流（B9）——满屏 ASCII 竖流，不画角色剪影。
 *
 * 算法照 tools/prototypes/gen-splash-vertical-flow.py 的 rain() 搬过来：
 * 每列一条 0.6–2.4 屏高/秒的水头，拖尾 0.20–0.75 屏高，格内密度决定取哪个字符。
 * 跟原型的差别只有两处，都是手机端才需要的：
 *   1) 字符先烘成一张小图谱，逐格 drawImage —— 逐字 fillText 在低端机上是上万次
 *      文本排版/帧，drawImage 是贴图，便宜一个数量级；
 *   2) 掉帧时按 q0→q3 降档（降密度 → 隔列 → 锁 30fps），只降不升，避免来回抖。
 *      降档结果写在 canvas.dataset.flowTune 上，真机取证直接读这个。
 *
 * 参数来自 opening/vertical-flow.json；取不到就用下面同一份默认值，
 * 开屏不因为一个 JSON 没拿到就白屏。
 */

export const FALLBACK_CONFIG = {
  version: 1,
  reference: { width: 390, height: 844 },
  cell: 7,
  font: { family: 'Consolas, "Courier New", ui-monospace, monospace', size: 10 },

  ramp: " .:-=+*#%@",
  themes: {
    light: { paper: [250, 252, 253], ink: [17, 20, 23] },
    dark: { paper: [13, 17, 22], ink: [230, 238, 242] },
  },
  accent: [47, 125, 146],
  durationMs: 2800,
  fadeMs: 600,
  hash: { a: 12.9898, b: 78.233, c: 37.719, scale: 43758.5453 },
  rain: {
    speedMin: 0.6,
    speedMax: 2.4,
    spanMin: 0.2,
    spanMax: 0.75,
    cycle: 1.5,
    drop: 0.25,
    density: 0.95,
    base: 0.4,
    vary: 0.6,
    flickerHz: 6,
    cutoff: 0.05,
  },
};

/** 降档表：0 满档、1 降密度、2 再隔列、3 再锁 30fps。 */
const QUALITY = [
  { density: 1, colStep: 1, fps: 0 },
  { density: 0.72, colStep: 1, fps: 0 },
  { density: 0.72, colStep: 2, fps: 0 },
  { density: 0.72, colStep: 2, fps: 30 },
];

function mergeConfig(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  return {
    ...base,
    ...patch,
    font: { ...base.font, ...(patch.font || {}) },
    hash: { ...base.hash, ...(patch.hash || {}) },
    rain: { ...base.rain, ...(patch.rain || {}) },
    themes: { ...base.themes, ...(patch.themes || {}) },
  };
}

function rgb(pair) {
  const p = Array.isArray(pair) ? pair : [0, 0, 0];
  return "rgb(" + Math.round(p[0]) + "," + Math.round(p[1]) + "," + Math.round(p[2]) + ")";
}

/**
 * 和 Python 那个 h2 一模一样的散列：Math.sin 与 math.sin 都是 IEEE double，
 * 同一组常数下取小数部分，逐格随机但每帧稳定（除 c 变化时）。
 */
function makeHash(h) {
  const { a, b, c, scale } = h;
  return function h2(x, y, z) {
    const v = Math.sin(x * a + y * b + (z || 0) * c) * scale;
    return v - Math.floor(v);
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 * @param {object|null} config  vertical-flow.json（可空）
 * @param {{dark?: boolean, onDissolve?: (ms: number) => void}} options
 */
export function createVerticalFlow(canvas, ctx, config, options) {
  const events = options || {};
  const dark = !!events.dark;
  let cfg = mergeConfig(FALLBACK_CONFIG, config);
  let h2 = makeHash(cfg.hash);

  const theme = dark ? "dark" : "light";
  let viewW = 0;
  let viewH = 0;
  let dpr = 1;
  let gw = 0;
  let gh = 0;
  let atlas = null;
  let glyphCount = 0;
  let tileSize = { w: 0, h: 0 };

  let startMs = null;
  let lastDrawMs = -1e9;
  let finished = false;
  let frames = 0;
  let q = 0;
  /** 最近 24 帧的间隔，用中位数判档——单帧抖动不该改档。 */
  const deltas = [];
  const WINDOW = 24;

  function palette() {
    return cfg.themes[theme] || cfg.themes.light;
  }

  /**
   * 字符图谱：每个非空格子一张小图，逐帧只贴图不排字。
   *
   * 字号按**设备像素**算（font.size × dpr），贴图再按 1:1 贴回画布——原型里
   * 10px 字画在 7px 格里，字比格大，上下两行的字本来就会叠在一起；贴图多留
   * 一截透明边（tileH > cell），叠出来才是那个密度，按格子缩放反而会淡成灰点。
   */
  function buildAtlas() {
    const fontPx = cfg.font.size * dpr;
    const tileW = Math.max(4, Math.round(fontPx * 0.78));
    const tileH = Math.max(4, Math.round(fontPx * 1.08));
    const font = fontPx + "px " + cfg.font.family;
    const ink = rgb(palette().ink);
    const ramp = cfg.ramp;
    const list = new Array(ramp.length);
    tileSize = { w: tileW, h: tileH };
    glyphCount = 0;
    for (let i = 0; i < ramp.length; i += 1) {
      const ch = ramp.charAt(i);
      if (ch === " ") {
        list[i] = null;
        continue;
      }
      const tile = document.createElement("canvas");
      tile.width = tileW;
      tile.height = tileH;
      const g = tile.getContext("2d");
      g.font = font;
      g.textBaseline = "top";
      g.textAlign = "left";
      g.fillStyle = ink;
      g.fillText(ch, 0, 0);
      list[i] = tile;
      glyphCount += 1;
    }
    atlas = list;
  }

  function tuneLabel() {
    const step = QUALITY[q];
    return "q" + q + " " + (step.fps ? step.fps : 60) + "fps " + Math.ceil(gw / step.colStep) + "cols x" + gh;
  }

  function applyQuality() {
    if (canvas && canvas.dataset) canvas.dataset.flowTune = tuneLabel();
  }

  /** 按当前时刻画一帧。tSec 从 0 起。 */
  function drawRain(tSec) {
    const cell = cfg.cell;
    const rain = cfg.rain;
    const step = QUALITY[q];
    const pal = palette();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = rgb(pal.paper);
    ctx.fillRect(0, 0, viewW, viewH);

    if (!atlas) return;
    const flick = Math.floor(tSec * rain.flickerHz);
    const cycle = rain.cycle * viewH;
    const drop = rain.drop * viewH;

    for (let gx = 0; gx < gw; gx += step.colStep) {
      const speed = rain.speedMin + h2(gx, 7) * (rain.speedMax - rain.speedMin);
      const span = (rain.spanMin + h2(gx, 3) * (rain.spanMax - rain.spanMin)) * viewH;
      const phase = ((tSec * viewH * speed) % cycle) - drop;
      if (phase + span <= 0) continue;

      const fromRow = Math.max(0, Math.floor(phase / cell));
      const toRow = Math.min(gh - 1, Math.ceil((phase + span) / cell));
      for (let gy = fromRow; gy <= toRow; gy += 1) {
        const pos = gy * cell;
        if (pos <= phase) continue;
        const active = 1 - (pos - phase) / span;
        if (active <= 0) continue;
        const dens = rain.density * active * (rain.base + rain.vary * h2(gx, gy, flick)) * step.density;
        if (dens <= rain.cutoff) continue;
        const idx = Math.min(9, Math.floor(dens * 9.99));
        const tile = atlas[idx];
        if (!tile) continue;
        ctx.drawImage(tile, gx * cell, gy * cell, tileSize.w / dpr, tileSize.h / dpr);
      }
    }
  }

  /**
   * 降档判据：24 帧滑动窗口的**中位数** > 18ms（稳定跑不到 55fps）就降一档。
   * 用中位数不用均值：启动那几帧、切前台那种单帧长按不该把档位打下去。
   * 当前中位数也摊在 canvas.dataset.flowMedian 上，真机取证不用自己再插桩。
   */
  function noteFrame(dtMs) {
    frames += 1;
    if (frames < 10) return;
    deltas.push(dtMs);
    if (deltas.length > WINDOW) deltas.shift();
    if (deltas.length < WINDOW) return;
    if (frames % 8 !== 0) return;
    const sorted = deltas.slice().sort((a, b) => a - b);
    const median = sorted[WINDOW >> 1];
    if (canvas && canvas.dataset) canvas.dataset.flowMedian = median.toFixed(1);
    // 18ms ≈ 55fps：稳不到 60 就降一档，宁可稀一点也别一顿一顿地走
    if (median > 18 && q < QUALITY.length - 1) {
      q += 1;
      deltas.length = 0;
      applyQuality();
    }
  }

  const player = {
    resize(width, height, nextDpr) {
      viewW = Math.max(1, Math.round(width));
      viewH = Math.max(1, Math.round(height));
      dpr = Math.min(2, Math.max(1, nextDpr || 1));
      const w = Math.floor(viewW * dpr);
      const h = Math.floor(viewH * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gw = Math.ceil(viewW / cfg.cell) + 1;
      gh = Math.ceil(viewH / cfg.cell) + 1;
      buildAtlas();
      applyQuality();
      // 立刻铺一帧：画布刚从 0×0 改成实尺寸时是空的，空一帧就是闪白
      const t = startMs === null ? 0 : (performance.now() - startMs) / 1000;
      drawRain(t);
    },

    /** 换参数（JSON 到了再换，默认值已经先跑起来了）。 */
    setConfig(next) {
      cfg = mergeConfig(cfg, next);
      h2 = makeHash(cfg.hash);
      if (viewW > 0 && viewH > 0) player.resize(viewW, viewH, dpr);
    },

    /** 宿主每帧调一次；返回 false 表示这一场演完了。 */
    frame(timeMs) {
      if (finished) return false;
      if (startMs === null) startMs = timeMs;
      const elapsed = timeMs - startMs;
      const step = QUALITY[q];
      if (elapsed >= cfg.durationMs) {
        drawRain(cfg.durationMs / 1000);
        finished = true;
        if (typeof events.onDissolve === "function") events.onDissolve(cfg.fadeMs);
        return false;
      }
      if (step.fps && timeMs - lastDrawMs < 1000 / step.fps - 4) return true;
      if (lastDrawMs > 0) noteFrame(timeMs - lastDrawMs);
      lastDrawMs = timeMs;
      drawRain(elapsed / 1000);
      return true;
    },

    /** 真机上取证用：当前档位、列数、目标帧率。 */
    tune() {
      const step = QUALITY[q];
      return { quality: q, fps: step.fps || 60, cols: Math.ceil(gw / step.colStep), rows: gh, glyphs: glyphCount };
    },
  };

  return player;
}
