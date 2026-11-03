/**
 * 星际和平播报的纯逻辑：搜索候选去重、期号、结构化校验、彩蛋规则。
 *
 * 这里不碰网络、不碰 IndexedDB —— 那两样在 `apps/phone/src/broadcast/`。
 * 放在 core 是为了能在 Node 里直接测：模型返回的 JSON 半截、彩蛋位置错、
 * 链接不在候选里，这些都不该靠"跑一遍真机"才发现。
 */

/** 一条「条」：一期里的一条新闻。 */
export interface BroadcastItem {
  id: string;
  /** 媒体名，如「网易」「ITmedia」。 */
  source: string;
  /** 域名，用来做 favicon / 去重；彩蛋为空串。 */
  domain: string;
  title: string;
  summary: string;
  /** 真新闻的原文链接；彩蛋为空串（设计：彩蛋不提供原文）。 */
  url: string;
  publishedAt?: string;
  /** 这条落在哪个关注标签上，如「人工智能」。 */
  tag?: string;
  /** 她的评：一句话，不是摘要。 */
  comment: string;
  /** 它和你的关系：一句短语（桌面信息流的 chip，如「你关注人工智能」）。 */
  why?: string;
  /** 彩蛋：每期最多一条，必须排在最后，不计入 3–7 条。 */
  egg?: boolean;
  /** 点开读原文时生成的稿子：要点（最多 5 条）。读过才有。 */
  points?: string[];
  /** 稿子正文（Markdown 子集：### 小标题、列表、表格、**加粗**）。读过才有。 */
  detail?: string;
}

/** 一期。id 用本地日期，一天一期。 */
export interface BroadcastIssue {
  id: string;
  /** 期号：按实际生成递增，错过不占号。 */
  no: number;
  /** 本地日期 YYYY-MM-DD。 */
  date: string;
  createdAt: string;
  items: BroadcastItem[];
  status: "ready" | "failed";
  error?: string;
}

/** 搜索接口返回的候选（结构上和 transport.ts 的 SearchHit 一致，core 不依赖 app）。 */
export interface BroadcastSearchHit {
  title: string;
  url: string;
  summary: string;
}

/** 去重、过滤后的候选。 */
export interface BroadcastCandidate {
  title: string;
  url: string;
  summary: string;
  source: string;
  domain: string;
  /** 归一化后的 URL，去重与校验都用它。 */
  key: string;
}

export const BROADCAST_TARGET_ITEMS = 5;
export const BROADCAST_MIN_ITEMS = 3;
export const BROADCAST_MAX_ITEMS = 7;
/** 她的一句评：允许略长，但不要把摘要塞进来。 */
export const BROADCAST_COMMENT_MAX = 120;
export const BROADCAST_SUMMARY_MAX = 320;
export const BROADCAST_TITLE_MAX = 140;

/** 关注标签：设置页的选项池。默认是她选的「人工智能 + 游戏」。 */
export const BROADCAST_TAG_OPTIONS = [
  "人工智能",
  "数码产品",
  "游戏",
  "科技商业",
  "开源",
  "动漫 / 影视",
  "硬件 / 芯片",
  "太空 / 科学",
] as const;

export const DEFAULT_BROADCAST_TAGS = ["人工智能", "游戏"] as const;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 本地日期（不是 UTC）：播报的「今天」按手机所在时区算。 */
export function localDateId(now = new Date()): string {
  return now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
}

/** 「11月2日」；日期不合法就原样返回。 */
export function dateLabel(date: string): string {
  const m = DATE_RE.exec(String(date ?? ""));
  if (!m) return String(date ?? "");
  return Number(m[2]) + "月" + Number(m[3]) + "日";
}

/** 下一期的期号：最大号 + 1；一条都没有就是第 1 期。 */
export function nextIssueNo(issues: readonly Pick<BroadcastIssue, "no">[]): number {
  let max = 0;
  for (const issue of issues) {
    if (Number.isFinite(issue.no) && issue.no > max) max = Math.floor(issue.no);
  }
  return max + 1;
}

export function countRealItems(items: readonly BroadcastItem[]): number {
  return items.filter((item) => !item.egg).length;
}

export function hasEgg(items: readonly BroadcastItem[]): boolean {
  return items.some((item) => item.egg === true);
}

/** 播报页/期头用的标题。 */
export function broadcastTitle(no: number): string {
  return "《星际和平播报》 第 " + no + " 期 · 空间站「黑塔」转播";
}

/** 日期条后面的计数：真新闻条数；有彩蛋时单独标，不混进去。 */
export function countLabel(items: readonly BroadcastItem[]): string {
  const real = countRealItems(items);
  return real + "条" + (hasEgg(items) ? " · 1彩蛋" : "");
}

