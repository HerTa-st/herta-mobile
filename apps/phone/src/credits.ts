/**
 * 「关于」三页的名单：一份远程 JSON，网站与 App 读同一份（B13）。
 *
 * 契约（改字段先改这里 + apps/phone/test/credits.test.mjs + 网站那份 JSON）：
 *   updatedAt  "2026-11-06"
 *   sponsors[] { name, month: "2026-10", tier? }        // month 按 YYYY-MM
 *   devs[]     { name, role }                            // 只写作者本人 + 负责哪块
 *   credits[]  { kind: "work" | "idea", name, author? }  // work=取材自，idea=点子来自
 *   donate     { wechat?, alipay?, qqGroup? }            // wechat/alipay 是收款码**图片**地址
 *   issues[]   { title, detail, status: "fixed" | "open" }
 *
 * 三条边界：
 *   - 这里是**唯一**读名单的地方。取不到就返回 ok:false，页面写「名单暂时取不到」，
 *     不塞默认名单、不空着。
 *   - donate 的两个地址只当 <img src> 用：不拼成可点链接，不出现收款页跳转。
 *   - credits 里 kind=work / kind=idea 两类分开取（splitCredits），都不混进 devs。
 */

export const CREDITS_URL = "https://www.herta-st-gp.top/data/credits.json";

/**
 * 反馈表单。与网站同一行：site/assets/config.js 的 feedback。
 * 只在「关于」组里当外部表单打开，App 不发任何数据。
 */
export const FEEDBACK_FORM_URL =
  "https://mar530jpjrc.feishu.cn/share/base/form/shrcncOFTKF6oBtooLdJHb0Czhc";

/** 请求超时：手机切网/断网时别让她那个按钮一直转圈。 */
const TIMEOUT_MS = 9000;

export type CreditKind = "work" | "idea";
export type IssueStatus = "fixed" | "open";

export interface SponsorEntry {
  name: string;
  /** YYYY-MM；不合格式的在分组里落到「月份不详」。 */
  month: string;
  tier?: string;
}

export interface DevEntry {
  name: string;
  role: string;
}

export interface CreditEntry {
  kind: CreditKind;
  name: string;
  /** kind=work 时是被取材作品的作者。 */
  author?: string;
}

export interface DonateInfo {
  /** 收款码图片地址（只显示在弹层里，不做链接）。 */
  wechat?: string;
  alipay?: string;
  qqGroup?: string;
}

export interface IssueEntry {
  title: string;
  detail: string;
  status: IssueStatus;
}

export interface CreditsDoc {
  updatedAt?: string;
  sponsors: SponsorEntry[];
  devs: DevEntry[];
  credits: CreditEntry[];
  donate: DonateInfo;
  issues: IssueEntry[];
}

export const EMPTY_CREDITS: CreditsDoc = {
  sponsors: [],
  devs: [],
  credits: [],
  donate: {},
  issues: [],
};

/** 月份分组里给格式不对的那批用的桶名。 */
export const UNKNOWN_MONTH = "月份不详";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function parseSponsor(raw: unknown): SponsorEntry | null {
  const item = record(raw);
  const name = text(item.name);
  if (!name) return null;
  const tier = text(item.tier);
  const month = text(item.month);
  return tier ? { name, month, tier } : { name, month };
}

function parseDev(raw: unknown): DevEntry | null {
  const item = record(raw);
  const name = text(item.name);
  if (!name) return null;
  return { name, role: text(item.role) };
}

function parseCredit(raw: unknown): CreditEntry | null {
  const item = record(raw);
  const kind = text(item.kind);
  const name = text(item.name);
  // 只认这两个 kind：别的（拼错的、以后新加的）宁可不显示，也别混进两段里。
  if (!name || (kind !== "work" && kind !== "idea")) return null;
  const author = text(item.author);
  return kind === "work" && author ? { kind, name, author } : { kind, name };
}

function parseIssue(raw: unknown): IssueEntry | null {
  const item = record(raw);
  const title = text(item.title);
  if (!title) return null;
  const status = text(item.status);
  return {
    title,
    detail: text(item.detail),
    // 没写状态的按「还没修」算：已知问题页默认列的就是没修的，宁可多列不要漏。
    status: status === "fixed" ? "fixed" : "open",
  };
}

function donateFields(raw: Record<string, unknown>): DonateInfo {
  const info: DonateInfo = {};
  const wechat = text(raw.wechat);
  const alipay = text(raw.alipay);
  const qqGroup = text(raw.qqGroup);
  if (wechat) info.wechat = wechat;
  if (alipay) info.alipay = alipay;
  if (qqGroup) info.qqGroup = qqGroup;
  return info;
}

/**
 * 把远程 JSON 收成 CreditDoc。**不抛异常**：字段缺、类型错、整份是空的，
 * 都退回空列表，由页面说人话。
 */
