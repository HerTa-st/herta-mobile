/**
 * 过渡期只读适配：把 NMS 节点/边映射回旧的 MemoryRecord 形状。
 *
 * Q3 已决定「直接重做 UI」；这个适配层只用于旧 Drawer/Viewer 在 NMS UI 完成前
 * 还能显示记忆，不再作为写方。节点 id 编成旧文件名主键，边映射成 links。
 */
import type { MemoryRecord } from "@herta/core";
import type { NmsSnapshot } from "@herta/nms";

function legacyName(id: number, title: string): string {
  const safe = title.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) || "无题";
  return "### 废案_" + String(id).padStart(2, "0") + "：" + safe + ".txt";
}

export interface NmsView {
  records: MemoryRecord[];
  byName: Map<string, number>;
}

export function snapshotToMemoryRecords(snapshot: NmsSnapshot): NmsView {
  const byId = new Map<number, string>();
  const records: MemoryRecord[] = snapshot.nodes.map((node) => {
    const name = legacyName(node.id, node.title);
    byId.set(node.id, name);
    return {
      name,
      body: node.gist ? "### 废案：" + node.title + "\n\n" + node.gist : "### 废案：" + node.title,
      createdAt: node.createdAt,
      weight: node.weight,
      recalls: node.recalls,
      lastRecallAt: node.lastRecallAt ?? undefined,
      gist: node.gist,
      links: [],
    };
  });
  const recordById = new Map<number, MemoryRecord>();
  for (const record of records) recordById.set(Number(record.name.match(/废案_(\d+)/)?.[1] ?? 0), record);
  for (const edge of snapshot.edges) {
    const a = byId.get(edge.a);
    const b = byId.get(edge.b);
    if (!a || !b) continue;
    const ra = recordById.get(edge.a);
    const rb = recordById.get(edge.b);
    if (ra && !ra.links?.includes(b)) ra.links = [...(ra.links ?? []), b];
    if (rb && !rb.links?.includes(a)) rb.links = [...(rb.links ?? []), a];
  }
  const index = new Map<string, number>();
  for (const [id, name] of byId) index.set(name, id);
  return { records, byName: index };
}
