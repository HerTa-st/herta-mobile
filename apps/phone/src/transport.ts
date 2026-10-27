/**
 * 模型通道。
 *
 * 原生通道存在的唯一理由：WebView 的 origin 是 https://localhost，
 * 如果 api.deepseek.com 不回 CORS 头，页面里的 fetch 会被直接掐掉。
 *
 * 注意这里吐的是**结构化的流**（`ChatDelta`），不是纯文本：
 * 带工具之后，模型可能不下文字而是发一次 tool_call，那时正文是空的。
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { ChatDelta, ChatMessage, ToolSpec } from "@herta/protocol";
import { toProviderMessages, toProviderTools } from "@herta/core";

export interface ChatRequest {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  /** 给她一只手：工具声明。 */
  tools?: ToolSpec[];
  signal?: AbortSignal;
}

export interface SearchHit {
  title: string;
  url: string;
  summary: string;
}

export interface ChatTransport {
  readonly name: string;
  stream(req: ChatRequest): AsyncGenerator<ChatDelta>;
  /** DeepSeek 官方搜索：POST /v1/tools/search。 */
  search(query: string, opts: { apiKey: string; baseUrl: string; count?: number }): Promise<SearchHit[]>;
  /** 一次性 GET，整段文本返回（分享页的数据接口用）。 */
  getText(url: string): Promise<string>;
  /** 一次性 POST，拿二进制（语音合成）。返回 base64 与 mime。 */
  postBinary(url: string, opts: { headers: Record<string, string>; body: string }): Promise<{ base64: string; mediaType: string }>;
  /** 一次性 POST，拿 JSON 文本（MiniMax 那种"音频装在 JSON 里"的接口）。 */
  post(url: string, opts: { headers: Record<string, string>; body: string }): Promise<{ status: number; body: string }>;
}

function parseSseChunk(chunk: string): ChatDelta[] {
  const out: ChatDelta[] = [];
  for (const line of chunk.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      out.push({ type: "done", finishReason: null });
      continue;
    }
    try {
      const j = JSON.parse(payload);
      // DeepSeek 把整次请求的 usage 挂在最后一块上（无论有没有设 stream_options）。
      // 那段没有正文，choices 里也不会有增量——不在这里接住就永远拿不到用量。
      const u = j?.usage;
      if (u) {
        out.push({
          type: "usage",
          usage: {
            prompt: Number(u.prompt_tokens ?? 0),
            completion: Number(u.completion_tokens ?? 0),
            cached: Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0),
          },
        });
      }
      const choice = j?.choices?.[0];
      const piece = choice?.delta?.content;
      if (typeof piece === "string" && piece) out.push({ type: "text", text: piece });
      const calls = choice?.delta?.tool_calls;
      if (Array.isArray(calls)) {
        for (const c of calls) {
          out.push({
            type: "tool_call",
            index: typeof c.index === "number" ? c.index : 0,
            id: c.id,
            name: c.function?.name,
            arguments: c.function?.arguments,
          });
        }
      }
      if (choice?.finish_reason) out.push({ type: "done", finishReason: String(choice.finish_reason) });
    } catch {
      /* 半截 JSON，下一批再拼 */
    }
  }
  return out;
}

function requestBody(req: ChatRequest): string {
  return JSON.stringify({
    model: req.model,
    // 这两处都必须是接口那套两层结构，直发内部形状会 422
    messages: toProviderMessages(req.messages),
    max_tokens: req.maxTokens,
    stream: true,
    ...(req.tools && req.tools.length > 0
      ? { tools: toProviderTools(req.tools), tool_choice: "auto" }
      : {}),
  });
}

/* --------------------------------------------------------- 浏览器兜底实现 */