/* ------------------------------------------------------------------ 搜索 */

/** 关注标签 → 搜索词。最多 4 条（DeepSeek 搜索接口一次一组查询）。 */
export function buildSearchQueries(tags: readonly string[], max = 4): string[] {
  const clean = [...new Set(tags.map((t) => String(t ?? "").trim()).filter(Boolean))];
  const use = clean.length > 0 ? clean : ["科技"];
  return use.slice(0, Math.max(1, max)).map((tag) => tag + " 最新 新闻");
}

/** 归一化：去掉 hash、查询串和末尾斜杠，只留 origin + path。 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(String(url ?? "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const path = u.pathname.replace(/\/+$/, "");
    return u.origin + path;
  } catch {
    return "";
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(String(url ?? "").trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function pathOf(url: string): string {
  try {
    return new URL(String(url ?? "").trim()).pathname;
  } catch {
    return "";
  }
}

/** 内容农场 / 聚合站：宁可少一条，也别把二手洗稿当原始媒体。 */
const BLOCKED_HOSTS = [
  /^baijiahao\.baidu\.com$/i,
  /(^|\.)toutiao\.com$/i,
  /^k\.sina\.com\.cn$/i,
  /^news\.google\.com$/i,
  /(^|\.)msn\.com$/i,
  /(^|\.)flipboard\.com$/i,
  /(^|\.)weibo\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)x\.com$/i,
];

