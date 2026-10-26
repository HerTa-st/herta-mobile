/**
 * 导入：把从别处捞回来的对话，变成她的会话。
 *
 * 采集端在电脑上（油猴脚本，见 tools/userscript），因为 DeepSeek 官方没有导出功能，
 * 只有浏览器里那份登录态能拿到数据。手机只负责**接收、校验、归一、去重**。
 *
 * 一条纪律：**导入是只读归档，不是她的记忆**。归档只提供原文，记忆要经过做梦。
 * 所以这里产出的会话带 `origin: "import"`，UI 上要能看出来它不是在这儿聊出来的。
 */

import type { Block, ImportBundle, ImportedSession, Session } from "../../protocol/src/index.ts";
import { deriveTitle } from "./session.ts";

export const IMPORT_FORMAT = "herta-import";
export const IMPORT_VERSION = 1;

export type ParseResult = { ok: true; bundle: ImportBundle } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 校验一份导入包。宁可拒绝得难看，也不要半份数据混进她的记忆里——
 * 坏数据在检索和做梦时会以"她自己说过的话"的形式回来。
 */
export function parseImportBundle(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: "不是合法的 JSON：" + (e instanceof Error ? e.message : String(e)) };
  }
  if (!isRecord(parsed)) return { ok: false, error: "顶层不是一个对象" };
  if (parsed.format !== IMPORT_FORMAT) {
    return { ok: false, error: "格式不对：format 应当是 " + IMPORT_FORMAT + "，实际是 " + String(parsed.format) };
  }
  if (parsed.version !== IMPORT_VERSION) {
    return { ok: false, error: "版本不支持：" + String(parsed.version) + "（这个版本只认 " + IMPORT_VERSION + "）" };
  }
  if (!Array.isArray(parsed.sessions)) return { ok: false, error: "sessions 不是数组" };
  if (parsed.sessions.length === 0) return { ok: false, error: "这份包里一个会话都没有" };

  const sessions: ImportedSession[] = [];
  for (const [i, rawSession] of parsed.sessions.entries()) {
    if (!isRecord(rawSession)) return { ok: false, error: "第 " + (i + 1) + " 个会话不是对象" };
    const id = String(rawSession.id ?? "").trim();
    if (!id) return { ok: false, error: "第 " + (i + 1) + " 个会话没有 id" };
    if (!Array.isArray(rawSession.messages)) return { ok: false, error: "第 " + (i + 1) + " 个会话的 messages 不是数组" };

    const messages = rawSession.messages
      .filter(isRecord)
      .map((m) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        text: String(m.text ?? ""),
        ...(typeof m.at === "string" && m.at ? { at: m.at } : {}),
      }))
      .filter((m) => m.text.trim().length > 0);

    if (messages.length === 0) continue;

    sessions.push({
      id,
      title: String(rawSession.title ?? "").trim(),
      startedAt: String(rawSession.startedAt ?? "").trim(),
      messages,
    });
  }

  if (sessions.length === 0) return { ok: false, error: "所有会话都是空的" };

  return {
    ok: true,
    bundle: {
      format: IMPORT_FORMAT,
      version: IMPORT_VERSION,
      source: "deepseek-web",
      exportedAt: String(parsed.exportedAt ?? "").trim() || new Date(0).toISOString(),
      collector: isRecord(parsed.collector)
        ? { name: String(parsed.collector.name ?? "unknown"), version: String(parsed.collector.version ?? "0") }
        : { name: "unknown", version: "0" },
      sessions,
    },
  };
}

/**
 * 导入会话的 id 要**稳定**：重复导入同一份数据不会在列表里长出两份。
 * 用来源 + 站点侧会话 id，而不是随机 UUID。
 */
export function importSessionId(source: string, siteId: string): string {
  return "imp:" + source + ":" + siteId;
}

/** 一个导入会话 → 她的会话。只有「说」，不带「想」——别人那边的思维链不该冒充她的内心。 */
export function sessionFromImport(source: string, imported: ImportedSession, exportedAt: string): Session {
  const startedAt = imported.startedAt || exportedAt;
  const blocks: Block[] = imported.messages.map((m) => {
    const at = m.at ?? startedAt;
    return m.role === "user"
      ? ({ kind: "user", text: m.text, at } as Block)
      : ({ kind: "herta", surface: "speech", text: m.text, at } as Block);
  });

  const lastAt = imported.messages[imported.messages.length - 1]?.at ?? startedAt;
  return {
    id: importSessionId(source, imported.id),
    title: imported.title || deriveTitle(blocks),
    origin: "import",
    createdAt: startedAt,
    updatedAt: lastAt,
    blocks,
  };
}

export interface ImportPlan {
  toWrite: Session[];
  skipped: number;
  total: number;
}

/** 算出这次要写哪些：已经在库里的按 id 跳过，不覆盖。 */
export function planImport(bundle: ImportBundle, existingIds: ReadonlySet<string>): ImportPlan {
  const seen = new Set(existingIds);
  const toWrite: Session[] = [];
  let skipped = 0;
  for (const s of bundle.sessions) {
    const session = sessionFromImport(bundle.source, s, bundle.exportedAt);
    if (seen.has(session.id)) {
      skipped += 1;
      continue;
    }
    seen.add(session.id);
    toWrite.push(session);
  }
  return { toWrite, skipped, total: bundle.sessions.length };
}
