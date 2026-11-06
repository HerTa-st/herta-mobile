/**
 * @herta/nms 的 Capacitor SQLite 异步 store。
 *
 * 这是 DSH 版 dsh-neural-memory/src/host/store.js 的移动端移植：
 *   · 同一个五表 schema（nodes / edges / dream_runs / meta / pending_turns）；
 *   · 同一套 SQL 与算法（召回、Hebbian、90 天衰减、去重、剪边、浅睡）；
 *   · 但所有读写都通过 @capacitor-community/sqlite 的原生桥，方法全部 async。
 *
 * 接口约定见 ./store.ts；DDL 见 ./schema.ts。本文件只做存储，不做深睡/浅睡引擎。
 *
 * 注意 Capacitor SQLite 的事务语义：
 *   · SQLiteDBConnection.run() 的第三个参数（transaction）默认 true，会在一条语句
 *     外面再开一个事务；手工 beginTransaction() 之后必须传 false，否则原生层会报
 *     "Already in transaction"。
 *   · 需要跨语句原子的写路径统一走 withTransaction()（begin / commit / rollback），
 *     并用一条 Promise 队列串行化，避免两个调用同时 beginTransaction。
 */
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import type { Changes, SQLiteDBConnection } from "@capacitor-community/sqlite";
import { acquireConnection } from "./connection.ts";
import { daysBetween, effectiveWeight, normalizeTitle } from "./model.ts";
import { MOBILE_SCHEMA_VERSION, NMS_SCHEMA_STATEMENTS } from "./schema.ts";
import { NmsStoreError } from "./store.ts";
import type { NmsStore } from "./store.ts";
import type {
  NmsDreamRun,
  NmsEdge,
  NmsHistoryEntry,
  NmsNode,
  NmsNodeFilter,
  NmsNodeInput,
  NmsNodePatch,
  NmsPendingTurn,
  NmsPendingTurnInput,
  NmsSnapshot,
  NmsSnapshotNode,
  NmsStats,
  NmsTier,
  NmsTierCounts,
} from "./types.ts";

/** Capicitor SQLite 里的数据库名（Android 落盘为 herta_nmsSQLite.db）。 */
export const MOBILE_NMS_DATABASE = "herta_nms";

/** 衰减半衰期（天），与 DSH NMS 一致。 */
const DECAY_HALF_LIFE_DAYS = 90;
/** 浅睡时剪掉的弱连接阈值。 */
const EDGE_PRUNE_STRENGTH = 0.12;
/** 被回忆一次：节点权重回升步长。 */
const NODE_RECALL_STEP = 0.02;
/** 共激活一次：连接强度回升步长。 */
const EDGE_REINFORCE_STEP = 0.02;
/** 衰减时的权重地板（不让任何一条活记忆归零）。 */
const DECAY_WEIGHT_FLOOR = 0.05;

const TIERS: ReadonlySet<string> = new Set(["ep", "sem", "note"]);

/** updateNode 可写的列白名单；id / created_at 不在其中。 */
const UPDATABLE_NODE_COLUMNS: ReadonlySet<string> = new Set([
  "title",
  "gist",
  "body",
  "weight",
  "recalls",
  "last_recall_at",
  "forgotten",
  "archived",
  "merged_into",
  "consolidated_count",
  "last_consolidated_at",
  "semanticized_at",
  "history",
]);

export interface MobileNmsStoreOptions {
  /** 数据库名，默认 herta_nms。 */
  database?: string;
  /**
   * 可注入的 SQLiteConnection（测试/复用连接用）。缺省时按
   * new SQLiteConnection(CapacitorSQLite) 自建。
   */
  connection?: SQLiteConnection;
}

type Row = Record<string, unknown>;

const ISO = (ms: number): string => new Date(ms).toISOString();

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function asRows(result: { values?: unknown[] } | null | undefined): Row[] {
  const values = result?.values;
  if (!Array.isArray(values)) return [];
  return values.filter((row): row is Row => typeof row === "object" && row !== null && !Array.isArray(row));
}

/** history 列（JSON 数组）→ 数组；坏 JSON 回落空数组，不抛。 */
function decodeHistory(raw: unknown): NmsHistoryEntry[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NmsHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

/** 行 → 节点（snake_case → camelCase，0/1 → 布尔）。 */
function toNode(row: Row): NmsNode {
  return {
    id: Number(row.id),
    tier: row.tier as NmsTier,
    persona: String(row.persona ?? "herta"),
    workspace: row.workspace === null || row.workspace === undefined ? null : String(row.workspace),
    title: String(row.title ?? ""),
    gist: String(row.gist ?? ""),
    body: String(row.body ?? ""),
    weight: Number(row.weight ?? 0),
    recalls: Number(row.recalls ?? 0),
    createdAt: String(row.created_at ?? ""),
    lastRecallAt: row.last_recall_at === null || row.last_recall_at === undefined ? null : String(row.last_recall_at),
    forgotten: Number(row.forgotten ?? 0) !== 0,
    archived: Number(row.archived ?? 0) !== 0,
    mergedInto:
      row.merged_into === null || row.merged_into === undefined ? null : Number(row.merged_into),
    consolidatedCount: Number(row.consolidated_count ?? 0),
    lastConsolidatedAt:
      row.last_consolidated_at === null || row.last_consolidated_at === undefined
        ? null
        : String(row.last_consolidated_at),
    semanticizedAt:
      row.semanticized_at === null || row.semanticized_at === undefined ? null : String(row.semanticized_at),
    history: decodeHistory(row.history),
  };
}

/** 行 → 待消费轮次。 */
function toPendingTurn(row: Row): NmsPendingTurn {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id ?? ""),
    persona: String(row.persona ?? "herta"),
    workspace: row.workspace === null || row.workspace === undefined ? null : String(row.workspace),
    userText: String(row.user_text ?? ""),
    assistantText: String(row.assistant_text ?? ""),
    turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
    createdAt: String(row.created_at ?? ""),
    consumedAt: row.consumed_at === null || row.consumed_at === undefined ? null : String(row.consumed_at),
  };
}

