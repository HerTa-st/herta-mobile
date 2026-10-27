/**
 * 开屏段落的裁剪（纯算术）。
 *
 * 原始段落是桌面宽屏（1908×1080）。整张塞进手机，画面只有两百来像素高，
 * 字符全糊成灰点。这里按 detail 层（她本人）的包围盒裁一刀、四周留 4%，
 * 手机上她的像就占满宽度、字符也回到能认的大小。
 *
 * 帧数据是按「第 f 帧 × 第 i 个格子」平铺的字节数组，裁格子就得重排；
 * 层名则按保留格子的连续段重新登记，别让细节层掉成默认层。
 */
function cropToFigure(data: any) {
  const layers: any[] = Array.isArray(data.layers) ? data.layers : [];
  const detail = layers.find((l) => l && l.name === "detail");
  if (!detail || !Array.isArray(data.cells) || typeof data.framesBase64 !== "string") return data;

  const start = Math.max(0, Math.trunc(detail.start));
  const end = Math.min(data.cells.length, start + Math.trunc(detail.count));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = start; i < end; i += 1) {
    const c = data.cells[i];
    if (!c) continue;
    x0 = Math.min(x0, c[0]); y0 = Math.min(y0, c[1]);
    x1 = Math.max(x1, c[0]); y1 = Math.max(y1, c[1]);
  }
  if (!Number.isFinite(x0) || x1 <= x0 || y1 <= y0) return data;

  const padX = (x1 - x0) * 0.04;
  const padY = (y1 - y0) * 0.04;
  const rect = {
    x: Math.max(0, Math.floor(x0 - padX)),
    y: Math.max(0, Math.floor(y0 - padY)),
    w: Math.ceil(x1 - x0 + padX * 2),
    h: Math.ceil(y1 - y0 + padY * 2),
  };

  const layerName = new Array<string>(data.cells.length).fill("default");
  for (const layer of layers) {
    const s = Math.max(0, Math.trunc(layer.start));
    const e = Math.min(data.cells.length, s + Math.trunc(layer.count));
    for (let i = s; i < e; i += 1) layerName[i] = layer.name || "default";
  }

  const inside = (c: any) =>
    c && c[0] >= rect.x && c[0] < rect.x + rect.w && c[1] >= rect.y && c[1] < rect.y + rect.h;

  const kept: number[] = [];
  for (let i = 0; i < data.cells.length; i += 1) if (inside(data.cells[i])) kept.push(i);
  if (kept.length === 0) return data;

  const active = Math.trunc(data.activeCount);
  const frames = Math.trunc(data.frameCount);
  const bytes = Uint8Array.from(atob(data.framesBase64), (ch) => ch.charCodeAt(0));
  const out = new Uint8Array(kept.length * frames);
  for (let f = 0; f < frames; f += 1) {
    const src = f * active;
    const dst = f * kept.length;
    for (let j = 0; j < kept.length; j += 1) out[dst + j] = bytes[src + kept[j]] ?? 0;
  }

  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < out.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(out.subarray(i, i + CHUNK)));
  }

  // 保留格子的层名按连续段重新登记
  const nextLayers: any[] = [];
  for (let j = 0; j < kept.length; j += 1) {
    const name = layerName[kept[j]];
    const last = nextLayers[nextLayers.length - 1];
    if (last && last.name === name) last.count += 1;
    else nextLayers.push({ name, start: j, count: 1 });
  }

  return {
    ...data,
    width: rect.w,
    height: rect.h,
    cells: kept.map((i) => {
      const c = data.cells[i];
      return [c[0] - rect.x, c[1] - rect.y, c[2]];
    }),
    activeCount: kept.length,
    framesBase64: btoa(binary),
    layers: nextLayers,
  };
}

export { cropToFigure as cropSegmentToFigure };