export function parseCredits(raw: unknown): CreditsDoc {
  const doc = record(raw);
  const donate = record(doc.donate);
  return {
    updatedAt: text(doc.updatedAt) || undefined,
    sponsors: rows(doc.sponsors)
      .map(parseSponsor)
      .filter((item): item is SponsorEntry => item !== null),
    devs: rows(doc.devs)
      .map(parseDev)
      .filter((item): item is DevEntry => item !== null),
    credits: rows(doc.credits)
      .map(parseCredit)
      .filter((item): item is CreditEntry => item !== null),
    // 没给的字段就不出现（而不是给一个 undefined 键）：页面用「有没有」判断，
    // 测试也能直接 deepEqual 一份空对象。
    donate: donateFields(donate),
    issues: rows(doc.issues)
      .map(parseIssue)
      .filter((item): item is IssueEntry => item !== null),
  };
}

/** "2026-10" → "2026 / 10"；不合格式的原样显示。 */
export function formatMonth(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? match[1] + " / " + match[2] : month || UNKNOWN_MONTH;
}

export interface SponsorMonth {
  month: string;
  label: string;
  rows: SponsorEntry[];
}

/**
 * 按月分组，最近的月份排最前（页面上默认展开的就是第一组）。
 * 月份格式不对的收在最后一组，不丢数据。
 */
export function groupSponsorsByMonth(sponsors: readonly SponsorEntry[]): SponsorMonth[] {
  const buckets = new Map<string, SponsorEntry[]>();
  for (const sponsor of sponsors) {
    const key = /^\d{4}-\d{2}$/.test(sponsor.month) ? sponsor.month : UNKNOWN_MONTH;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(sponsor);
    else buckets.set(key, [sponsor]);
  }
  return [...buckets.entries()]
    .map(([month, list]) => ({ month, label: formatMonth(month), rows: list }))
    .sort((a, b) => {
      if (a.month === UNKNOWN_MONTH) return 1;
      if (b.month === UNKNOWN_MONTH) return -1;
      return a.month < b.month ? 1 : a.month > b.month ? -1 : 0;
    });
}

/** 「灵感与帮助」两段：取材自（work）/ 点子来自（idea）。两类各回各的，不混排。 */
export function splitCredits(credits: readonly CreditEntry[]): {
  works: CreditEntry[];
  ideas: CreditEntry[];
} {
  return {
    works: credits.filter((item) => item.kind === "work"),
    ideas: credits.filter((item) => item.kind === "idea"),
  };
}

/** 已知问题页：没修的排前面，同状态保 JSON 顺序。 */
export function sortIssues(issues: readonly IssueEntry[]): IssueEntry[] {
  return [...issues].sort((a, b) => {
    if (a.status === b.status) return 0;
    return a.status === "open" ? -1 : 1;
  });
}

function devMode(): boolean {
  try {
    // 必须直接写 import.meta.env.DEV 这个表达式：Vite 在构建时按 define 替换它；
    // 先存到变量再点属性就不会被替换（之前就是这么踩的，?credits= 完全不生效）。
    // Node 里（单元测试）import.meta.env 是 undefined，靠 try/catch 兜住。
    return import.meta.env.DEV === true;
  } catch {
    return false;
  }
}

export interface CreditsSource {
  url: string;
  /** 是不是本地 mock（只在 dev 下用 ?credits= 指到 mock 时才是 true）。 */
  mock: boolean;
}

/**
 * 读哪一份。发布包只认 CREDITS_URL；
 * 开发时可以用 ?credits=/mock/credits.json 换成本地那份看版式，
 * 也可以 ?credits=https://坏地址 验「取不到」那条。
 *
 * 为什么不做「远程失败自动回退本地」：那样「取不到」这条验收就永远测不出来，
 * 线上也会悄悄显示一份过期名单。
 */
export function resolveCreditsSource(): CreditsSource {
  if (devMode() && typeof location !== "undefined") {
    const asked = new URLSearchParams(location.search).get("credits");
    if (asked && asked.trim()) {
      const url = asked.trim();
      return { url, mock: url.startsWith("/") };
    }
  }
  return { url: CREDITS_URL, mock: false };
}

export type LoadCreditsResult =
  | { ok: true; doc: CreditsDoc; mock: boolean }
  | { ok: false; detail: string };

/**
 * 取名单。失败只返回一句人话，页面统一写「名单暂时取不到」+ 这句细节。
 * 不缓存、不落盘：换名单在网站上改完，下次进页面就是新的。
 */
export async function loadCredits(): Promise<LoadCreditsResult> {
  const source = resolveCreditsSource();
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), TIMEOUT_MS)
    : null;
  try {
    const response = await fetch(source.url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) {
      return { ok: false, detail: "名单文件没取到（服务器回 " + response.status + "）。" };
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return { ok: false, detail: "名单文件读不懂（不是合法 JSON）。" };
    }
    if (raw === null || typeof raw !== "object") {
      return { ok: false, detail: "名单文件不是一份名单。" };
    }
    return { ok: true, doc: parseCredits(raw), mock: source.mock };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/abort/i.test(message)) return { ok: false, detail: "等了 " + TIMEOUT_MS / 1000 + " 秒没回应，可能没连上网。" };
    return { ok: false, detail: "请求发不出去，可能没连上网。" };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
