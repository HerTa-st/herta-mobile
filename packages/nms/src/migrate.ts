/**
 * 旧手机端记忆 → NMS 节点/边的一次性迁移。
 *
 * 映射（ADR/设计 §5）：
 *   · 无 sessionId 的种子 → note；自造废案 → ep
 *   · title = 首行标题；body/gist/weight/recalls/时间/forgotten 保留
 *   · 旧 links（存 name）→ assoc 边；旧 name/tag/deepenNote 进 history
 *   · 旧 DreamState.voice 冻结进 meta，不参与 NMS 自动语气
 */
import type { LegacyDreamState, LegacyMemoryRecord, NmsMigrationResult, NmsNode, NmsTier } from "./types.ts";
import type { NmsStore } from "./store.ts";

export const LEGACY_MIGRATED_KEY = "legacy_migrated";
export const LEGACY_MIGRATED_AT_KEY = "legacy_migrated_at";
export const LEGACY_VOICE_KEY = "frozen_voice";

function titleOf(record: LegacyMemoryRecord): string {
  const first = String(record.body ?? "").split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const match = first.match(/^###\s*废案(?:_\d+)?[：:]\s*(.+?)\s*$/);
  if (match && match[1].trim().length > 0) return match[1].trim();
  return String(record.name ?? "")
    .replace(/^###\s*/, "")
    .replace(/^废案(?:_\d+)?[：:]\s*/, "")
    .replace(/\.txt$/i, "")
    .trim();
}

function gistOf(record: LegacyMemoryRecord): string {
  const gist = String(record.gist ?? "").trim();
  if (gist.length > 0) return gist;
  return String(record.body ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
}

function weightOf(record: LegacyMemoryRecord): number {
  if (typeof record.weight === "number" && Number.isFinite(record.weight)) return Math.max(0, Math.min(1, record.weight));
  return record.sessionId === undefined ? 0.55 : 0.5;
}

/**
 * 迁移。幂等：meta legacy_migrated=1 后直接返回 0。
 *
 * 失败时抛错且不写 mark；调用方应保留旧 IndexedDB 并走只读回退。
 */
export async function migrateLegacyMemories(
  store: NmsStore,
  records: readonly LegacyMemoryRecord[],
  dreamState: LegacyDreamState | null,
  options: { now?: number } = {},
): Promise<NmsMigrationResult> {
  const nowIso = new Date(options.now ?? Date.now()).toISOString();
  const byLegacyName = new Map<string, NmsNode>();
  let imported = 0;
  let notes = 0;
  let episodes = 0;

  // 幂等靠「history.legacyName」而不是 meta 标记：备份恢复后旧库会多出新记录，
  // 再 refresh 一次时只导入没见过的，不会重复建节点。
  const existing = await store.listNodes({ includeArchived: true, includeForgotten: true });
  for (const node of existing) {
    for (const entry of node.history) {
      if (entry.kind === "migrate" && typeof entry.legacyName === "string") byLegacyName.set(entry.legacyName, node);
    }
  }

  for (const record of [...records].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    if (byLegacyName.has(record.name)) continue;
    const tier: NmsTier = record.sessionId === undefined ? "note" : "ep";
    const history = [
      { at: nowIso, kind: "migrate", legacyName: record.name },
      ...(record.tag ? [{ at: nowIso, kind: "legacy-tag", tag: record.tag }] : []),
      ...(record.deepenNote ? [{ at: nowIso, kind: "legacy-deepen", note: record.deepenNote }] : []),
    ];
    const node = await store.insertNode({
      tier,
      persona: "herta",
      workspace: null,
      title: titleOf(record) || record.name,
      gist: gistOf(record),
      body: String(record.body ?? ""),
      weight: weightOf(record),
      recalls: record.recalls ?? 0,
      createdAt: record.createdAt || nowIso,
      lastRecallAt: record.lastRecallAt ?? null,
      now: options.now,
    });
    if (history.length > 0) {
      await store.updateNode(node.id, { history });
    }
    if (record.forgotten === true) {
      await store.updateNode(node.id, { forgotten: true });
    }
    byLegacyName.set(record.name, node);
    imported += 1;
    if (tier === "note") notes += 1;
    else episodes += 1;
  }

  let edges = 0;
  for (const record of records) {
    const from = byLegacyName.get(record.name);
    if (!from) continue;
    for (const linkName of record.links ?? []) {
      const to = byLegacyName.get(linkName);
      if (!to || to.id === from.id) continue;
      await store.insertEdge(from.id, to.id, { strength: 0.5, kind: "assoc" });
      edges += 1;
    }
  }

  if (dreamState?.voice && typeof dreamState.voice.text === "string" && dreamState.voice.text.trim().length > 0) {
    await store.setMeta(LEGACY_VOICE_KEY, JSON.stringify(dreamState.voice));
  }
  if (dreamState) {
    await store.setMeta("legacy_dream_state", JSON.stringify({
      cursors: dreamState.cursors ?? {},
      made: dreamState.made ?? 0,
      skipped: dreamState.skipped ?? 0,
      forgottenTotal: dreamState.forgottenTotal ?? 0,
    }));
  }
  await store.setMeta(LEGACY_MIGRATED_AT_KEY, nowIso);
  await store.setMeta(LEGACY_MIGRATED_KEY, "1");
  return { migrated: imported, notes, episodes, edges, legacyVoiceKept: dreamState?.voice !== null && dreamState?.voice !== undefined };
}

/** 给 UI/persona 用：取冻结语气；没有则 null。 */
export async function readFrozenVoice(store: NmsStore): Promise<{ text: string; updatedAt: string; basis: number } | null> {
  const raw = await store.getMeta(LEGACY_VOICE_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; updatedAt?: unknown; basis?: unknown };
    if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) return null;
    return {
      text: parsed.text,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      basis: typeof parsed.basis === "number" ? parsed.basis : 0,
    };
  } catch {
    return null;
  }
}
