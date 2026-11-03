/**
 * 记忆网络画布（Canvas 2D，手写 3D 投影）。
 *
 * 从 dsh-neural-memory 的 NetworkCanvas（C:1069-1633）移植，只保留绘制内核，
 * 去掉了 fetch / SSE / 宿主 CSS token / 自转默认值：
 *
 * - 数据是 `NmsCanvasData`（见 normalize.ts），节点 id 已经是连续索引；
 * - 相机与桌面一致：yaw/pitch 旋转、缩放、透视投影 + 近大远小；
 * - 触摸：单指拖动旋转、双指捏合缩放、点按选中；命中半径 28px，点击阈值 10px；
 * - 触摸不会触发 hover tooltip（tooltip 只服务鼠标/触控板）；
 * - 移动端性能：DPR 上限 1.5、30fps + dirty flag、LOD 阈值 80/8/60，
 *   LOD 下跳过背景星云、节点辉光降级、标签不画阴影；默认关闭自转。
 *
 * 组件本身不拉数据、不写 store；激活模型由 network-view 订阅 store 后传进来。
 */

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { ACTIVATION_MIN_LEVEL, collectActivationLevels, hasActiveActivation } from "./activation.ts";
import { workspaceClusters } from "./layout.ts";
import type { NmsActivationModel, NmsCanvasData, NmsCanvasNode, NmsTier } from "./types.ts";

/** 三级记忆的展示名与颜色；列表/设置以后也会用同一套。 */
export const NMS_TIER_THEME: Record<NmsTier, { name: string; color: string }> = {
  ep: { name: "情景", color: "#3fa8a1" },
  sem: { name: "语义", color: "#8a72d6" },
  note: { name: "语气", color: "#dd6f92" },
};

/**
 * 手机端画布的性能参数。改这里就能整体调优；README 里同步列出了数值。
 */
export const NETWORK_CANVAS_LIMITS = {
  /** 2.75x 屏压到 1.5x：画布是低频重绘，1.5 已经够清晰，再高 GPU 填不满。 */
  dprCap: 1.5,
  /** 不拖拽时封顶帧率；dirty flag 保证静止时 0 帧。 */
  targetFps: 30,
  /** 可见节点超过这条线切精简视图。 */
  lodNodeThreshold: 80,
  /** 精简视图只标最重的 8 个节点。 */
  lodTopLabels: 8,
  /** 精简视图只画最强的 60 条边（选中节点的边不受限）。 */
  lodTopEdges: 60,
  /** 触摸命中半径（CSS px），比视觉半径大，手指才点得中。 */
  hitRadius: 28,
  /** 按下到抬起的位移超过这个值就算拖动，不再当点击。 */
  tapSlop: 10,
  minZoom: 0.6,
  maxZoom: 2.4,
} as const;

const LOD_NODE_THRESHOLD = NETWORK_CANVAS_LIMITS.lodNodeThreshold;
const LOD_TOP_LABELS = NETWORK_CANVAS_LIMITS.lodTopLabels;
const LOD_TOP_EDGES = NETWORK_CANVAS_LIMITS.lodTopEdges;
const TAP_SLOP = NETWORK_CANVAS_LIMITS.tapSlop;
const HIT_RADIUS = NETWORK_CANVAS_LIMITS.hitRadius;
const TARGET_FPS = NETWORK_CANVAS_LIMITS.targetFps;
const MIN_ZOOM = NETWORK_CANVAS_LIMITS.minZoom;
const MAX_ZOOM = NETWORK_CANVAS_LIMITS.maxZoom;

const THEME = {
  label: "#2f3a45",
  accent: "#6fa8ad",
  labelFamily: '-apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif',
};

export interface NetworkCanvasProps {
  data: NmsCanvasData;
  activationModel?: NmsActivationModel | null;
  selectedKey?: string | null;
  /** 点空白处会回调 null（取消选中）。 */
  onSelect?: (node: NmsCanvasNode | null) => void;
  /** 视图是否在前台；false 时 rAF 空转但不绘制。 */
  visible?: boolean;
  /** 紧凑模式隐藏 tooltip（桌面侧栏用；手机一般 false）。 */
  compact?: boolean;
  /** 默认 false：手机省电，也避免用户还没看清就在转。 */
  autoRotate?: boolean;
  children?: ReactNode;
}

interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

interface ScreenPoint {
  x: number;
  y: number;
  s: number;
  z: number;
}

interface Camera {
  yaw: number;
  pitch: number;
  dist: number;
  f: number;
  zoom: number;
}

interface PointerPosition {
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseColor(value: string): { r: number; g: number; b: number } | null {
  const color = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3) {
      return {
        r: parseInt(digits[0] + digits[0], 16),
        g: parseInt(digits[1] + digits[1], 16),
        b: parseInt(digits[2] + digits[2], 16),
      };
    }
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i.exec(color);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }
  return null;
}

/** 给主题色/层级色加透明度；解析不了就原样返回，不让画布崩。 */
function withAlpha(color: string, alpha: number): string {
  const a = clamp(alpha, 0, 1);
  const rgb = parseColor(color);
  if (!rgb) return color;
  return (
    "rgba(" +
    Math.round(rgb.r) +
    "," +
    Math.round(rgb.g) +
    "," +
    Math.round(rgb.b) +
    "," +
    a.toFixed(3) +
    ")"
  );
}

function shortenLabel(text: string, max = 18): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function overlaps(a: readonly number[], b: readonly number[]): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

export function NetworkCanvas({
  data,
  activationModel = null,
  selectedKey = null,
  onSelect,
  visible = true,
  compact = false,
  autoRotate = false,
  children,
}: NetworkCanvasProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  /** 相机跨数据刷新保留，重新过滤 tier 不会把视角甩回默认。 */
  const camRef = useRef<Camera>({ yaw: 0.65, pitch: -0.16, dist: 900, f: 1000, zoom: 1 });
  const stateRef = useRef({
    selectedKey,
    onSelect,
    visible,
    autoRotate,
  });
  const activationRef = useRef<NmsActivationModel | null>(activationModel);
  const dirtyRef = useRef(true);

  useEffect(() => {
    stateRef.current.selectedKey = selectedKey;
    dirtyRef.current = true;
  }, [selectedKey]);

  useEffect(() => {
    stateRef.current.onSelect = onSelect;
  }, [onSelect]);

  useEffect(() => {
    stateRef.current.visible = visible;
    if (visible) dirtyRef.current = true;
  }, [visible]);

  useEffect(() => {
    stateRef.current.autoRotate = autoRotate;
    dirtyRef.current = true;
  }, [autoRotate]);

  useEffect(() => {
    activationRef.current = activationModel;
    dirtyRef.current = true;
  }, [activationModel]);

  useEffect(() => {
    const wrapMaybe = wrapRef.current;
    const canvasMaybe = canvasRef.current;
    if (!wrapMaybe || !canvasMaybe) return undefined;
    // 显式非空 const：嵌套闭包里 TS 7 不会沿用外层 narrow 结果。
    const wrap: HTMLDivElement = wrapMaybe;
    const canvas: HTMLCanvasElement = canvasMaybe;
    const ctxMaybe = canvas.getContext("2d");
    if (!ctxMaybe) return undefined;
    const ctx: CanvasRenderingContext2D = ctxMaybe;

    const nodes = data.nodes;
    const edges = data.edges;
    const clusters = workspaceClusters(nodes);
    const totalNodes = nodes.length;
    const lod = totalNodes > LOD_NODE_THRESHOLD;
    const cam = camRef.current;
    const reducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // 每条边挂到两端节点；选中时用它把邻边从 LOD 的强度截断里捞回来。
    const edgesByNode: number[][] = nodes.map(() => []);
    edges.forEach((edge, index) => {
      if (edgesByNode[edge.a]) edgesByNode[edge.a].push(index);
      if (edgesByNode[edge.b]) edgesByNode[edge.b].push(index);
    });

    const topLabelIds = new Set<number>();
    let baseEdgeIndexes: number[];
    if (lod) {
      const ranked = nodes.slice().sort((left, right) => right.effectiveWeight - left.effectiveWeight || right.weight - left.weight);
      for (const node of ranked.slice(0, LOD_TOP_LABELS)) topLabelIds.add(node.id);
      baseEdgeIndexes = edges
        .map((edge, index) => ({ index, s: edge.s }))
        .sort((left, right) => right.s - left.s)
        .slice(0, LOD_TOP_EDGES)
        .map((row) => row.index);
    } else {
      baseEdgeIndexes = edges.map((_edge, index) => index);
    }

    let W = 1;
    let H = 1;
    let DPR = 1;
    let time = 0;
    let screenPos: ScreenPoint[] = [];
    // 夜间：节点/工作区标签换成浅青，不然深底下读不出来。
    let labelColor =
      typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
        ? "#9fc7d8"
        : THEME.label;
    let accentColor = THEME.accent;
    let labelFamily = THEME.labelFamily;
    let mounted = true;
    let raf = 0;

    let dragging = false;
    let tapStart: { x: number; y: number; moved: boolean; time: number } | null = null;
    let pinchState: { distance: number; zoom: number } | null = null;
    let lastX = 0;
    let lastY = 0;
    let lastInteract = 0;
    const pointers = new Map<number, PointerPosition>();

    function readTheme(): void {
      if (typeof window === "undefined") return;
      try {
        const rootStyle = window.getComputedStyle(document.documentElement);
        const ink = rootStyle.getPropertyValue("--ink").trim();
        if (ink) labelColor = ink;
        const accent = rootStyle.getPropertyValue("--accent").trim();
        if (accent) accentColor = accent;
        const family = window.getComputedStyle(document.body).fontFamily;
        if (family) labelFamily = family;
      } catch {
        /* 读不到就用 THEME 默认值 */
      }
    }

    function resize(): void {
      const rect = wrap.getBoundingClientRect();
      W = Math.max(1, rect.width);
      H = Math.max(1, rect.height);
      DPR = Math.min(NETWORK_CANVAS_LIMITS.dprCap, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(W * DPR));
      canvas.height = Math.max(1, Math.floor(H * DPR));
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      readTheme();
      dirtyRef.current = true;
    }

    function project(point: WorldPoint, yaw: number, pitch: number): ScreenPoint {
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const x = point.x * cy + point.z * sy;
      let z = -point.x * sy + point.z * cy;
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const y = point.y * cp - z * sp;
      z = point.y * sp + z * cp;
      const zz = z + cam.dist;
      // 桌面按 W/1120 缩放；手机窄，下限抬到 0.45，否则节点只有 2px。
      const zoomBase = cam.zoom * clamp(W / 900, 0.45, 0.95);
      const scale = (cam.f / Math.max(110, zz)) * zoomBase;
      return { x: W / 2 + x * scale, y: H * 0.5 + y * scale, s: scale, z: zz };
    }

    function selectedNode(): NmsCanvasNode | null {
      const key = stateRef.current.selectedKey;
      if (key === null || key === undefined) return null;
      for (const node of nodes) {
        if (node.key === key) return node;
      }
      return null;
    }

    function hideTip(): void {
      const tip = tipRef.current;
      if (tip) tip.style.opacity = "0";
    }

    function setTip(node: NmsCanvasNode | null, x: number, y: number): void {
      const tip = tipRef.current;
      if (!tip) return;
      if (!node) {
        hideTip();
        return;
      }
      const theme = NMS_TIER_THEME[node.tier];
      tip.textContent = "";
      const title = document.createElement("div");
      title.textContent = node.title;
      const sub = document.createElement("div");
      sub.className = "nmsnet-tip-sub";
      sub.textContent =
        theme.name + " · 权重 " + node.effectiveWeight.toFixed(2) + " · 关联 " + node.links.length + " 条";
      tip.appendChild(title);
      tip.appendChild(sub);
      tip.style.left = x + "px";
      tip.style.top = y + "px";
      tip.style.opacity = "1";
    }

    function draw(): void {
      if (!W || !H) return;
      const selected = selectedNode();
      const activationLevels = collectActivationLevels(activationRef.current, Date.now());
      const yaw = cam.yaw;
      const pitch = cam.pitch;
      ctx.clearRect(0, 0, W, H);

      const projected: ScreenPoint[] = new Array(nodes.length);
      for (let n = 0; n < nodes.length; n += 1) projected[n] = project(nodes[n], yaw, pitch);
      screenPos = projected;

      // 背景星云：整屏径向渐变在手机上很贵，LOD 下直接省掉；底色由 CSS 画。
      if (!lod) {
        for (const workspace of clusters) {
          const center = project(
            { x: workspace.center[0], y: workspace.center[1], z: workspace.center[2] },
            yaw,
            pitch,
          );
          const radius = Math.max(40, 300 * center.s);
          const nebula = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
          nebula.addColorStop(0, withAlpha(workspace.color, 0.1));
          nebula.addColorStop(0.55, withAlpha(workspace.color, 0.04));
          nebula.addColorStop(1, withAlpha(workspace.color, 0));
          ctx.fillStyle = nebula;
          ctx.beginPath();
          ctx.arc(center.x, center.y, radius, 0, 6.2832);
          ctx.fill();
        }
      }

      // 这一帧画哪些边：LOD 只画最强的 N 条，但选中节点及其邻居的边必须补回来。
      const edgeIndexes = lod ? baseEdgeIndexes.slice() : baseEdgeIndexes;
      if (selected !== null && lod) {
        const keep = new Set<number>();
        for (const index of edgesByNode[selected.id] ?? []) keep.add(index);
        for (const neighborId of selected.links) {
          for (const index of edgesByNode[neighborId] ?? []) keep.add(index);
        }
        const base = new Set(baseEdgeIndexes);
        keep.forEach((index) => {
          if (!base.has(index)) edgeIndexes.push(index);
        });
      }

      const drawEdges: Array<{
        a: ScreenPoint;
        b: ScreenPoint;
        s: number;
        idA: number;
        idB: number;
        depth: number;
      }> = [];
      for (const index of edgeIndexes) {
        const edge = edges[index];
        if (!edge) continue;
        const a = projected[edge.a];
        const b = projected[edge.b];
        if (!a || !b) continue;
        drawEdges.push({ a, b, s: edge.s, idA: edge.a, idB: edge.b, depth: (a.z + b.z) / 2 });
      }
      drawEdges.sort((left, right) => right.depth - left.depth);

      for (const edge of drawEdges) {
        const a = edge.a;
        const b = edge.b;
        const depthT = clamp((edge.depth - 300) / 1300, 0, 1);
        const highlighted = selected !== null && (edge.idA === selected.id || edge.idB === selected.id);
        let alpha = (0.13 + edge.s * 0.48) * (1 - depthT * 0.5);
        if (selected !== null && !highlighted) alpha *= 0.3;
        if (highlighted) alpha = Math.min(0.95, alpha * 2.4 + 0.18);
        const edgeLit = Math.min(
          activationLevels.get(nodes[edge.idA].key) ?? 0,
          activationLevels.get(nodes[edge.idB].key) ?? 0,
        );
        if (edgeLit > ACTIVATION_MIN_LEVEL) alpha = Math.min(1, alpha + edgeLit * 0.85);

        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(midX - dy * 0.16, midY + dx * 0.16, b.x, b.y);
        ctx.strokeStyle = withAlpha(accentColor, alpha);
        const lineWidth = Math.max(
          0.5,
          Math.min(
            3.4,
            ((0.55 + edge.s * 1.7) * ((a.s + b.s) / 2)) / Math.max(0.001, cam.zoom) * (highlighted ? 1.7 : 1),
          ),
        );
        ctx.lineWidth = lineWidth;
        ctx.stroke();
        if (highlighted || edge.s > 0.7) {
          ctx.strokeStyle = withAlpha(NMS_TIER_THEME.sem.color, alpha * 0.45);
          ctx.lineWidth = Math.max(0.4, lineWidth * 0.45);
          ctx.stroke();
        }
        if (edgeLit > ACTIVATION_MIN_LEVEL) {
          ctx.strokeStyle = withAlpha(accentColor, Math.min(1, edgeLit + 0.25));
          ctx.lineWidth = Math.max(0.8, lineWidth * (1.2 + edgeLit));
          ctx.stroke();
        }
      }

      const order = nodes.slice().sort((left, right) => projected[right.id].z - projected[left.id].z);
      const labelQueue: Array<{
        node: NmsCanvasNode;
        point: ScreenPoint;
        radius: number;
        isSelected: boolean;
        isNeighbor: boolean;
        fade: number;
      }> = [];

      for (const node of order) {
        const point = projected[node.id];
        if (point.x < -120 || point.x > W + 120 || point.y < -120 || point.y > H + 120) continue;
        const depth = clamp((point.z - 280) / 1300, 0, 1);
        const fade = 1 - depth * 0.45;
        const color = NMS_TIER_THEME[node.tier].color;
        const isSelected = selected !== null && node.id === selected.id;
        const isNeighbor = selected !== null && selected.nb[node.id] === 1;
        let alpha = (isSelected ? 1 : isNeighbor ? 0.96 : 0.88) * fade;
        if (selected !== null && !isSelected && !isNeighbor) alpha *= 0.5;
        const level = activationLevels.get(node.key) ?? 0;
        const isLit = level > ACTIVATION_MIN_LEVEL;
        if (isLit) alpha = Math.max(alpha, Math.min(1, 0.55 + level * 0.6));

        // LOD：只给 top 节点/选中/邻居/点亮节点画径向辉光，其余画实心小点。
        const glowOn = !lod || topLabelIds.has(node.id) || isSelected || isNeighbor || isLit;
        let radius = Math.max(
          2,
          (4.2 + node.weight * 9) * point.s * 1.15 * (1 + 0.035 * Math.sin(time * 0.0021 + node.id)),
        );
        if (glowOn) {
          const glowRadius = radius * (4.2 + level * 3.2);
          const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, glowRadius);
          glow.addColorStop(0, withAlpha(color, Math.min(1, 0.34 * alpha + level * 0.45)));
          glow.addColorStop(0.28, withAlpha(color, Math.min(1, 0.12 * alpha + level * 0.2)));
          glow.addColorStop(1, withAlpha(color, 0));
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(point.x, point.y, glowRadius, 0, 6.2832);
          ctx.fill();
          ctx.fillStyle = withAlpha(color, Math.min(1, alpha));
          ctx.beginPath();
          ctx.arc(point.x, point.y, radius, 0, 6.2832);
          ctx.fill();
          ctx.fillStyle = withAlpha("#ffffff", 0.5 * alpha);
          ctx.beginPath();
          ctx.arc(point.x - radius * 0.26, point.y - radius * 0.26, Math.max(0.6, radius * 0.38), 0, 6.2832);
          ctx.fill();
        } else {
          radius = Math.max(
            1.4,
            (2.1 + node.weight * 5.2) * point.s * 1.05 * (1 + 0.035 * Math.sin(time * 0.0021 + node.id)),
          );
          ctx.fillStyle = withAlpha(color, Math.min(1, alpha * 0.82));
          ctx.beginPath();
          ctx.arc(point.x, point.y, radius, 0, 6.2832);
          ctx.fill();
        }

        if (isSelected) {
          const pulse = radius * 2.4 + Math.sin(time * 0.004) * radius * 0.5;
          ctx.strokeStyle = withAlpha(color, 0.6 + 0.2 * Math.sin(time * 0.004));
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(point.x, point.y, pulse, 0, 6.2832);
          ctx.stroke();
        }
        if (isLit) {
          const litRing = radius * (2 + level * 1.4);
          ctx.strokeStyle = withAlpha(accentColor, Math.min(1, 0.35 + level * 0.65));
          ctx.lineWidth = 1.1 + level * 2.2;
          ctx.beginPath();
          ctx.arc(point.x, point.y, litRing, 0, 6.2832);
          ctx.stroke();
          if (level > 0.12) {
            const haloRadius = radius * (4.5 + level * 4);
            const halo = ctx.createRadialGradient(point.x, point.y, radius, point.x, point.y, haloRadius);
            halo.addColorStop(0, withAlpha(accentColor, level * 0.2));
            halo.addColorStop(1, withAlpha(accentColor, 0));
            ctx.fillStyle = halo;
            ctx.beginPath();
            ctx.arc(point.x, point.y, haloRadius, 0, 6.2832);
            ctx.fill();
          }
        }

        const showLabel = lod
          ? topLabelIds.has(node.id) || isSelected
          : node.weight > 0.68 || isSelected || isNeighbor;
        if (showLabel) {
          labelQueue.push({ node, point, radius, isSelected, isNeighbor, fade: alpha });
        }
      }

      const placed: number[][] = [];
      labelQueue.sort((left, right) => {
        const leftScore = (left.isSelected ? 3 : 0) + (left.isNeighbor ? 1 : 0);
        const rightScore = (right.isSelected ? 3 : 0) + (right.isNeighbor ? 1 : 0);
        return rightScore - leftScore;
      });
      for (const item of labelQueue) {
        const text = shortenLabel(item.node.title);
        const size = 10.5;
        ctx.font = "10.5px " + labelFamily;
        const textWidth = ctx.measureText(text).width;
        let x = item.point.x + item.radius + 8;
        const y = item.point.y;
        if (x + textWidth > W - 10) x = item.point.x - item.radius - 8 - textWidth;
        const box = [x - 2, y - size / 2 - 2, x + textWidth + 4, y + size / 2 + 2];
        let blocked = false;
        for (const other of placed) {
          if (overlaps(box, other)) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        placed.push(box);
        const alpha = Math.min(1, (item.isSelected ? 0.98 : item.isNeighbor ? 0.86 : 0.55) * (0.6 + item.fade * 0.4));
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = labelColor;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        if (!lod) {
          // 浅色底上文字用白色微光压住线条；LOD 下关掉 shadowBlur 省填充率。
          ctx.shadowColor = withAlpha("#ffffff", 0.9);
          ctx.shadowBlur = 3;
        }
        ctx.fillText(text, x, y);
        ctx.restore();
      }

      // 平板/横屏才画 workspace 名；手机上宽度不够，画了只会互相压。
      if (W > 600) {
        for (const workspace of clusters) {
          const center = project(
            { x: workspace.center[0], y: workspace.center[1], z: workspace.center[2] },
            yaw,
            pitch,
          );
          ctx.save();
          ctx.font = "9.5px " + labelFamily;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = withAlpha(labelColor, 0.42);
          ctx.fillText(workspace.name, center.x, center.y - Math.max(70, 190 * center.s));
          ctx.restore();
        }
      }
    }

    function hitTest(clientX: number, clientY: number, radiusPx: number): NmsCanvasNode | null {
      const rect = canvas.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      let best: NmsCanvasNode | null = null;
      let bestDistance = radiusPx * radiusPx;
      for (let i = 0; i < nodes.length; i += 1) {
        const point = screenPos[i];
        if (!point) continue;
        const dx = point.x - mx;
        const dy = point.y - my;
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = nodes[i];
        }
      }
      return best;
    }

    function pointerDistance(): number {
      const points = [...pointers.values()];
      if (points.length < 2) return 1;
      return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) || 1;
    }

    function onPointerDown(event: PointerEvent): void {
      event.preventDefault();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* 某些 WebView 不支持捕获；仍可收到画布内的 move */
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      hideTip();
      lastInteract = performance.now();

      if (pointers.size >= 2) {
        // 第二根手指（或更多）进来：退出旋转/点击，进入捏合。
        tapStart = null;
        dragging = false;
        pinchState = { distance: pointerDistance(), zoom: cam.zoom };
        return;
      }
      tapStart = { x: event.clientX, y: event.clientY, moved: false, time: Date.now() };
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
    }

    function onPointerMove(event: PointerEvent): void {
      const stored = pointers.get(event.pointerId);
      if (!stored) {
        // 鼠标悬停：触摸不会走到这里，所以 tooltip 天然只在桌面/触控板出现。
        if (event.pointerType === "mouse" && !dragging) {
          const hovered = hitTest(event.clientX, event.clientY, 18);
          if (hovered) {
            const rect = canvas.getBoundingClientRect();
            setTip(hovered, event.clientX - rect.left, event.clientY - rect.top);
            canvas.style.cursor = "pointer";
          } else {
            hideTip();
            canvas.style.cursor = "grab";
          }
        }
        return;
      }

      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pinchState && pointers.size >= 2) {
        const distance = pointerDistance();
        cam.zoom = clamp(pinchState.zoom * (distance / pinchState.distance), MIN_ZOOM, MAX_ZOOM);
        lastInteract = performance.now();
        dirtyRef.current = true;
        return;
      }

      if (dragging && pointers.size === 1) {
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;
        if (tapStart && Math.hypot(event.clientX - tapStart.x, event.clientY - tapStart.y) > TAP_SLOP) {
          tapStart.moved = true;
        }
        if (dx !== 0 || dy !== 0) {
          cam.yaw += dx * 0.006;
          cam.pitch = clamp(cam.pitch + dy * 0.005, -1.15, 1.15);
          dirtyRef.current = true;
        }
        lastInteract = performance.now();
      }
    }

    function onPointerUp(event: PointerEvent): void {
      const wasDragging = dragging;
      pointers.delete(event.pointerId);

      if (pinchState) {
        if (pointers.size < 2) {
          pinchState = null;
          tapStart = null;
          if (pointers.size === 1) {
            const only = [...pointers.values()][0];
            lastX = only.x;
            lastY = only.y;
            dragging = true;
          } else {
            dragging = false;
          }
        } else {
          // 三指抬起一指后，剩下的两指重新定基准，避免缩放跳一下。
          pinchState = { distance: pointerDistance(), zoom: cam.zoom };
        }
        lastInteract = performance.now();
        return;
      }

      if (wasDragging && tapStart && !tapStart.moved && Date.now() - tapStart.time < 600 && pointers.size === 0) {
        const picked = hitTest(event.clientX, event.clientY, HIT_RADIUS);
        const select = stateRef.current.onSelect;
        if (select) {
          if (picked) select(picked);
          else if (stateRef.current.selectedKey !== null) select(null);
        }
      }

      tapStart = null;
      if (pointers.size === 0) dragging = false;
      lastInteract = performance.now();
    }

    function onPointerCancel(event: PointerEvent): void {
      pointers.delete(event.pointerId);
      if (pointers.size === 0) {
        dragging = false;
        tapStart = null;
        pinchState = null;
      }
      lastInteract = performance.now();
    }

    function onPointerLeave(): void {
      if (!dragging) hideTip();
    }

    function onWheel(event: WheelEvent): void {
      event.preventDefault();
      cam.zoom = clamp(cam.zoom * (event.deltaY > 0 ? 0.93 : 1.07), MIN_ZOOM, MAX_ZOOM);
      lastInteract = performance.now();
      dirtyRef.current = true;
    }

    function onVisibilityChange(): void {
      if (!document.hidden) dirtyRef.current = true;
    }

    function onContextMenu(event: Event): void {
      // 长按不要弹系统菜单/选择菜单；手机上没有可复制的画布内容。
      event.preventDefault();
    }

    let lastDrawAt = 0;
    let lastFrameAt = 0;
    let wasActive = false;

    function loop(timestamp: number): void {
      if (!mounted) return;
      raf = requestAnimationFrame(loop);
      if (!stateRef.current.visible) {
        lastFrameAt = timestamp;
        return;
      }

      if (stateRef.current.autoRotate && !reducedMotion && !dragging && performance.now() - lastInteract > 1800) {
        const delta = lastFrameAt > 0 ? Math.min(64, timestamp - lastFrameAt) : 16.7;
        cam.yaw += 0.0016 * (delta / 16.7);
        dirtyRef.current = true;
      }
      lastFrameAt = timestamp;

      const active = hasActiveActivation(activationRef.current, Date.now());
      if (active || wasActive) dirtyRef.current = true;
      wasActive = active;

      if (!dirtyRef.current) return;
      if (timestamp - lastDrawAt < 1000 / TARGET_FPS - 1) return;
      lastDrawAt = timestamp;
      time = timestamp;
      draw();
      dirtyRef.current = false;
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("visibilitychange", onVisibilityChange);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        resize();
        dirtyRef.current = true;
      });
      observer.observe(wrap);
    }
    window.addEventListener("resize", resize);

    resize();
    draw();
    dirtyRef.current = false;
    raf = requestAnimationFrame(loop);

    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
      if (observer) observer.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
    };
  }, [data]);

  return (
    <div
      ref={wrapRef}
      className={"nmsnet-canvas-wrap" + (compact ? " compact" : "")}
      style={{ position: "relative", flex: "1 1 auto", minHeight: 0, overflow: "hidden" }}
    >
      <canvas
        ref={canvasRef}
        className="nmsnet-canvas"
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          touchAction: "none",
          cursor: "grab",
        }}
        role="img"
        aria-label="记忆网络：单指拖动旋转、双指缩放、点节点查看详情"
      />
      <div
        ref={tipRef}
        className="nmsnet-tip"
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          opacity: 0,
          pointerEvents: "none",
          transform: "translate(-50%, -135%)",
          zIndex: 3,
        }}
      />
      {children}
    </div>
  );
}
