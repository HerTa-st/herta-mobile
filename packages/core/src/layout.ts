/**
 * 记忆星图的布局。
 *
 * 目标只有一个：**让"哪几条是一伙的"一眼看得出来**。
 *
 * 用的是 Fruchterman–Reingold 那套标准力导向（斥力 k²/d、引力 d²/k、温度逐轮下降），
 * 不是我上一版手搓的 1/d² —— 那个在点数少的时候会把所有点弹到边界再叠在一起，
 * 画出来就像"少了好几个节点"。
 *
 * 确定性：初始位置按序号排在圆周上，不用随机数；温度按固定曲线下降。
 * 同一份数据算出来的图永远一样，否则每次打开星图节点都在乱跳，反而看不清结构。
 */

export interface GraphNodeInput {
  name: string;
  /** 有效权重，用来决定节点半径（不参与布局力，只影响画多大）。 */
  weight: number;
}

export interface GraphEdgeInput {
  a: string;
  b: string;
}

export interface GraphPoint {
  x: number;
  y: number;
}

export interface LayoutOptions {
  iterations?: number;
  /** 理想边长（0~1 单位框内）。越小，点挤得越紧。 */
  idealEdge?: number;
  /** 向中心的收力，防止孤立子图散到边角。 */
  gravity?: number;
}

export function layoutGraph(
  nodes: readonly GraphNodeInput[],
  edges: readonly GraphEdgeInput[],
  opts: LayoutOptions = {}
): Map<string, GraphPoint> {
  const iterations = opts.iterations ?? 320;
  const n = nodes.length;
  const pos = new Map<string, GraphPoint>();
  if (n === 0) return pos;
  if (n === 1) {
    pos.set(nodes[0].name, { x: 0.5, y: 0.5 });
    return pos;
  }

  const k = opts.idealEdge ?? 0.9 / Math.sqrt(n);
  const gravity = opts.gravity ?? 0.02;

  nodes.forEach((node, i) => {
    const angle = (i / n) * Math.PI * 2;
    pos.set(node.name, { x: 0.5 + Math.cos(angle) * 0.32, y: 0.5 + Math.sin(angle) * 0.32 });
  });

  const linked = edges.filter((e) => pos.has(e.a) && pos.has(e.b) && e.a !== e.b);
  let temperature = 0.12;
  const cooling = Math.pow(0.0008, 1 / iterations);

  for (let it = 0; it < iterations; it += 1) {
    const disp = new Map<string, GraphPoint>();
    for (const node of nodes) disp.set(node.name, { x: 0, y: 0 });

    // 斥力：k²/d
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const a = nodes[i].name;
        const b = nodes[j].name;
        const pa = pos.get(a)!;
        const pb = pos.get(b)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let d = Math.hypot(dx, dy);
        if (d < 1e-4) {
          // 完全重合：给一个按序号决定的确定性微扰，别用随机数
          dx = ((i % 3) - 1) * 1e-3;
          dy = ((j % 3) - 1) * 1e-3;
          d = Math.hypot(dx, dy) || 1e-3;
        }
        const f = (k * k) / d;
        const ux = (dx / d) * f;
        const uy = (dy / d) * f;
        const da = disp.get(a)!;
        const db = disp.get(b)!;
        da.x += ux;
        da.y += uy;
        db.x -= ux;
        db.y -= uy;
      }
    }

    // 引力：只有连着线的才互相拉，d²/k
    for (const e of linked) {
      const pa = pos.get(e.a)!;
      const pb = pos.get(e.b)!;
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const d = Math.hypot(dx, dy) || 1e-4;
      const f = (d * d) / k;
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      const da = disp.get(e.a)!;
      const db = disp.get(e.b)!;
      da.x -= ux;
      da.y -= uy;
      db.x += ux;
      db.y += uy;
    }

    // 位移：每轮最多走 temperature 那么远，温度逐轮降
    for (const node of nodes) {
      const p = pos.get(node.name)!;
      const dv = disp.get(node.name)!;
      dv.x += (0.5 - p.x) * gravity * (k * 10);
      dv.y += (0.5 - p.y) * gravity * (k * 10);
      const len = Math.hypot(dv.x, dv.y) || 1e-6;
      const stepLen = Math.min(len, temperature);
      p.x = Math.min(0.97, Math.max(0.03, p.x + (dv.x / len) * stepLen));
      p.y = Math.min(0.97, Math.max(0.03, p.y + (dv.y / len) * stepLen));
    }

    temperature *= cooling;
  }

  return pos;
}

/** 节点半径：权重 0..1 → 相对半径。下限保证它还能被点到。 */
export function nodeRadius(weight: number): number {
  return 0.03 + Math.max(0, Math.min(1, weight)) * 0.05;
}
