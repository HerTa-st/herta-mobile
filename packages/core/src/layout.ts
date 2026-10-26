/**
 * 记忆星图的布局。
 *
 * 目标只有一个：**让"哪几条是一伙的"一眼看得出来**。所以用最朴素的力导向——
 * 互相排斥、有连线的互相吸引、整体往中心收。不做花哨动画，也不引入图形库。
 *
 * 确定性：初始位置按序号排在圆周上，不用随机数。同一份数据算出来的图永远一样，
 * 否则每次打开星图节点都在乱跳，反而看不清结构。
 */

export interface GraphNodeInput {
  name: string;
  /** 有效权重，用来决定节点半径（这里不参与布局力，只影响画多大）。 */
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
  /** 排斥半径，相对单位方框。 */
  repulsion?: number;
  /** 有连线的吸引强度。 */
  attraction?: number;
  /** 向中心的收紧。 */
  gravity?: number;
}

/** 归一化到 [0,1] 的坐标。 */
export function layoutGraph(
  nodes: readonly GraphNodeInput[],
  edges: readonly GraphEdgeInput[],
  opts: LayoutOptions = {}
): Map<string, GraphPoint> {
  const iterations = opts.iterations ?? 260;
  const repulsion = opts.repulsion ?? 0.012;
  const attraction = opts.attraction ?? 0.035;
  const gravity = opts.gravity ?? 0.004;

  const n = nodes.length;
  const pos = new Map<string, GraphPoint>();
  if (n === 0) return pos;

  nodes.forEach((node, i) => {
    const angle = (i / n) * Math.PI * 2;
    const r = n === 1 ? 0 : 0.34;
    pos.set(node.name, { x: 0.5 + Math.cos(angle) * r, y: 0.5 + Math.sin(angle) * r });
  });
  if (n === 1) {
    pos.set(nodes[0].name, { x: 0.5, y: 0.5 });
    return pos;
  }

  const linked = edges.filter((e) => pos.has(e.a) && pos.has(e.b) && e.a !== e.b);
  const step = 0.5;

  for (let it = 0; it < iterations; it += 1) {
    const force = new Map<string, GraphPoint>();
    for (const node of nodes) force.set(node.name, { x: 0, y: 0 });

    // 排斥：所有两两之间
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const a = nodes[i].name;
        const b = nodes[j].name;
        const pa = pos.get(a)!;
        const pb = pos.get(b)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) {
          // 完全重合时给一个确定性的微扰，避免除零
          dx = (i % 2 === 0 ? 1 : -1) * 1e-3;
          dy = (j % 2 === 0 ? 1 : -1) * 1e-3;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const f = repulsion / d2;
        const ux = dx / d;
        const uy = dy / d;
        const fa = force.get(a)!;
        const fb = force.get(b)!;
        fa.x += ux * f;
        fa.y += uy * f;
        fb.x -= ux * f;
        fb.y -= uy * f;
      }
    }

    // 吸引：只有连着线的才互相拉
    for (const e of linked) {
      const pa = pos.get(e.a)!;
      const pb = pos.get(e.b)!;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const f = attraction * d;
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      const fa = force.get(e.a)!;
      const fb = force.get(e.b)!;
      fa.x += ux;
      fa.y += uy;
      fb.x -= ux;
      fb.y -= uy;
    }

    // 向心 + 位移
    for (const node of nodes) {
      const p = pos.get(node.name)!;
      const f = force.get(node.name)!;
      f.x += (0.5 - p.x) * gravity;
      f.y += (0.5 - p.y) * gravity;
      p.x = Math.min(0.98, Math.max(0.02, p.x + f.x * step));
      p.y = Math.min(0.98, Math.max(0.02, p.y + f.y * step));
    }
  }

  return pos;
}

/** 节点半径：权重 0..1 → 相对半径。下限保证它还能被点到。 */
export function nodeRadius(weight: number): number {
  return 0.025 + Math.max(0, Math.min(1, weight)) * 0.055;
}
