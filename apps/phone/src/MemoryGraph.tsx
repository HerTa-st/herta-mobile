import { useEffect, useRef } from "react";

/**
 * 记忆星图（实时物理 + 手势）。
 *
 * 上一版的两个硬伤，都写在这里的原因里：
 *
 * 1. **断触**：canvas 的 `touch-action` 没关。浏览器把"按住拖动"当成滚动/缩放手势，
 *    手指一动就发 pointercancel 把手势收走——表现就是拖到一半球被扔掉。
 *    现在 CSS 里 `touch-action: none`，并显式 preventDefault。
 *
 * 2. **多指乱飞**：原来是单个 dragRef，第二根手指一按就把第一根的记录覆盖了，
 *    被按住的那个球永远 `held`（于是被钉在原地），后面又来一个 pan，
 *    两种模式同时改坐标——看着就是乱飞。
 *    现在按 pointerId 记账：一根手指才可能是"拖球"或"平移"，两根手指一律进缩放，
 *    进缩放前先把手里的球松开。
 */

export interface GraphNode {
  name: string;
  title: string;
  weight: number;
}

export interface GraphEdge {
  a: string;
  b: string;
}

interface Body {
  name: string;
  title: string;
  weight: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  held: boolean;
}

const REPULSION = 2600;
const SPRING = 0.012;
const SPRING_LEN = 120;
const GRAVITY = 0.0016;
const DAMPING = 0.84;
const MAX_SPEED = 9;
const MAX_PAIR_FORCE = 3.2;

const radiusOf = (w: number) => 9 + Math.max(0, Math.min(1, w)) * 16;

