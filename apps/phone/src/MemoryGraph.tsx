import { useEffect, useRef } from "react";

/**
 * 记忆星图（实时物理）。
 *
 * 上一版是把布局算完再画一次，得到一张静态图。这里是**每帧算力、每帧重画**：
 * 点会自己散开、会随手指拖动、有连线的会被彼此拉住，松手后继续收敛。
 *
 * 用 canvas 而不是 SVG：每帧重建几十个 DOM 节点的代价太高，手机上会卡。
 * 物理状态放在 ref 里，不进 React state——每帧 setState 会把主线程拖死。
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
  /** 被手指按住时锁在这里 */
  held: boolean;
}

const REPULSION = 5200;
const SPRING = 0.012;
const SPRING_LEN = 130;
const GRAVITY = 0.0016;
const DAMPING = 0.86;
const MAX_SPEED = 14;

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
  const dragRef = useRef<{
    mode: "node" | "pan";
    name?: string;
    sx: number;
    sy: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  /* 节点集合变了就把新记忆接进来（老节点保留位置，别整张图重排） */
  useEffect(() => {
    const old = new Map(bodiesRef.current.map((b) => [b.name, b]));
    const w = canvasRef.current?.clientWidth ?? 320;
    bodiesRef.current = nodes.map((n, i) => {
      const prev = old.get(n.name);
      if (prev) return { ...prev, title: n.title, weight: n.weight };
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      return {
        name: n.name,
        title: n.title,
        weight: n.weight,
        x: w / 2 + Math.cos(angle) * (w * 0.28),
        y: w / 2 + Math.sin(angle) * (w * 0.28),
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

    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const v = viewRef.current;
      return {
        x: (clientX - rect.left - v.tx) / v.scale,
        y: (clientY - rect.top - v.ty) / v.scale,
      };
    };

    const hitTest = (x: number, y: number): Body | null => {
      let best: Body | null = null;
      let bestD = Infinity;
      for (const b of bodiesRef.current) {
        const d = Math.hypot(b.x - x, b.y - y);
        const r = radiusOf(b.weight) + 14; // 手指比鼠标粗，判定放宽
        if (d < r && d < bestD) {
          best = b;
          bestD = d;
        }
      }
      return best;
    };

    const radiusOf = (w: number) => 9 + Math.max(0, Math.min(1, w)) * 16;

    const step = () => {
      const bodies = bodiesRef.current;
      const n = bodies.length;

      // 斥力：两两之间
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          const a = bodies[i];
          const b = bodies[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1e-3) {
            dx = (i % 3) - 1 + 0.5;
            dy = (j % 3) - 1 + 0.5;
            d2 = dx * dx + dy * dy;
          }
          const d = Math.sqrt(d2);
          const f = REPULSION / (d2 + 400);
          const ux = (dx / d) * f;
          const uy = (dy / d) * f;
          a.vx += ux;
          a.vy += uy;
          b.vx -= ux;
          b.vy -= uy;
        }
      }

      // 引力：有连线的互相拉
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

      // 向心 + 阻尼 + 边界
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
          b.vx = Math.abs(b.vx) * 0.4;
        }
        if (b.x > width - pad) {
          b.x = width - pad;
          b.vx = -Math.abs(b.vx) * 0.4;
        }
        if (b.y < pad) {
          b.y = pad;
          b.vy = Math.abs(b.vy) * 0.4;
        }
        if (b.y > height - pad) {
          b.y = height - pad;
          b.vy = -Math.abs(b.vy) * 0.4;
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

      // 连线
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

      // 节点
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
        ctx.lineWidth = (b.held ? 2.4 : 1) / v.scale;
        ctx.strokeStyle = b.held ? "#d9c8ff" : "rgba(180,160,220,0.7)";
        ctx.stroke();
      }

      // 只给最大的几个标名字，否则会糊成一片
      const top = [...bodies].sort((a, b) => b.weight - a.weight).slice(0, 6);
      ctx.textAlign = "center";
      ctx.fillStyle = "#d6cfe4";
      for (const b of top) {
        ctx.font = 11 / v.scale + "px system-ui, sans-serif";
        ctx.fillText(b.title.slice(0, 8), b.x, b.y - radiusOf(b.weight) - 6 / v.scale);
      }

      ctx.restore();

      // 没有连线时给一句解释（画在屏幕层，不跟着缩放）
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

    /* ------------------------------------------------------ 手势 */
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      const p = toWorld(e.clientX, e.clientY);
      const hit = hitTest(p.x, p.y);
      if (hit) {
        hit.held = true;
        dragRef.current = {
          mode: "node",
          name: hit.name,
          sx: e.clientX,
          sy: e.clientY,
          lastX: e.clientX,
          lastY: e.clientY,
          moved: false,
        };
      } else {
        dragRef.current = { mode: "pan", sx: e.clientX, sy: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
      }
    };

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (Math.hypot(dx, dy) > 6) drag.moved = true;

      if (drag.mode === "node" && drag.name) {
        const p = toWorld(e.clientX, e.clientY);
        const body = bodiesRef.current.find((b) => b.name === drag.name);
        if (body) {
          body.x = p.x;
          body.y = p.y;
        }
      } else {
        // 不能用 e.movementX：触摸事件里它常常是 0，手机上会"拖不动"
        const v = viewRef.current;
        v.tx += e.clientX - drag.lastX;
        v.ty += e.clientY - drag.lastY;
      }
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
    };

    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      if (drag.mode === "node" && drag.name) {
        const body = bodiesRef.current.find((b) => b.name === drag.name);
        if (body) {
          body.held = false;
          // 松手给它一点初速度，会自己荡回去
          body.vx = 0;
          body.vy = 0;
        }
        if (!drag.moved) openRef.current(drag.name);
      }
      void e;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const next = Math.min(2.4, Math.max(0.5, v.scale * (e.deltaY > 0 ? 0.92 : 1.08)));
      // 以指针为中心缩放
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      v.tx = px - ((px - v.tx) * next) / v.scale;
      v.ty = py - ((py - v.ty) * next) / v.scale;
      v.scale = next;
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [edges]);

  /* 双指缩放 */
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      pinchRef.current = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), scale: viewRef.current.scale };
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const pinch = pinchRef.current;
    if (!pinch || e.touches.length !== 2) return;
    const [a, b] = [e.touches[0], e.touches[1]];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const v = viewRef.current;
    v.scale = Math.min(2.4, Math.max(0.5, (pinch.scale * dist) / (pinch.dist || dist)));
  };
  const onTouchEnd = () => {
    pinchRef.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      className="gcanvas"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    />
  );
}
