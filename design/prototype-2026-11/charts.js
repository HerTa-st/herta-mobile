/* 原型用的小图表：K 线 / 记忆网络 / 迷你走势。
 * 纯 canvas、确定性数据，只负责「看起来像真的」，不做交互。
 */
window.HP = window.HP || {};
(function () {
  const HP = window.HP;

  function setup(canvas) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function bars(n) {
    let s = 20261103;
    const rnd = function () {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    let price = 1.211;
    const out = [];
    for (let i = 0; i < n; i++) {
      const drift = 0.0032 * Math.sin(i / 5.5) + 0.0011;
      const o = price;
      const c = Math.max(1.1, Math.min(1.32, o + drift + (rnd() - 0.5) * 0.02));
      const hi = Math.max(o, c) + rnd() * 0.007;
      const lo = Math.min(o, c) - rnd() * 0.007;
      out.push({ o: o, h: hi, l: lo, c: c, v: 0.35 + rnd() * 2.5 });
      price = c;
    }
    const k = 1.284 / out[out.length - 1].c;
    out.forEach(function (b) {
      b.o *= k; b.h *= k; b.l *= k; b.c *= k;
    });
    return out;
  }

  const CANDLE_CACHE = bars(54);

  function drawCandles(canvas, theme, opts) {
    const env = setup(canvas);
    if (!env) return;
    const ctx = env.ctx, W = env.w, H = env.h;
    const data = CANDLE_CACHE;
    const padL = 6, padR = opts && opts.badge ? 58 : 8, padT = 10, padB = 15;
    const priceH = (H - padT - padB) * 0.72;
    const volTop = padT + priceH + 6;
    const volH = (H - padT - padB) * 0.2;
    const innerW = W - padL - padR;
    const step = innerW / data.length;
    const bw = Math.max(1.5, Math.min(6, step * 0.58));

    let min = Infinity, max = -Infinity, vmax = 0;
    data.forEach(function (b) {
      if (b.l < min) min = b.l;
      if (b.h > max) max = b.h;
      if (b.v > vmax) vmax = b.v;
    });
    const pad = (max - min) * 0.12 || 0.01;
    min -= pad; max += pad;
    const y = function (p) { return padT + (max - p) / (max - min) * priceH; };
    const x = function (i) { return padL + i * step + step / 2; };

    ctx.clearRect(0, 0, W, H);

    // 横向网格
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.font = '9px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.fillStyle = theme.axis;
    ctx.textAlign = "left";
    for (let g = 0; g <= 3; g++) {
      const p = min + (max - min) * (g / 3);
      const yy = Math.round(y(p)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(W - padR, yy);
      ctx.stroke();
      if (opts && opts.axisLabels) {
        ctx.fillText(p.toFixed(2), W - padR + 5, yy + 3);
      }
    }

    // 蜡烛 + 成交量
    data.forEach(function (b, i) {
      const up = b.c >= b.o;
      const color = up ? theme.up : theme.down;
      const cx = x(i);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, y(b.h));
      ctx.lineTo(Math.round(cx) + 0.5, y(b.l));
      ctx.stroke();
      const top = y(Math.max(b.o, b.c));
      const hh = Math.max(1, Math.abs(y(b.o) - y(b.c)));
      if (theme.hollowDown && !up) {
        ctx.strokeRect(Math.round(cx - bw / 2) + 0.5, Math.round(top) + 0.5, Math.round(bw), Math.round(hh));
      } else {
        ctx.fillRect(Math.round(cx - bw / 2), Math.round(top), Math.max(1, Math.round(bw)), Math.max(1, Math.round(hh)));
      }
      const vh = (b.v / vmax) * volH;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(Math.round(cx - bw / 2), Math.round(volTop + volH - vh), Math.max(1, Math.round(bw)), Math.max(1, Math.round(vh)));
      ctx.globalAlpha = 1;
    });

    // MA5
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    for (let i = 4; i < data.length; i++) {
      let sum = 0;
      for (let j = i - 4; j <= i; j++) sum += data[j].c;
      const ma = sum / 5;
      const yy = y(ma);
      if (!started) { ctx.moveTo(x(i), yy); started = true; }
      else ctx.lineTo(x(i), yy);
    }
    ctx.stroke();

    // 最新价虚线
    const last = data[data.length - 1];
    const ly = y(last.c);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = theme.line;
    ctx.beginPath();
    ctx.moveTo(padL, ly);
    ctx.lineTo(W - padR, ly);
    ctx.stroke();
    ctx.restore();

    if (opts && opts.badge) {
      const text = HP.fmtPrice(last.c);
      ctx.font = '600 9px ui-monospace, "Cascadia Mono", Consolas, monospace';
      const textW = ctx.measureText(text).width;
      const bw = Math.min(Math.max(textW + 8, 30), padR - 4);
      const bx = W - padR + 2;
      ctx.fillStyle = theme.badgeBg;
      roundRect(ctx, bx, ly - 8, bw, 16, 4);
      ctx.fill();
      ctx.fillStyle = theme.badgeInk;
      ctx.textAlign = "center";
      ctx.fillText(text, bx + bw / 2, ly + 3.2, bw - 6);
    }

    // 时间刻度
    ctx.fillStyle = theme.axis;
    ctx.font = '9px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = "left";
    ["09:30", "11:30", "14:00", "15:00"].forEach(function (t, i) {
      const xx = padL + innerW * (i / 3) * 0.94;
      ctx.fillText(t, Math.min(xx, W - padR - 24), H - 3);
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  const NODE_POS = [
    [0.30, 0.23], [0.63, 0.16], [0.48, 0.44], [0.78, 0.36],
    [0.18, 0.50], [0.64, 0.60], [0.42, 0.78], [0.16, 0.80],
  ];

  function drawNetwork(canvas, theme, opts) {
    const env = setup(canvas);
    if (!env) return;
    const ctx = env.ctx, W = env.w, H = env.h;
    const nodes = HP.data.memories.nodes;
    const edges = HP.data.memories.edges;
    ctx.clearRect(0, 0, W, H);

    // 背景环
    ctx.strokeStyle = theme.ring;
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.ellipse(W / 2, H / 2, W * 0.16 * i, H * 0.14 * i, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    const pos = NODE_POS.map(function (p) { return [p[0] * W, p[1] * H]; });

    edges.forEach(function (e) {
      const a = pos[e[0]], b = pos[e[1]];
      const w = (nodes[e[0]].weight + nodes[e[1]].weight) / 2;
      ctx.strokeStyle = theme.edge;
      ctx.globalAlpha = 0.25 + w * 0.5;
      ctx.lineWidth = 0.7 + w * 1.6;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    nodes.forEach(function (n, i) {
      const p = pos[i];
      const r = 3 + n.weight * 9;
      const color = theme.tier[n.tier];
      if (theme.glow) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = theme.nodeRing;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (i < ((opts && opts.labels) || 3)) {
        ctx.fillStyle = theme.label;
        ctx.font = '9.5px "Microsoft YaHei", Inter, sans-serif';
        const plan = i === 0 ? { align: "left", dy: 14 } : i === 1 ? { align: "right", dy: -14 } : { align: "left", dy: 13 };
        ctx.textAlign = plan.align;
        const max = 5;
        const label = n.title.length > max ? n.title.slice(0, max) + "…" : n.title;
        const lx = plan.align === "right" ? p[0] - r - 4 : p[0] + r + 4;
        const ly = p[1] + 3 + plan.dy;
        if (lx > 3 && lx < W - 3 && ly > 8 && ly < H - 3) ctx.fillText(label, lx, ly, 64);
      }
    });
  }

  function drawSpark(canvas, theme) {
    const env = setup(canvas);
    if (!env) return;
    const ctx = env.ctx, W = env.w, H = env.h;
    const data = CANDLE_CACHE.slice(-26).map(function (b) { return b.c; });
    let min = Math.min.apply(null, data), max = Math.max.apply(null, data);
    if (max - min < 0.001) max = min + 0.001;
    ctx.clearRect(0, 0, W, H);
    const grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, theme.sparkFill);
    grd.addColorStop(1, "transparent");
    ctx.beginPath();
    data.forEach(function (v, i) {
      const x = (i / (data.length - 1)) * W;
      const y = 3 + (1 - (v - min) / (max - min)) * (H - 6);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = theme.spark;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fillStyle = grd;
    ctx.fill();
  }

  HP.charts = { drawCandles: drawCandles, drawNetwork: drawNetwork, drawSpark: drawSpark, bars: bars };
})();
