/**
 * 网络视图的确定性布局（从 dsh-neural-memory 的 client 移植）。
 *
 * 桌面版按 workspace 把情景记忆分散成几团；手机端是单 workspace（null），
 * 所有 ep 会落到同一个「工作区」簇里。语义/语气层仍然围在中心。
 * 位置由 key 的 FNV-1a 哈希 + Park–Miller 随机数生成，同一批节点每次刷新
 * 都落在同一处，不需要把坐标写进数据库。
 */

import type { NmsTier } from "./types.ts";

export type WorkspaceCenter = readonly [number, number, number];

export interface WorkspaceCluster {
  name: string;
  color: string;
  center: WorkspaceCenter;
}

/** assignPositions 需要的最小节点形状；NmsCanvasNode 结构上满足它。 */
export interface LayoutNode {
  key: string;
  tier: NmsTier;
  workspace: string | null;
  x: number;
  y: number;
  z: number;
}

const WS_PALETTE: readonly string[] = [
  "#5f8f74",
  "#7d6aa6",
  "#a5776a",
  "#4f7f9f",
  "#9f7a5f",
  "#5f8f9f",
];

/**
 * 桌面版老 workspace 的固定中心。手机端 workspace 固定 null，一般用不到；
 * 留着是为了旧数据迁移/测试快照里出现这些名字时布局仍然稳定。
 */
const WS_CENTER_HINTS: Readonly<Record<string, WorkspaceCenter>> = {
  "herta-mobile": [-300, -40, -90],
  "dsh-herta": [300, -70, 110],
  "工作区 / HerTa": [10, 200, -190],
  HerTa: [10, 200, -190],
};

/** 按情景记忆的 workspace 分组；没有 ep 时返回空数组。 */
export function workspaceClusters(
  nodes: readonly Pick<LayoutNode, "tier" | "workspace">[],
): WorkspaceCluster[] {
  const names: string[] = [];
  for (const node of nodes) {
    if (node.tier !== "ep") continue;
    const name = node.workspace || "工作区";
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return [];
  return names.map((name, index) => {
    const hinted = WS_CENTER_HINTS[name];
    let center: WorkspaceCenter;
    if (hinted) {
      center = hinted;
    } else {
      const angle = (index / Math.max(1, names.length)) * Math.PI * 2 - Math.PI / 2;
      center = [
        Math.cos(angle) * 310,
        (index % 2 === 0 ? -1 : 1) * 60,
        Math.sin(angle) * 310,
      ];
    }
    return { name, color: WS_PALETTE[index % WS_PALETTE.length], center };
  });
}

/** FNV-1a 32 位；和桌面实现同算法，布局可复现。 */
export function hashString(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Park–Miller 最小标准发生器，返回 [0,1)。 */
export function seededRng(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/**
 * 给还没有坐标的节点写 x/y/z。已有有限坐标的节点保持不动；
 * 调用方一般把 x/y/z 初始化成 NaN。
 */
export function assignPositions(nodes: LayoutNode[]): void {
  const clusters = workspaceClusters(nodes);
  const clusterIndex = new Map<string, number>();
  clusters.forEach((cluster, index) => clusterIndex.set(cluster.name, index));

  for (const node of nodes) {
    if (Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z)) {
      continue;
    }
    const rnd = seededRng(hashString(String(node.key)));
    const angle = rnd() * Math.PI * 2;
    if (node.tier === "ep") {
      const index = clusterIndex.get(node.workspace || "工作区");
      const cluster = clusters[index === undefined ? 0 : index];
      const center: WorkspaceCenter = cluster ? cluster.center : [0, 0, 0];
      const radius = 60 + rnd() * 150;
      node.x = center[0] + Math.cos(angle) * radius;
      node.y = center[1] + (rnd() - 0.5) * 180;
      node.z = center[2] + Math.sin(angle) * radius;
    } else if (node.tier === "sem") {
      const radius = 45 + rnd() * 110;
      node.x = Math.cos(angle) * radius * 1.5;
      node.y = (rnd() - 0.5) * 230;
      node.z = Math.sin(angle) * radius * 1.5;
    } else {
      const radius = 150 + rnd() * 170;
      node.x = Math.cos(angle) * radius;
      node.y = (rnd() - 0.5) * 200;
      node.z = Math.sin(angle) * radius;
    }
  }
}