export const browserTransport: ChatTransport = {
  name: "fetch",
  async *stream(req) {
    const res = await fetch(req.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + req.apiKey },
      body: requestBody(req),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error("模型接口 " + res.status + "：" + (await res.text()).slice(0, 300));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const cut = buf.lastIndexOf("\n");
      if (cut < 0) continue;
      const ready = buf.slice(0, cut);
      buf = buf.slice(cut + 1);
      for (const d of parseSseChunk(ready)) yield d;
    }
  },
  async getText(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("接口 " + res.status);
    return res.text();
  },
  async postBinary(url, { headers, body }) {
    const res = await fetch(url, { method: "POST", headers, body });
    if (!res.ok) throw new Error("接口 " + res.status + "：" + (await res.text()).slice(0, 200));
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (const b of buf) bin += String.fromCharCode(b);
    return { base64: btoa(bin), mediaType: res.headers.get("content-type") ?? "audio/mpeg" };
  },
  async post(url, { headers, body }) {
    const res = await fetch(url, { method: "POST", headers, body });
    return { status: res.status, body: await res.text() };
  },
  async search(query, { apiKey, baseUrl, count = 5 }) {
    const res = await fetch(baseUrl.replace(/\/$/, "") + "/v1/tools/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({ query, count, need_content: true }),
    });
    if (!res.ok) throw new Error("搜索接口 " + res.status);
    const j = (await res.json()) as { results?: SearchHit[] };
    return j.results ?? [];
  },
};

/* ----------------------------------------------------------- 原生通道 */

interface HertaChunk {
  requestId: string;
  data?: string;
  done?: boolean;
  error?: string;
}

interface HertaHttpPlugin {
  stream(options: {
    requestId: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<{ status: number }>;
  get(options: { url: string }): Promise<{ status: number; body: string }>;
  post(options: { url: string; headers: Record<string, string>; body: string }): Promise<{ status: number; body: string }>;
  postBinary(options: {
    url: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<{ status: number; base64: string; mediaType: string }>;
  cancel(options: { requestId: string }): Promise<void>;
  addListener(event: "chunk", cb: (data: HertaChunk) => void): Promise<PluginListenerHandle>;
}

const HertaHttp = registerPlugin<HertaHttpPlugin>("HertaHttp");

export const nativeTransport: ChatTransport = {
  name: "native",
  async *stream(req) {
    const requestId = crypto.randomUUID();
    const chunks: string[] = [];
    let closed = false;
    let failure: string | null = null;

    const listener = await HertaHttp.addListener("chunk", (ev: HertaChunk) => {
      if (ev.requestId !== requestId) return;
      if (ev.data) chunks.push(ev.data);
      if (ev.error) failure = ev.error;
      if (ev.done) closed = true;
    });

    try {
      const { status } = await HertaHttp.stream({
        requestId,
        url: req.baseUrl.replace(/\/$/, "") + "/chat/completions",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + req.apiKey },
        body: requestBody(req),
      });

      const bad = status < 200 || status >= 300;
      let errText = "";

      while (true) {
        if (failure && !bad) throw new Error(String(failure));
        const next = chunks.shift();
        if (next !== undefined) {
          if (bad) {
            errText += next;
            continue;
          }
          for (const d of parseSseChunk(next)) yield d;
          continue;
        }
        if (closed) break;
        await new Promise((r) => setTimeout(r, 16));
      }

      if (bad) {
        const detail = errText.replace(/\s+/g, " ").trim().slice(0, 300);
        throw new Error("模型接口 " + status + (detail ? "：" + detail : "（响应体为空）"));
      }
    } finally {
      await listener.remove();
      await HertaHttp.cancel({ requestId }).catch(() => undefined);
    }
  },
  async getText(url) {
    const { status, body } = await HertaHttp.get({ url });
    if (status < 200 || status >= 300) throw new Error("接口 " + status + "：" + String(body ?? "").slice(0, 200));
    return body;
  },
  async post(url, { headers, body }) {
    const res = await HertaHttp.post({ url, headers, body });
    return { status: res.status, body: res.body };
  },
  async postBinary(url, { headers, body }) {
    const res = await HertaHttp.postBinary({ url, headers, body });
    if (res.status < 200 || res.status >= 300) throw new Error("接口 " + res.status);
    return { base64: res.base64, mediaType: res.mediaType || "audio/mpeg" };
  },
  async search(query, { apiKey, baseUrl, count = 5 }) {
    const { status, body } = await HertaHttp.post({
      url: baseUrl.replace(/\/$/, "") + "/v1/tools/search",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({ query, count, need_content: true }),
    });
    if (status < 200 || status >= 300) throw new Error("搜索接口 " + status + "：" + String(body ?? "").slice(0, 200));
    const j = JSON.parse(body) as { results?: SearchHit[] };
    return j.results ?? [];
  },
};

export function pickTransport(): ChatTransport {
  return Capacitor.isNativePlatform() ? nativeTransport : browserTransport;
}
