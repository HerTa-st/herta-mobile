/**
 * 今天这一期怎么来：DeepSeek 搜索 → 去重筛源 → 她挑+写评 → 严格 JSON。
 *
 * 设计文档：docs/设计-星际和平播报-v1.md（决策 5/6/9/10/11）。
 * 纯逻辑（去重、校验、期号、彩蛋规则）在 packages/core/src/broadcast.ts；
 * 这里只管网络和提示词，方便以后换模型/换搜索接口。
 */

import {
  mergeCandidates,
  buildSearchQueries,
  dateLabel,
  localDateId,
  parseIssueDraft,
  type AssetSource,
  type BroadcastItem,
  type BroadcastSearchHit,
} from "@herta/core";
import { BrowserAssetSource } from "../assets-browser.ts";
import type { Settings } from "../settings.ts";
import { collectDetailed } from "../stream.ts";
import { recordUsageFrom } from "../usage-ledger.ts";
import { pickTransport, type ChatTransport } from "../transport.ts";

export interface GeneratedBroadcast {
  items: BroadcastItem[];
  queries: string[];
  candidates: number;
}

const defaultAssets = new BrowserAssetSource();
const defaultTransport = pickTransport();
const TIMEOUT_MS = 90_000;
// 桌面信息流的 cards 调用也走 4096 的 side model；5 条带 why/comment 的 JSON 不会被截断
const MAX_TOKENS = 3000;

/** 生成用的依赖；测试里换掉 transport / 素材源，不碰真网络。 */
export interface GenerateDeps {
  transport?: ChatTransport;
  assets?: Pick<AssetSource, "promptAssets">;
}

function systemPrompt(bio: string, tags: readonly string[]): string {
  return [
    bio,
    "〔现在不是聊天。你在给「星际和平播报」写今天这一期，读者是你认识的那个人。〕",
    "〔规矩〕",
    "1. 只从候选新闻里挑，不许自己编真新闻，不许改链接。",
    "2. 挑 3–7 条（目标 5 条），宁缺毋滥；每条都要有 source / title / summary / url / tag / comment / why。",
    "3. title 用中文，不要标题党；summary 2–3 句、中立；comment 是你的一句话评（判断或吐槽，最多 40 字），不是摘要。",
    "3.1 why 是它和读者（开拓者）的关系，一个短句：说它落在读者关注的哪个主题上，例如「你关注人工智能」「你关注游戏」；不要写你自己的名字或项目名。",
    "4. 可选一条彩蛋：星际和平公司/空间站的世界观虚构新闻，egg=true，必须放最后一条，url 留空，source 写「星际和平公司」。多数期不加。",
    "5. 关注标签：" + (tags.join("、") || "科技") + "。tag 从这几个里选。",
    "6. 只输出 JSON，不要解释，不要 markdown 围栏。",
    'JSON 形状：{"items":[{"source":"网易","title":"…","summary":"…","url":"https://…","tag":"人工智能","why":"你关注人工智能","comment":"…","egg":false}]}',
  ].join("\n");
}

function userPrompt(candidates: readonly { source: string; title: string; summary: string; url: string }[], date: string, tags: readonly string[]): string {
  const lines = [
    "今天是 " + dateLabel(date) + "。关注标签：" + (tags.join("、") || "科技") + "。",
    "候选新闻（共 " + candidates.length + " 条）：",
  ];
  candidates.forEach((c, i) => {
    lines.push("[" + (i + 1) + "] 来源域名：" + c.source);
    lines.push("标题：" + c.title);
    lines.push("摘要：" + c.summary);
    lines.push("链接：" + c.url);
  });
  return lines.join("\n");
}

async function callModel(opts: {
  transport: ChatTransport;
  settings: Settings;
  system: string;
  user: string;
  retryNote?: string;
}): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const messages = [
      { role: "system" as const, content: opts.system },
      {
        role: "user" as const,
        content:
          opts.user +
          (opts.retryNote
            ? "\n\n上次的问题是：" + opts.retryNote + "。按规矩重写，只输出 JSON，不要解释。"
            : ""),
      },
    ];
    const seen = await collectDetailed(
      opts.transport.stream({
        apiKey: opts.settings.apiKey,
        baseUrl: opts.settings.baseUrl,
        model: opts.settings.model,
        messages,
        maxTokens: MAX_TOKENS,
        signal: ac.signal,
      })
    );
    // B14：生成一期播报是实打实的一次长请求
    recordUsageFrom("broadcast", seen.usage);
    return seen.text;
  } finally {
    clearTimeout(timer);
  }
}

/** 生成一期（不落库；期号由调用方按已有期数算）。失败抛人话。 */
export async function generateBroadcast(
  opts: {
    settings: Settings;
    tags: readonly string[];
    now?: Date;
  },
  deps: GenerateDeps = {}
): Promise<GeneratedBroadcast> {
  const { settings, tags } = opts;
  if (!settings.apiKey) throw new Error("先在设置里填 API Key。");
  const transport = deps.transport ?? defaultTransport;
  const assets = deps.assets ?? defaultAssets;

  const now = opts.now ?? new Date();
  const date = localDateId(now);
  const queries = buildSearchQueries(tags, 4);

  const hits: BroadcastSearchHit[] = [];
  let searchError: unknown = null;
  for (const query of queries) {
    try {
      const found = await transport.search(query, {
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        count: 8,
      });
      hits.push(...found);
    } catch (error) {
      searchError = searchError ?? error;
    }
  }

  if (hits.length === 0) {
    const detail = searchError instanceof Error && searchError.message ? "：" + searchError.message : "";
    throw new Error("今天没搜到新闻" + detail);
  }

  const candidates = mergeCandidates(hits, 24);
  if (candidates.length < 3) {
    throw new Error("今天没搜到足够的内容（候选只有 " + candidates.length + " 条）");
  }

  const promptAssets = await assets.promptAssets();
  const system = systemPrompt(promptAssets.hertaBio, tags);
  const user = userPrompt(candidates, date, tags);

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await callModel({
      transport,
      settings,
      system,
      user,
      retryNote: attempt > 0 ? lastError : undefined,
    });
    const parsed = parseIssueDraft(raw, { allowedUrls: candidates.map((c) => c.url) });
    if (parsed.ok) return { items: parsed.items, queries, candidates: candidates.length };
    lastError = parsed.error;
  }

  throw new Error("她今天这期没写完整：" + (lastError || "输出不是合法的播报 JSON"));
}