export function MemoryGraph({
  nodes,
  edges,
  onOpen,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onOpen: (name: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodiesRef = useRef<Body[]>([]);
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  /* 节点集合变了就接进来：老节点保留位置，别整张图重排 */
  useEffect(() => {
    const old = new Map(bodiesRef.current.map((b) => [b.name, b]));
    const w = canvasRef.current?.clientWidth ?? 320;
    const h = canvasRef.current?.clientHeight ?? 320;
    bodiesRef.current = nodes.map((n, i) => {
      const prev = old.get(n.name);
      if (prev) return { ...prev, title: n.title, weight: n.weight };
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      return {
        name: n.name,
        title: n.title,
        weight: n.weight,
        x: w / 2 + Math.cos(angle) * Math.min(w, h) * 0.3,
        y: h / 2 + Math.sin(angle) * Math.min(w, h) * 0.3,
        vx: 0,
        vy: 0,
        held: false,
      };
    });
  }, [nodes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    /* ------------------------------------------------------------ 手势状态 */
    const pointers = new Map<number, { x: number; y: number }>();
    let mode: "idle" | "node" | "pan" | "pinch" = "idle";
    let held: Body | null = null;
    let panLast = { x: 0, y: 0 };
    let downAt = { x: 0, y: 0 };
    let moved = false;
    let pinchStart = { dist: 0, scale: 1 };

    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const v = viewRef.current;
      return { x: (clientX - rect.left - v.tx) / v.scale, y: (clientY - rect.top - v.ty) / v.scale };
    };

    const hitTest = (x: number, y: number): Body | null => {
      let best: Body | null = null;
      let bestD = Infinity;
      for (const b of bodiesRef.current) {
        const d = Math.hypot(b.x - x, b.y - y);
        if (d < radiusOf(b.weight) + 18 && d < bestD) {
          best = b;
          bestD = d;
        }
      }
      return best;
    };

    const twoPointers = () => [...pointers.values()].slice(0, 2);

    const releaseHeld = () => {
      if (held) {
        held.held = false;
        held.vx = 0;
        held.vy = 0;
        held = null;
      }
    };

    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size >= 2) {
        // 第二根手指进来：立刻退出拖球/平移，改成缩放
        releaseHeld();
        mode = "pinch";
        const [a, b] = twoPointers();
        pinchStart = {
          dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          scale: viewRef.current.scale,
        };
        return;
      }

      const p = toWorld(e.clientX, e.clientY);
      const hit = hitTest(p.x, p.y);
      downAt = { x: e.clientX, y: e.clientY };
      moved = false;

      if (hit) {
        hit.held = true;
        held = hit;
        mode = "node";
      } else {
        mode = "pan";
        panLast = { x: e.clientX, y: e.clientY };
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (mode === "pinch") {
        if (pointers.size < 2) return;
        const [a, b] = twoPointers();
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const v = viewRef.current;
        v.scale = Math.min(2.4, Math.max(0.55, (pinchStart.scale * dist) / pinchStart.dist));
        return;
      }

      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) moved = true;

      if (mode === "node" && held) {
        const p = toWorld(e.clientX, e.clientY);
        held.x = p.x;
        held.y = p.y;
        return;
      }

      if (mode === "pan") {
        const v = viewRef.current;
        v.tx += e.clientX - panLast.x;
        v.ty += e.clientY - panLast.y;
        panLast = { x: e.clientX, y: e.clientY };
      }
    };

    const endPointer = (e: PointerEvent) => {
      pointers.delete(e.pointerId);

      if (mode === "node" && held) {
        const name = held.name;
        releaseHeld();
        // 没挪动过 = 点了一下 → 打开这条记忆
        if (!moved) openRef.current(name);
      }

      if (pointers.size === 0) {
        mode = "idle";
        moved = false;
      } else if (mode === "pinch" && pointers.size === 1) {
        // 从双指回到单指：接着平移，别跳
        const [only] = [...pointers.values()];
        panLast = { x: only.x, y: only.y };
        mode = "pan";
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const next = Math.min(2.4, Math.max(0.55, v.scale * (e.deltaY > 0 ? 0.92 : 1.08)));
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      v.tx = px - ((px - v.tx) * next) / v.scale;
      v.ty = py - ((py - v.ty) * next) / v.scale;
      v.scale = next;
    };

    const onContextMenu = (e: Event) => e.preventDefault();

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);

    /* -------------------------------------------------------------- 物理 */
    const step = () => {
      const bodies = bodiesRef.current;
      const n = bodies.length;

      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          const a = bodies[i];
          const b = bodies[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1e-3) {
            dx = ((i % 3) - 1) + 0.5;
            dy = ((j % 3) - 1) + 0.5;
            d2 = dx * dx + dy * dy;
          }
          const d = Math.sqrt(d2);
          // 力要封顶，否则两个几乎重合的点会把彼此弹飞，整张图抖成癫痫
          const f = Math.min(REPULSION / (d2 + 400), MAX_PAIR_FORCE);
          const ux = (dx / d) * f;
          const uy = (dy / d) * f;
          a.vx += ux;
          a.vy += uy;
          b.vx -= ux;
          b.vy -= uy;
        }
      }

      for (const e of edges) {
        const a = bodies.find((b) => b.name === e.a);
        const b = bodies.find((x) => x.name === e.b);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = (d - SPRING_LEN) * SPRING;
        const ux = (dx / d) * f;
        const uy = (dy / d) * f;
        a.vx += ux;
        a.vy += uy;
        b.vx -= ux;
        b.vy -= uy;
      }

      const cx = width / 2;
      const cy = height / 2;
      for (const b of bodies) {
        if (b.held) {
          b.vx = 0;
          b.vy = 0;
          continue;
        }
        b.vx += (cx - b.x) * GRAVITY;
        b.vy += (cy - b.y) * GRAVITY;
        b.vx *= DAMPING;
        b.vy *= DAMPING;
        const speed = Math.hypot(b.vx, b.vy);
        if (speed > MAX_SPEED) {
          b.vx = (b.vx / speed) * MAX_SPEED;
          b.vy = (b.vy / speed) * MAX_SPEED;
        }
        b.x += b.vx;
        b.y += b.vy;
        const pad = 24;
        if (b.x < pad) {
          b.x = pad;
          b.vx = Math.abs(b.vx) * 0.3;
        }
        if (b.x > width - pad) {
          b.x = width - pad;
          b.vx = -Math.abs(b.vx) * 0.3;
        }
        if (b.y < pad) {
          b.y = pad;
          b.vy = Math.abs(b.vy) * 0.3;
        }
        if (b.y > height - pad) {
          b.y = height - pad;
          b.vy = -Math.abs(b.vy) * 0.3;
        }
      }
    };

    const draw = () => {
      const v = viewRef.current;
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(v.tx, v.ty);
      ctx.scale(v.scale, v.scale);

      const bodies = bodiesRef.current;
      const byName = new Map(bodies.map((b) => [b.name, b]));

      ctx.strokeStyle = "rgba(122,101,170,0.55)";
      ctx.lineWidth = 1.2 / v.scale;
      for (const e of edges) {
        const a = byName.get(e.a);
        const b = byName.get(e.b);
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      for (const b of bodies) {
        const r = radiusOf(b.weight);
        const grad = ctx.createRadialGradient(b.x - r * 0.3, b.y - r * 0.3, r * 0.2, b.x, b.y, r);
        if (b.weight > 0.7) {
          grad.addColorStop(0, "#a98bff");
          grad.addColorStop(1, "#5b34d6");
        } else if (b.weight > 0.4) {
          grad.addColorStop(0, "#6fa8c9");
          grad.addColorStop(1, "#2f5872");
        } else {
          grad.addColorStop(0, "#4a6a80");
          grad.addColorStop(1, "#22323f");
        }
        ctx.beginPath();
        ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.lineWidth = (b.held ? 2.6 : 1) / v.scale;
        ctx.strokeStyle = b.held ? "#e6d9ff" : "rgba(180,160,220,0.7)";
        ctx.stroke();
      }

      const top = [...bodies].sort((a, b) => b.weight - a.weight).slice(0, 6);
      ctx.textAlign = "center";
      ctx.fillStyle = "#d6cfe4";
      for (const b of top) {
        ctx.font = 11 / v.scale + "px system-ui, sans-serif";
        ctx.fillText(b.title.slice(0, 8), b.x, b.y - radiusOf(b.weight) - 7 / v.scale);
      }

      ctx.restore();

      if (edges.length === 0 && bodies.length > 0) {
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(200,190,215,0.6)";
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillText("还没有连线——攒到 20 条时她会把相关的自己串起来", width / 2, height - 16);
      }
    };

    const loop = () => {
      step();
      draw();
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", endPointer);
      canvas.removeEventListener("pointercancel", endPointer);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
    };
  }, [edges]);

  return <canvas ref={canvasRef} className="gcanvas" />;
}