/** 行 → 做梦账本（stats 坏 JSON 不抛，标记 parseError）。 */
function toDreamRun(row: Row): NmsDreamRun {
  let stats: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(row.stats ?? "{}"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      stats = parsed as Record<string, unknown>;
    }
  } catch {
    stats = { parseError: true };
  }
  return {
    id: Number(row.id),
    kind: String(row.kind ?? ""),
    startedAt: String(row.started_at ?? ""),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : String(row.ended_at),
    stats,
  };
}

/** 只保留整数 id（与 DSH store.js 的 filter 行为一致），并去重。 */
function uniqueIntegerIds(ids: readonly number[]): number[] {
  const list = Array.isArray(ids) ? ids : [];
  return [...new Set(list.filter((id) => Number.isInteger(id)))];
}

/**
 * 创建一个 Capacitor SQLite 支撑的 NmsStore。
 *
 * 同一实例重复调用 open() 是幂等的；close() 后可以再次 open()。
 */
export function createMobileNmsStore(options: MobileNmsStoreOptions = {}): NmsStore {
  const database =
    typeof options.database === "string" && options.database.trim().length > 0
      ? options.database.trim()
      : MOBILE_NMS_DATABASE;
  let connection: SQLiteConnection | null = options.connection ?? null;
  let db: SQLiteDBConnection | null = null;
  let opened = false;
  let openPromise: Promise<void> | null = null;
  /** 串行化顶层事务；Capacitor 一个连接同一时刻只能有一个事务。 */
  let transactionQueue: Promise<void> = Promise.resolve();

  function getConnection(): SQLiteConnection {
    if (connection === null) connection = new SQLiteConnection(CapacitorSQLite);
    return connection;
  }

  /**
   * 建立（或复用）JS 侧的连接对象。只取连接，不 open —— open 由 doOpen 负责。
   * 页面重载后原生侧可能还挂着旧连接，acquireConnection 会关掉再建（见 connection.ts）。
   */
  async function connect(): Promise<SQLiteDBConnection> {
    if (db !== null) return db;
    db = await acquireConnection(getConnection(), database, MOBILE_SCHEMA_VERSION);
    return db;
  }

  async function doOpen(): Promise<void> {
    const handle = await connect();
    const openState = await handle.isDBOpen().catch(() => ({ result: false }));
    if (openState.result !== true) await handle.open();

    // execute 的第二个参数是 transaction；schema 里第一条是 PRAGMA，不能在事务里跑。
    await handle.execute(NMS_SCHEMA_STATEMENTS.join("\n"), false);

    const metaRows = asRows(await handle.query("SELECT v FROM meta WHERE k = ?", ["schema_version"]));
    const current = metaRows.length > 0 ? Number(metaRows[0].v) : Number.NaN;
    if (!Number.isFinite(current) || current < MOBILE_SCHEMA_VERSION) {
      await handle.run(
        "INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)",
        ["schema_version", String(MOBILE_SCHEMA_VERSION)],
        false,
      );
    }
    opened = true;
  }

  function startOpen(): Promise<void> {
    if (opened) return Promise.resolve();
    if (openPromise === null) {
      openPromise = doOpen().finally(() => {
        openPromise = null;
      });
    }
    return openPromise;
  }

  async function ensureOpen(): Promise<SQLiteDBConnection> {
    if (opened && db !== null) return db;
    await startOpen();
    if (db === null) throw new NmsStoreError("not_open", "NMS store 尚未打开");
    return db;
  }

  /**
   * 单条写语句。transaction 固定 false：本文件自己管理事务，避免插件在
   * 外层事务里再 beginTransaction。
   */
  async function run(sql: string, values: unknown[] = []): Promise<Changes> {
    const handle = await ensureOpen();
    const result = await handle.run(sql, values, false);
    return result.changes ?? {};
  }

  async function queryRows(sql: string, values: unknown[] = []): Promise<Row[]> {
    const handle = await ensureOpen();
    return asRows(await handle.query(sql, values));
  }

  /** 顶层事务：begin → fn → commit；失败 rollback。用队列串行化，避免两个事务交错。 */
  async function withTransaction<T>(fn: (handle: SQLiteDBConnection) => Promise<T>): Promise<T> {
    const handle = await ensureOpen();
    const previous = transactionQueue;
    let release!: () => void;
    transactionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous.catch(() => {
        /* 前一个事务失败不应毒化队列 */
      });
      await handle.beginTransaction();
      try {
        const value = await fn(handle);
        await handle.commitTransaction();
        return value;
      } catch (error) {
        try {
          await handle.rollbackTransaction();
        } catch {
          /* 回滚失败不该盖住真正的原因 */
        }
        throw error;
      }
    } finally {
      release();
    }
  }

  // ── 代谢（零 LLM）的内部实现 ─────────────────────────────────────────────
  // 这些内部函数不自己开事务：公开方法（或 dreamLight）负责包事务。

  async function countActive(persona?: string): Promise<number> {
    const rows =
      persona === undefined
        ? await queryRows("SELECT COUNT(*) AS n FROM nodes WHERE archived = 0 AND forgotten = 0")
        : await queryRows(
            "SELECT COUNT(*) AS n FROM nodes WHERE archived = 0 AND forgotten = 0 AND persona = ?",
            [persona],
          );
    return Number(rows[0]?.n ?? 0);
  }

  async function applyDecayInternal(
    now: number,
    halfLifeDays: number,
    floor: number,
    persona: string | undefined,
  ): Promise<number> {
    // persona 给定 = 只衰减该分区（人格 agent 的浅睡不许动别的分区）。
    const rows = (await queryRows("SELECT * FROM nodes WHERE archived = 0 AND forgotten = 0 ORDER BY id ASC")).map(
      toNode,
    );
    const at = ISO(now);
    let decayed = 0;
    for (const node of rows) {
      if (persona !== undefined && node.persona !== persona) continue;
      const base = node.lastRecallAt ?? node.createdAt;
      const next = Math.max(floor, node.weight * Math.pow(0.5, daysBetween(base, now) / halfLifeDays));
      if (Math.abs(next - node.weight) < 1e-9) continue;
      await run("UPDATE nodes SET weight = ?, last_recall_at = ? WHERE id = ?", [next, at, node.id]);
      decayed += 1;
    }
    return decayed;
  }

  /** 同标题去重：同一 (tier, persona, workspace) 下归一化标题相同的，保留有效权重最高的。 */
  async function dedupeByTitleInternal(
    now: number,
    persona: string | undefined,
  ): Promise<{ archived: number; archivedIds: number[] }> {
    const active = (await queryRows("SELECT * FROM nodes WHERE archived = 0 AND forgotten = 0 ORDER BY id ASC")).map(
      toNode,
    );
    const groups = new Map<string, NmsNode[]>();
    for (const node of active) {
      if (persona !== undefined && node.persona !== persona) continue;
      const key = [node.tier, node.persona, node.workspace ?? "", normalizeTitle(node.title)].join("\u0000");
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [node]);
      else group.push(node);
    }
    let archived = 0;
    const archivedIds: number[] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort(
        (a, b) =>
          effectiveWeight(b.weight, b.lastRecallAt, now) - effectiveWeight(a.weight, a.lastRecallAt, now) ||
          a.id - b.id,
      );
      for (const node of group.slice(1)) {
        await run("UPDATE nodes SET archived = 1 WHERE id = ?", [node.id]);
        archived += 1;
        archivedIds.push(node.id);
      }
    }
    return { archived, archivedIds };
  }

  /** 剪掉弱连接，以及连着已归档/已遗忘节点的连接。 */
  async function pruneEdgesInternal(minStrength: number): Promise<number> {
    const info = await run(
      "DELETE FROM edges WHERE strength < ? OR a IN (SELECT id FROM nodes WHERE archived = 1 OR forgotten = 1) OR b IN (SELECT id FROM nodes WHERE archived = 1 OR forgotten = 1)",
      [minStrength],
    );
    return Number(info.changes ?? 0);
  }

  async function countMerged(): Promise<number> {
    const rows = await queryRows("SELECT COUNT(*) AS n FROM nodes WHERE merged_into IS NOT NULL");
    return Number(rows[0]?.n ?? 0);
  }

  async function pendingTurnStats(): Promise<{ total: number; unconsumed: number; sessions: number }> {
    const total = await queryRows("SELECT COUNT(*) AS n FROM pending_turns");
    const pending = await queryRows("SELECT COUNT(*) AS n FROM pending_turns WHERE consumed_at IS NULL");
    const sessions = await queryRows(
      "SELECT COUNT(DISTINCT session_id) AS n FROM pending_turns WHERE consumed_at IS NULL",
    );
    return {
      total: Number(total[0]?.n ?? 0),
      unconsumed: Number(pending[0]?.n ?? 0),
      sessions: Number(sessions[0]?.n ?? 0),
    };
  }

  async function insertDreamRun(input: {
    kind?: string;
    startedAt: string;
    endedAt?: string | null;
    stats?: Record<string, unknown>;
  }): Promise<number> {
    const startedAt =
      typeof input.startedAt === "string" && input.startedAt.length > 0 ? input.startedAt : ISO(Date.now());
    const endedAt = typeof input.endedAt === "string" && input.endedAt.length > 0 ? input.endedAt : null;
    const info = await run("INSERT INTO dream_runs (started_at, ended_at, kind, stats) VALUES (?,?,?,?)", [
      startedAt,
      endedAt,
      String(input.kind ?? "light"),
      JSON.stringify(input.stats ?? {}),
    ]);
    return Number(info.lastId);
  }

  // ── store 方法 ──────────────────────────────────────────────────────────

  async function listNodes(filter: NmsNodeFilter = {}): Promise<NmsNode[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const tiers = filter.tier === undefined ? null : Array.isArray(filter.tier) ? filter.tier : [filter.tier];
    if (tiers !== null && tiers.length > 0) {
      where.push("tier IN (" + tiers.map(() => "?").join(",") + ")");
      params.push(...tiers);
    }
    if (filter.persona !== undefined) {
      where.push("persona = ?");
      params.push(filter.persona);
    }
    if (filter.workspace !== undefined) {
      if (filter.workspace === null) {
        where.push("workspace IS NULL");
      } else {
        where.push("workspace = ?");
        params.push(filter.workspace);
      }
    }
    if (filter.includeArchived !== true) where.push("archived = 0");
    if (filter.includeForgotten !== true) where.push("forgotten = 0");
    const limit =
      typeof filter.limit === "number" && Number.isInteger(filter.limit) && filter.limit > 0
        ? " LIMIT " + Math.floor(filter.limit)
        : "";
    const sql =
      "SELECT * FROM nodes" +
      (where.length > 0 ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY id ASC" +
      limit;
    return (await queryRows(sql, params)).map(toNode);
  }

  async function getNode(id: number): Promise<NmsNode | null> {
    const rows = await queryRows("SELECT * FROM nodes WHERE id = ?", [id]);
    return rows.length > 0 ? toNode(rows[0]) : null;
  }

  async function insertNode(input: NmsNodeInput): Promise<NmsNode> {
    const tier: NmsTier = input.tier !== undefined && TIERS.has(input.tier) ? input.tier : "ep";
    const title = String(input.title ?? "").trim();
    if (title.length === 0) throw new NmsStoreError("invalid_title", "insertNode: title 不能为空");
    const weight =
      typeof input.weight === "number" && Number.isFinite(input.weight) ? clamp01(input.weight) : 0.5;
    const createdAt =
      typeof input.createdAt === "string" && input.createdAt.length > 0
        ? input.createdAt
        : ISO(input.now ?? Date.now());
    const info = await run(
      "INSERT INTO nodes (tier, persona, workspace, title, gist, body, weight, recalls, created_at, last_recall_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [
        tier,
        typeof input.persona === "string" && input.persona.length > 0 ? input.persona : "herta",
        input.workspace ?? null,
        title,
        String(input.gist ?? ""),
        String(input.body ?? input.gist ?? ""),
        weight,
        typeof input.recalls === "number" && Number.isInteger(input.recalls) ? input.recalls : 0,
        createdAt,
        input.lastRecallAt ?? null,
      ],
    );
    const id = Number(info.lastId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new NmsStoreError("insert_node_failed", "insertNode: 未能取得新节点 id");
    }
    const node = await getNode(id);
    if (node === null) throw new NmsStoreError("insert_node_failed", "insertNode: 新节点读取失败");
    return node;
  }

  async function updateNode(id: number, patch: NmsNodePatch = {}): Promise<NmsNode | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const assign = (column: string, value: unknown): void => {
      if (!UPDATABLE_NODE_COLUMNS.has(column)) return;
      sets.push(column + " = ?");
      params.push(value);
    };
    if (Object.hasOwn(patch, "title")) assign("title", String(patch.title));
    if (Object.hasOwn(patch, "gist")) assign("gist", String(patch.gist ?? ""));
    if (Object.hasOwn(patch, "body")) assign("body", String(patch.body ?? ""));
    if (Object.hasOwn(patch, "weight")) assign("weight", clamp01(Number(patch.weight)));
    if (Object.hasOwn(patch, "recalls")) {
      assign("recalls", Math.max(0, Math.floor(Number(patch.recalls) || 0)));
    }
    if (Object.hasOwn(patch, "lastRecallAt")) assign("last_recall_at", patch.lastRecallAt ?? null);
    if (Object.hasOwn(patch, "forgotten")) assign("forgotten", patch.forgotten === true ? 1 : 0);
    if (Object.hasOwn(patch, "archived")) assign("archived", patch.archived === true ? 1 : 0);
    if (Object.hasOwn(patch, "mergedInto")) {
      assign("merged_into", patch.mergedInto === null ? null : Number(patch.mergedInto));
    }
    if (Object.hasOwn(patch, "consolidatedCount")) {
      assign("consolidated_count", Math.max(0, Math.floor(Number(patch.consolidatedCount) || 0)));
    }
    if (Object.hasOwn(patch, "lastConsolidatedAt")) assign("last_consolidated_at", patch.lastConsolidatedAt ?? null);
    if (Object.hasOwn(patch, "semanticizedAt")) assign("semanticized_at", patch.semanticizedAt ?? null);
    if (Object.hasOwn(patch, "history")) {
      assign("history", JSON.stringify(Array.isArray(patch.history) ? patch.history : []));
    }
    if (sets.length === 0) return getNode(id);
    await run("UPDATE nodes SET " + sets.join(", ") + " WHERE id = ?", [...params, id]);
    return getNode(id);
  }

  async function appendNodeHistory(
    id: number,
    entry: NmsHistoryEntry,
    options?: { limit?: number },
  ): Promise<void> {
    const node = await getNode(id);
    if (node === null) return;
    const limit = options?.limit ?? 50;
    const history = [...node.history, entry].slice(-Math.max(1, limit));
    await updateNode(id, { history });
  }

  async function mergeNodeInto(mainId: number, otherId: number): Promise<{ moved: number; dropped: number }> {
    const main = Number(mainId);
    const other = Number(otherId);
    if (!Number.isInteger(main) || !Number.isInteger(other) || main === other) {
      throw new NmsStoreError("invalid_merge", "mergeNodeInto: 需要两个不同的节点 id");
    }
    return withTransaction(async () => {
      if ((await getNode(main)) === null || (await getNode(other)) === null) {
        // store.js 这里返回 null；NmsStore 的返回类型不允许 null，改用显式错误。
        throw new NmsStoreError("node_not_found", "mergeNodeInto: 节点不存在");
      }
      let moved = 0;
      let dropped = 0;
      const rows = await queryRows("SELECT a, b, strength, kind FROM edges WHERE a = ? OR b = ?", [other, other]);
      for (const row of rows) {
        const neighbor = Number(row.a) === other ? Number(row.b) : Number(row.a);
        if (neighbor === main) {
          dropped += 1;
          continue;
        }
        const lo = Math.min(main, neighbor);
        const hi = Math.max(main, neighbor);
        const existing = await queryRows("SELECT strength FROM edges WHERE a = ? AND b = ?", [lo, hi]);
        if (existing.length === 0) {
          await run("INSERT OR REPLACE INTO edges (a, b, strength, kind) VALUES (?,?,?,?)", [
            lo,
            hi,
            Number(row.strength),
            row.kind,
          ]);
          moved += 1;
        } else {
          await run("UPDATE edges SET strength = max(strength, ?) WHERE a = ? AND b = ?", [
            Number(row.strength),
            lo,
            hi,
          ]);
          dropped += 1;
        }
      }
      await run("DELETE FROM edges WHERE a = ? OR b = ?", [other, other]);
      await run("UPDATE nodes SET merged_into = ?, archived = 1 WHERE id = ?", [main, other]);
      return { moved, dropped };
    });
  }

  async function insertEdge(
    from: number,
    to: number,
    options?: { strength?: number; kind?: string },
  ): Promise<NmsEdge> {
    const a = Math.min(Number(from), Number(to));
    const b = Math.max(Number(from), Number(to));
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) {
      throw new NmsStoreError("invalid_edge", "insertEdge: 需要两个不同的节点 id");
    }
    const strength = clamp01(
      typeof options?.strength === "number" && Number.isFinite(options.strength) ? options.strength : 0.2,
    );
    const kind = options?.kind ?? "assoc";
    await run("INSERT OR REPLACE INTO edges (a, b, strength, kind) VALUES (?,?,?,?)", [a, b, strength, kind]);
    return { a, b, strength, kind };
  }

  async function allEdges(options?: { minStrength?: number }): Promise<NmsEdge[]> {
    const minStrength = options?.minStrength ?? 0;
    return (await queryRows("SELECT a, b, strength, kind FROM edges ORDER BY a ASC, b ASC"))
      .map((row) => ({ a: Number(row.a), b: Number(row.b), strength: Number(row.strength), kind: String(row.kind) }))
      .filter((row) => row.strength >= minStrength);
  }

  async function neighbors(
    id: number,
    options?: { minStrength?: number; includeArchived?: boolean },
  ): Promise<Array<{ node: NmsNode; strength: number; kind: string }>> {
    const minStrength = options?.minStrength ?? 0;
    const includeArchived = options?.includeArchived === true;
    const rows = await queryRows(
      "SELECT * FROM edges WHERE (a = ? OR b = ?) AND strength >= ? ORDER BY strength DESC, a ASC, b ASC",
      [id, id, minStrength],
    );
    const out: Array<{ node: NmsNode; strength: number; kind: string }> = [];
    for (const row of rows) {
      const otherId = Number(row.a) === id ? Number(row.b) : Number(row.a);
      const node = await getNode(otherId);
      if (node === null) continue;
      if (!includeArchived && (node.archived || node.forgotten)) continue;
      out.push({ node, strength: Number(row.strength), kind: String(row.kind) });
    }
    return out;
  }

  /**
   * 记住「这些记忆刚刚被想起来」：recalls + 1、last_recall_at = now、权重小幅回升。
   */
  async function recall(ids: number[], options?: { now?: number; reinforceNode?: number }): Promise<NmsNode[]> {
    const unique = uniqueIntegerIds(ids);
    if (unique.length === 0) return [];
    const now = options?.now ?? Date.now();
    const reinforceNode = options?.reinforceNode ?? NODE_RECALL_STEP;
    const at = ISO(now);
    await withTransaction(async () => {
      for (const id of unique) {
        await run(
          "UPDATE nodes SET recalls = recalls + 1, last_recall_at = ?, weight = min(1.0, weight + ?) WHERE id = ?",
          [at, reinforceNode, id],
        );
      }
    });
    const out: NmsNode[] = [];
    for (const id of unique) {
      const node = await getNode(id);
      if (node !== null) out.push(node);
    }
    return out;
  }

  /**
   * Hebbian 共激活：同时被激活的记忆之间连接变强（没有就建立一条）。
   *
   * DSH store.js 返回 {pairs, created, strengthened}；移动端 NmsStore 接口改成返回
   * 被触碰的边（a/b/strength），这里按接口实现，pairs 等价于返回数组长度。
   */
  async function reinforce(
    ids: number[],
    options?: { delta?: number },
  ): Promise<Array<{ a: number; b: number; strength: number }>> {
    const unique = uniqueIntegerIds(ids);
    if (unique.length < 2) return [];
    const delta = options?.delta ?? EDGE_REINFORCE_STEP;
    return withTransaction(async () => {
      const touched: Array<{ a: number; b: number; strength: number }> = [];
      for (let i = 0; i < unique.length; i += 1) {
        for (let j = i + 1; j < unique.length; j += 1) {
          const a = Math.min(unique[i], unique[j]);
          const b = Math.max(unique[i], unique[j]);
          const existing = await queryRows("SELECT strength FROM edges WHERE a = ? AND b = ?", [a, b]);
          if (existing.length === 0) {
            await run("INSERT OR REPLACE INTO edges (a, b, strength, kind) VALUES (?,?,?,?)", [
              a,
              b,
              0.2,
              "coactivation",
            ]);
            touched.push({ a, b, strength: 0.2 });
          } else {
            const before = Number(existing[0].strength);
            await run("UPDATE edges SET strength = min(1.0, strength + ?) WHERE a = ? AND b = ?", [delta, a, b]);
            touched.push({ a, b, strength: Math.min(1, before + delta) });
          }
        }
      }
      return touched;
    });
  }

  /**
   * 时间衰减：把有效权重材料化进 weight，并重置衰减基线。
   * 指数衰减无记忆性：w(t2) = w(t1)·2^(-Δ/hl)。
   */
  async function applyDecay(options?: {
    now?: number;
    halfLifeDays?: number;
    floor?: number;
    persona?: string;
  }): Promise<{ decayed: number; halfLifeDays: number; floor: number }> {
    const now = options?.now ?? Date.now();
    const halfLifeDays = options?.halfLifeDays ?? DECAY_HALF_LIFE_DAYS;
    const floor = options?.floor ?? DECAY_WEIGHT_FLOOR;
    const decayed = await withTransaction(() =>
      applyDecayInternal(now, halfLifeDays, floor, options?.persona),
    );
    return { decayed, halfLifeDays, floor };
  }

  async function dedupeByTitle(
    options?: { now?: number; persona?: string },
  ): Promise<{ archived: number; archivedIds: number[] }> {
    const now = options?.now ?? Date.now();
    return withTransaction(() => dedupeByTitleInternal(now, options?.persona));
  }

  async function pruneEdges(options?: { minStrength?: number }): Promise<{ pruned: number; minStrength: number }> {
    const minStrength = options?.minStrength ?? EDGE_PRUNE_STRENGTH;
    const pruned = await pruneEdgesInternal(minStrength);
    return { pruned, minStrength };
  }

  /**
   * 浅睡（零 LLM）：去重 → 衰减 → 剪连接 → 记账。
   * persona 给定 = 分区浅睡：只去重/衰减该 persona，连接清理留给全局浅睡。
   */
  async function dreamLight(options?: { now?: number; persona?: string }): Promise<Record<string, unknown>> {
    const now = options?.now ?? Date.now();
    const persona = options?.persona;
    const startedAt = ISO(now);
    return withTransaction(async () => {
      const before = {
        nodes: await countActive(persona),
        edges: (await allEdges()).length,
      };
      const dedupe = await dedupeByTitleInternal(now, persona);
      const decayed = await applyDecayInternal(now, DECAY_HALF_LIFE_DAYS, DECAY_WEIGHT_FLOOR, persona);
      const pruned = persona === undefined ? await pruneEdgesInternal(EDGE_PRUNE_STRENGTH) : 0;
      const after = {
        nodes: await countActive(persona),
        edges: (await allEdges()).length,
      };
      const endedAt = ISO(Math.max(now, Date.now()));
      const stats: Record<string, unknown> = {
        kind: "light",
        startedAt,
        endedAt,
        persona: persona ?? null,
        archived: dedupe.archived,
        archivedIds: dedupe.archivedIds,
        decayed,
        prunedEdges: pruned,
        nodesBefore: before.nodes,
        nodesAfter: after.nodes,
        edgesBefore: before.edges,
        edgesAfter: after.edges,
      };
      const info = await run("INSERT INTO dream_runs (started_at, ended_at, kind, stats) VALUES (?,?,?,?)", [
        startedAt,
        endedAt,
        "light",
        JSON.stringify(stats),
      ]);
      await run("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", ["last_dream_at", startedAt]);
      return { ...stats, runId: Number(info.lastId) };
    });
  }

  // ── pending turns ───────────────────────────────────────────────────────

  async function insertPendingTurn(input: NmsPendingTurnInput): Promise<number> {
    const sessionId = String(input.sessionId ?? "").trim();
    if (sessionId.length === 0) throw new NmsStoreError("invalid_session", "insertPendingTurn: sessionId 不能为空");
    const turn = typeof input.turn === "number" && Number.isInteger(input.turn) ? input.turn : null;
    // 幂等去重：双钩子 / 双平面各写一次时，(session_id, turn) 唯一索引 + 显式查重。
    if (turn !== null) {
      const existing = await queryRows("SELECT id FROM pending_turns WHERE session_id = ? AND turn = ?", [
        sessionId,
        turn,
      ]);
      if (existing.length > 0) return Number(existing[0].id);
    }
    const info = await run(
      "INSERT OR IGNORE INTO pending_turns (session_id, persona, workspace, user_text, assistant_text, turn, created_at) VALUES (?,?,?,?,?,?,?)",
      [
        sessionId,
        typeof input.persona === "string" && input.persona.length > 0 ? input.persona : "herta",
        input.workspace ?? null,
        String(input.userText ?? ""),
        String(input.assistantText ?? ""),
        turn,
        ISO(input.now ?? Date.now()),
      ],
    );
    if (Number(info.changes ?? 0) === 0 && turn !== null) {
      const existing = await queryRows("SELECT id FROM pending_turns WHERE session_id = ? AND turn = ?", [
        sessionId,
        turn,
      ]);
      if (existing.length > 0) return Number(existing[0].id);
    }
    return Number(info.lastId);
  }

  /** 撤回一轮：删除该 (session, turn) 的 pending；返回删除行数。 */
  async function deletePendingTurn(sessionId: string, turn: number): Promise<number> {
    const sid = String(sessionId ?? "").trim();
    const t = Number(turn);
    if (sid.length === 0 || !Number.isInteger(t) || t <= 0) return 0;
    const info = await run("DELETE FROM pending_turns WHERE session_id = ? AND turn = ?", [sid, t]);
    return Number(info.changes ?? 0);
  }

  async function listPendingTurns(options?: { limit?: number; sessionId?: string }): Promise<NmsPendingTurn[]> {
    const cap = Math.max(1, Math.min(1000, Math.floor(Number(options?.limit) || 100)));
    const rows =
      options?.sessionId === undefined
        ? await queryRows("SELECT * FROM pending_turns WHERE consumed_at IS NULL ORDER BY id ASC LIMIT ?", [cap])
        : await queryRows(
            "SELECT * FROM pending_turns WHERE consumed_at IS NULL AND session_id = ? ORDER BY id ASC LIMIT ?",
            [String(options.sessionId), cap],
          );
    return rows.map(toPendingTurn);
  }

  async function consumePendingTurns(ids: number[], options?: { now?: number }): Promise<number> {
    const unique = uniqueIntegerIds(ids);
    if (unique.length === 0) return 0;
    const at = ISO(options?.now ?? Date.now());
    return withTransaction(async () => {
      let consumed = 0;
      for (const id of unique) {
        const info = await run("UPDATE pending_turns SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL", [
          at,
          id,
        ]);
        consumed += Number(info.changes ?? 0);
      }
      return consumed;
    });
  }

  // ── dream 账本 ──────────────────────────────────────────────────────────

  async function recordDreamRun(input: {
    kind?: string;
    startedAt: string;
    endedAt?: string | null;
    stats?: Record<string, unknown>;
  }): Promise<number> {
    return insertDreamRun(input);
  }

  async function lastDreamRun(options?: { kind?: string }): Promise<NmsDreamRun | null> {
    const rows =
      options?.kind === undefined
        ? await queryRows("SELECT * FROM dream_runs ORDER BY id DESC LIMIT 1")
        : await queryRows("SELECT * FROM dream_runs WHERE kind = ? ORDER BY id DESC LIMIT 1", [
            String(options.kind),
          ]);
    return rows.length > 0 ? toDreamRun(rows[0]) : null;
  }

  async function dreamRuns(options?: { limit?: number; kind?: string }): Promise<NmsDreamRun[]> {
    const cap = Math.max(1, Math.min(100, Math.floor(Number(options?.limit) || 10)));
    const rows =
      options?.kind === undefined
        ? await queryRows("SELECT * FROM dream_runs ORDER BY id DESC LIMIT ?", [cap])
        : await queryRows("SELECT * FROM dream_runs WHERE kind = ? ORDER BY id DESC LIMIT ?", [
            String(options.kind),
            cap,
          ]);
    return rows.map(toDreamRun);
  }

  // ── meta ────────────────────────────────────────────────────────────────

  async function getMeta(key: string): Promise<string | null> {
    const rows = await queryRows("SELECT v FROM meta WHERE k = ?", [key]);
    if (rows.length === 0) return null;
    const value = rows[0].v;
    return value === null || value === undefined ? null : String(value);
  }

  async function setMeta(key: string, value: string): Promise<void> {
    await run("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", [key, String(value)]);
  }

  // ── 统计 / 快照 ─────────────────────────────────────────────────────────

  async function stats(options?: { now?: number }): Promise<NmsStats> {
    const now = options?.now ?? Date.now();
    const byTierRows = await queryRows(
      "SELECT tier, COUNT(*) AS n FROM nodes WHERE archived = 0 AND forgotten = 0 GROUP BY tier",
    );
    const byWorkspaceRows = await queryRows(
      "SELECT COALESCE(workspace, '') AS ws, COUNT(*) AS n FROM nodes WHERE archived = 0 AND forgotten = 0 GROUP BY ws",
    );
    const totalRows = await queryRows("SELECT COUNT(*) AS n FROM nodes");
    const activeRows = await queryRows("SELECT COUNT(*) AS n FROM nodes WHERE archived = 0 AND forgotten = 0");
    const flagRows = await queryRows("SELECT SUM(archived) AS archived, SUM(forgotten) AS forgotten FROM nodes");
    const edgeRows = await queryRows("SELECT COUNT(*) AS n, COALESCE(AVG(strength), 0) AS avg FROM edges");
    const dreamCountRows = await queryRows("SELECT COUNT(*) AS n FROM dream_runs");
    const lastDreamRows = await queryRows("SELECT kind FROM dream_runs ORDER BY id DESC LIMIT 1");

    const byTier: NmsTierCounts = { ep: 0, sem: 0, note: 0 };
    for (const row of byTierRows) {
      const tier = String(row.tier);
      if (tier === "ep" || tier === "sem" || tier === "note") byTier[tier] = Number(row.n);
    }
    const byWorkspace: Record<string, number> = {};
    for (const row of byWorkspaceRows) {
      const ws = row.ws === "" ? "persona" : String(row.ws);
      byWorkspace[ws] = Number(row.n);
    }
    const flags = flagRows[0] ?? {};
    const edge = edgeRows[0] ?? {};
    const lastAt = await getMeta("last_dream_at");
    return {
      nodes: {
        total: Number(totalRows[0]?.n ?? 0),
        active: Number(activeRows[0]?.n ?? 0),
        archived: Number(flags.archived ?? 0),
        forgotten: Number(flags.forgotten ?? 0),
        merged: await countMerged(),
        byTier,
        byWorkspace,
      },
      edges: {
        total: Number(edge.n ?? 0),
        avgStrength: Number(edge.avg ?? 0),
      },
      pending: await pendingTurnStats(),
      dreams: {
        count: Number(dreamCountRows[0]?.n ?? 0),
        lastAt,
        lastKind: lastDreamRows.length > 0 ? String(lastDreamRows[0].kind) : null,
      },
      halfLifeDays: DECAY_HALF_LIFE_DAYS,
      generatedAt: ISO(now),
    };
  }

  async function snapshot(options?: { now?: number }): Promise<NmsSnapshot> {
    const now = options?.now ?? Date.now();
    const all = await listNodes({ includeArchived: false, includeForgotten: false });
    const activeIds = new Set(all.map((node) => node.id));
    const nodes: NmsSnapshotNode[] = all.map((node) => ({
      id: node.id,
      tier: node.tier,
      persona: node.persona,
      workspace: node.workspace,
      title: node.title,
      gist: node.gist,
      weight: round4(node.weight),
      effectiveWeight: round4(effectiveWeight(node.weight, node.lastRecallAt, now)),
      recalls: node.recalls,
      createdAt: node.createdAt,
      lastRecallAt: node.lastRecallAt,
    }));
    const edges = (await allEdges())
      .filter((edge) => activeIds.has(edge.a) && activeIds.has(edge.b))
      .map((edge) => ({ a: edge.a, b: edge.b, strength: round4(edge.strength), kind: edge.kind }));
    const currentStats = await stats({ now });
    return {
      schemaVersion: MOBILE_SCHEMA_VERSION,
      generatedAt: ISO(now),
      stats: currentStats,
      nodes,
      edges,
    };
  }

  async function countNodes(): Promise<number> {
    const rows = await queryRows("SELECT COUNT(*) AS n FROM nodes");
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * 库大小：插件没有暴露文件路径 / stat，这里用 PRAGMA page_count × page_size
   * 估算（逻辑大小，不含 WAL 文件）。失败返回 0。
   */
  async function sizeBytes(): Promise<number> {
    try {
      const pageCountRows = await queryRows("PRAGMA page_count;");
      const pageSizeRows = await queryRows("PRAGMA page_size;");
      const pageCount = Number(Object.values(pageCountRows[0] ?? {})[0] ?? 0);
      const pageSize = Number(Object.values(pageSizeRows[0] ?? {})[0] ?? 0);
      if (!Number.isFinite(pageCount) || !Number.isFinite(pageSize)) return 0;
      return pageCount * pageSize;
    } catch {
      return 0;
    }
  }

  /**
   * 换机「覆盖本机」时用：边先删（有外键引用），再删节点，最后清掉待处理回合——
   * 那些回合属于旧会话，留着会在下次深睡时被当成新素材。
   * meta 与 dream_runs 不动：迁移标记、睡眠账本不是「她的记忆」。
   */
  async function reset(): Promise<void> {
    await run("DELETE FROM edges");
    await run("DELETE FROM nodes");
    await run("DELETE FROM pending_turns");
  }

  async function close(): Promise<void> {
    if (openPromise !== null) {
      try {
        await openPromise;
      } catch {
        /* open 失败也要把已建立的连接收掉 */
      }
    }
    const handle = db;
    const wrapper = connection;
    db = null;
    opened = false;
    if (handle === null) return;
    try {
      await handle.close();
    } catch {
      /* 已经关闭 */
    }
    if (wrapper !== null) {
      try {
        await wrapper.closeConnection(database, false);
      } catch {
        /* 已经关闭 / 原生连接不存在 */
      }
    }
  }

  return {
    schemaVersion: MOBILE_SCHEMA_VERSION,
    open: async () => {
      await startOpen();
    },
    close,
    listNodes,
    getNode,
    insertNode,
    updateNode,
    appendNodeHistory,
    mergeNodeInto,
    countMerged,
    insertEdge,
    allEdges,
    neighbors,
    recall,
    reinforce,
    applyDecay,
    dedupeByTitle,
    pruneEdges,
    dreamLight,
    insertPendingTurn,
    deletePendingTurn,
    listPendingTurns,
    consumePendingTurns,
    pendingTurnStats,
    recordDreamRun,
    lastDreamRun,
    dreamRuns,
    getMeta,
    setMeta,
    stats,
    snapshot,
    countNodes,
    sizeBytes,
    reset,
  };
}
