/**
 * 长图切片（纯算术，不碰 DOM）。
 *
 * 官方对单张图有两条硬限制：单边最长 8192 像素，每张图最多算 1024 个 token。
 * 1:13 的手机长截图（1080×14000）整张寄过去，光是边长就超了；就算收下，那 1024
 * 个 token 要摊到一万多像素的高度上，字只会糊成一团灰——她看到的正是"隔着毛玻璃"。
 * 所以先在本地按宽度切段，让每一段自己吃一份预算，边长也稳稳落在限制里。
 *
 * 这里只算坐标；真正切图在 App 的 canvas 里做。
 */

export interface ImageSlice {
  /** 在缩放后图像里的纵坐标。 */
  top: number;
  height: number;
}

export interface ImageSlices {
  /** 缩放后的宽高，切片坐标都在这张图上量。 */
  width: number;
  height: number;
  slices: ImageSlice[];
}

export interface SliceOptions {
  /** 横向最大像素。再宽就缩——缩过头字照样糊。 */
  maxWidth?: number;
  /** 每片的高宽比（片高 = 片宽 × 这个数）。1.4：一片 ≈ 960×1344，离单边 8192 很远，字还保得住。 */
  aspect?: number;
  /** 一整张塞得进单图预算就不切（省 token）。1300×1300 等效 ≈ 169 万像素，对齐官方单图 token 上限。 */
  budgetPx?: number;
  /** 片数上限：一张超长图不能把一天的额度烧穿。 */
  maxPieces?: number;
}

/**
 * 给定原图尺寸，算出缩放后的尺寸与切片边界。
 * 切片是均分的：`count` 片从 0 铺到 height，首尾相接，不留缝也不重叠。
 */
export function planImageSlices(width: number, height: number, options: SliceOptions = {}): ImageSlices {
  const { maxWidth = 960, aspect = 1.4, budgetPx = 1_650_000, maxPieces = 12 } = options;
  const srcW = Math.max(1, Math.round(width));
  const srcH = Math.max(1, Math.round(height));

  const scale = Math.min(1, maxWidth / srcW);
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const pieceH = Math.max(1, Math.round(w * aspect));
  const fit = w * h <= budgetPx;
  const count = fit ? 1 : Math.min(maxPieces, Math.max(1, Math.ceil(h / pieceH)));

  const slices: ImageSlice[] = [];
  for (let i = 0; i < count; i += 1) {
    const top = Math.round((h * i) / count);
    const bottom = i === count - 1 ? h : Math.round((h * (i + 1)) / count);
    slices.push({ top, height: Math.max(1, bottom - top) });
  }
  return { width: w, height: h, slices };
}
