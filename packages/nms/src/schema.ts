/**
 * 移动端 NMS 的 SQLite DDL（Capacitor SQLite 原生命令）。
 *
 * 只建核心五表；persona 固定为 herta，workspace 固定 NULL。
 * 移动端 schema 版本独立于 DSH NMS 的 v4，从 1 开始。
 */

export const MOBILE_SCHEMA_VERSION = 1;

export const NMS_SCHEMA_STATEMENTS: readonly string[] = [
  "PRAGMA foreign_keys = ON;",
  "CREATE TABLE IF NOT EXISTS nodes (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  tier TEXT NOT NULL CHECK (tier IN ('ep','sem','note')),",
  "  persona TEXT NOT NULL DEFAULT 'herta',",
  "  workspace TEXT,",
  "  title TEXT NOT NULL,",
  "  gist TEXT NOT NULL DEFAULT '',",
  "  body TEXT NOT NULL DEFAULT '',",
  "  weight REAL NOT NULL DEFAULT 0.5,",
  "  recalls INTEGER NOT NULL DEFAULT 0,",
  "  created_at TEXT NOT NULL,",
  "  last_recall_at TEXT,",
  "  forgotten INTEGER NOT NULL DEFAULT 0,",
  "  archived INTEGER NOT NULL DEFAULT 0,",
  "  merged_into INTEGER,",
  "  consolidated_count INTEGER NOT NULL DEFAULT 0,",
  "  last_consolidated_at TEXT,",
  "  history TEXT NOT NULL DEFAULT '[]',",
  "  semanticized_at TEXT",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_nodes_tier ON nodes (tier);",
  "CREATE INDEX IF NOT EXISTS idx_nodes_scope ON nodes (persona, workspace);",
  "CREATE INDEX IF NOT EXISTS idx_nodes_archived ON nodes (archived, forgotten);",
  "CREATE TABLE IF NOT EXISTS edges (",
  "  a INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,",
  "  b INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,",
  "  strength REAL NOT NULL,",
  "  kind TEXT NOT NULL DEFAULT 'assoc',",
  "  PRIMARY KEY (a, b),",
  "  CHECK (a < b)",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_edges_a ON edges (a);",
  "CREATE INDEX IF NOT EXISTS idx_edges_b ON edges (b);",
  "CREATE TABLE IF NOT EXISTS dream_runs (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  started_at TEXT NOT NULL,",
  "  ended_at TEXT,",
  "  kind TEXT NOT NULL,",
  "  stats TEXT NOT NULL DEFAULT '{}'",
  ");",
  "CREATE TABLE IF NOT EXISTS meta (",
  "  k TEXT PRIMARY KEY,",
  "  v TEXT NOT NULL",
  ");",
  "CREATE TABLE IF NOT EXISTS pending_turns (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  session_id TEXT NOT NULL,",
  "  persona TEXT NOT NULL DEFAULT 'herta',",
  "  workspace TEXT,",
  "  user_text TEXT NOT NULL DEFAULT '',",
  "  assistant_text TEXT NOT NULL DEFAULT '',",
  "  turn INTEGER,",
  "  created_at TEXT NOT NULL,",
  "  consumed_at TEXT",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_pending_unconsumed ON pending_turns (consumed_at, id);",
  "CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_session_turn ON pending_turns (session_id, turn) WHERE turn IS NOT NULL;",
];

/** 表清单（迁移/诊断/备份用）。 */
export const NMS_TABLES: readonly string[] = ["nodes", "edges", "dream_runs", "meta", "pending_turns"];