export function isBlockedSource(domain: string, path = ""): boolean {
  const host = String(domain ?? "").toLowerCase();
  if (!host) return true;
  if (BLOCKED_HOSTS.some((re) => re.test(host))) return true;
  // 网易号（163.com/dy/...）是自媒体池，不是网易新闻编辑部
  if (/(^|\.)163\.com$/i.test(host) && /^\/dy\//i.test(path)) return true;
  return false;
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * 合并多组搜索结果：按归一化 URL 去重、滤掉黑名单、丢掉没有标题/摘要/链接的。
 * 顺序保留（查询顺序 = 标签顺序），截到 24 条，别把提示词撑爆。
 */
export function mergeCandidates(hits: readonly BroadcastSearchHit[], limit = 24): BroadcastCandidate[] {
  const seen = new Set<string>();
  const out: BroadcastCandidate[] = [];
  for (const hit of hits) {
    if (!hit || typeof hit !== "object") continue;
    const url = String(hit.url ?? "").trim();
    const key = normalizeUrl(url);
    if (!key || seen.has(key)) continue;
    const domain = hostOf(url);
    if (isBlockedSource(domain, pathOf(url))) continue;
    const title = cleanText(hit.title, BROADCAST_TITLE_MAX);
    const summary = cleanText(hit.summary, BROADCAST_SUMMARY_MAX);
    if (!title || !summary) continue;
    seen.add(key);
    out.push({ title, url, summary, source: domain, domain, key });
    if (out.length >= limit) break;
  }
  return out;
}

/* -------------------------------------------------------------- 结构化 */

export type ParseIssueResult =
  | { ok: true; items: BroadcastItem[] }
  | { ok: false; error: string };

/** 模型很爱在 JSON 外面包一层 ```json；剥掉再 parse。 */
export function stripJsonFence(text: string): string {
  const raw = String(text ?? "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(raw);
  if (fence) return fence[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}

function validHttpUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (!/^https?:\/\//i.test(raw)) return "";
  try {
    return new URL(raw).toString();
  } catch {
    return "";
  }
}

/** 稳定的小 id：链接进过的就算同一条。 */
function shortHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * 解析她返回的一期。
 *
 * 规则（和设计文档一致）：
 *   · 真新闻 3–7 条；彩蛋 0–1 条，且必须是最后一条；
 *   · 真新闻必须有 http(s) 原文；给了 allowedUrls 时，链接必须来自候选；
 *   · 每条都要有 source / title / summary / comment；缺了就整条丢掉，
 *     丢到不足 3 条就判失败——宁可这期不出，也不拿半截糊弄。
 */
export function parseIssueDraft(
  text: string,
  opts: { allowedUrls?: Iterable<string> } = {}
): ParseIssueResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch {
    return { ok: false, error: "她写的不是合法 JSON" };
  }

  const rawItems = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)
      ? ((parsed as { items: unknown[] }).items)
      : null;
  if (!rawItems) return { ok: false, error: "JSON 里没有 items 数组" };

  const allowed = opts.allowedUrls
    ? new Set([...opts.allowedUrls].map((u) => normalizeUrl(u)).filter(Boolean))
    : null;

  const seen = new Set<string>();
  const items: BroadcastItem[] = [];
  let eggCount = 0;

  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const egg = e.egg === true;
    const title = cleanText(e.title, BROADCAST_TITLE_MAX);
    const summary = cleanText(e.summary, BROADCAST_SUMMARY_MAX);
    const comment = cleanText(e.comment, BROADCAST_COMMENT_MAX);
    const tag = typeof e.tag === "string" ? cleanText(e.tag, 20) : "";
    // 桌面信息流里这条叫 why（「你关注人工智能」）；模型没给就按关注标签补。
    const why = cleanText(e.why, 40) || (tag ? "你关注" + tag : "");
    const publishedAt = typeof e.publishedAt === "string" ? cleanText(e.publishedAt, 40) : "";

    if (!title || !summary || !comment) continue;

    if (egg) {
      eggCount += 1;
      items.push({
        id: "egg-" + shortHash(title + "|" + items.length),
        source: cleanText(e.source, 40) || "星际和平公司",
        domain: "",
        title,
        summary,
        url: "",
        ...(publishedAt ? { publishedAt } : {}),
        ...(tag ? { tag } : {}),
        ...(why ? { why } : {}),
        comment,
        egg: true,
      });
      continue;
    }

    const url = validHttpUrl(e.url);
    if (!url) continue;
    const key = normalizeUrl(url);
    if (!key || seen.has(key)) continue;
    if (allowed && !allowed.has(key)) continue;
    seen.add(key);
    items.push({
      id: "n-" + shortHash(key),
      source: cleanText(e.source, 40) || hostOf(url),
      domain: hostOf(url),
      title,
      summary,
      url,
      ...(publishedAt ? { publishedAt } : {}),
      ...(tag ? { tag } : {}),
      ...(why ? { why } : {}),
      comment,
    });
  }

  const real = items.filter((item) => !item.egg);
  if (real.length < BROADCAST_MIN_ITEMS) {
    return {
      ok: false,
      error: "只凑到 " + real.length + " 条够格的，不到 " + BROADCAST_MIN_ITEMS + " 条",
    };
  }
  if (real.length > BROADCAST_MAX_ITEMS) {
    return { ok: false, error: "真新闻 " + real.length + " 条，超过 " + BROADCAST_MAX_ITEMS + " 条上限" };
  }
  if (eggCount > 1) return { ok: false, error: "彩蛋最多一条" };

  if (eggCount === 1) {
    const last = items[items.length - 1];
    if (!last || last.egg !== true) {
      return { ok: false, error: "彩蛋必须排在最后一条" };
    }
  }

  return { ok: true, items };
}

/* ---------------------------------------------------------- 原文阅读稿 */

/** 读原文时给她的产物：要点 + 一篇短稿。 */
export interface BroadcastDigest {
  points: string[];
  detail: string;
}

const DROP_IN_ARTICLE = /<(script|style|noscript|svg|iframe|template|form|nav|footer|aside|header)\b[\s\S]*?<\/\1>/gi;

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&hellip;/gi, "…");
}

/**
 * 网页 → 正文纯文本。
 *
 * 只做「给模型读」这一档：剔掉脚本/导航/页脚，优先取 <article>/<main>，
 * 其余标签换行、实体解码、空白折叠。复杂版式会丢一些格式，但够写稿子。
 */
export function htmlToArticleText(html: string, max = 14000): string {
  let text = String(html ?? "");
  text = text.replace(/<!--[\s\S]*?-->/g, " ").replace(DROP_IN_ARTICLE, " ");
  const container =
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(text)?.[1] ??
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(text)?.[1] ??
    text;
  text = container
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|blockquote|figcaption)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  return text.slice(0, max);
}

/** 解析她读原文后的 JSON（外面包 json 围栏也认）。缺正文就当失败。 */
export function parseArticleDigest(raw: string): BroadcastDigest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const detail = typeof o.detail === "string" ? o.detail.trim() : "";
  if (!detail) return null;
  const points = Array.isArray(o.points)
    ? o.points
        .filter((p): p is string => typeof p === "string")
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];
  return { points, detail };
}

/** 用校验过的条目起一期（期号/日期由调用方给）。 */
export function buildBroadcastIssue(params: {
  date: string;
  no: number;
  items: BroadcastItem[];
  now?: Date;
}): BroadcastIssue {
  const now = params.now ?? new Date();
  return {
    id: params.date,
    no: params.no,
    date: params.date,
    createdAt: now.toISOString(),
    items: params.items,
    status: "ready",
  };
}
