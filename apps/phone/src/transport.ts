/**
 * 模型通道。
 *
 * 这是整个 M1 的卡点：Capacitor 的 origin 是 https://localhost，
 * 如果 api.deepseek.com 不回 CORS 头，浏览器里的 fetch 会被 WebView 直接掐掉。
 * 所以生产路径走原生（Android OkHttp），浏览器 fetch 只作为开发期兜底。
 *
 * 现在原生插件的 Kotlin 侧还没写——没写就明确报错，不许静默降级成 fetch
 * 让"在真机上能聊"这件事变成假象。
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { ChatMessage } from "@herta/core";

export interface ChatRequest {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ChatTransport {
  readonly name: string;
  /** 逐段吐字；上层负责拼成一句再解析标签。 */
  stream(req: ChatRequest): AsyncGenerator<string>;
  /** DeepSeek 官方搜索：POST /v1/tools/search。 */
  search(query: string, opts: { apiKey: string; baseUrl: string; count?: number }): Promise<SearchHit[]>;
}

export interface SearchHit {
  title: string;
  url: string;
  summary: string;
}

/* --------------------------------------------------------- 浏览器兜底实现 */

function sseData(chunk: string): string[] {
  const out: string[] = [];
  for (const line of chunk.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (payload && payload !== "[DONE]") out.push(payload);
  }
  return out;
}

export const browserTransport: ChatTransport = {
  name: "fetch",
  async *stream(req) {
    const res = await fetch(req.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + req.apiKey },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        max_tokens: req.maxTokens,
        stream: true,
      }),
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
      for (const payload of sseData(ready)) {
        try {
          const j = JSON.parse(payload);
          const piece = j?.choices?.[0]?.delta?.content;
          if (typeof piece === "string" && piece) yield piece;
        } catch {
          /* 半截 JSON：下一轮再拼 */
        }
      }
    }
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

/**
 * 原生插件只有三个方法。
 * 注意 addListener 是**插件上**的，不是全局 Capacitor.addListener —— 后者是桥级事件，
 * 传插件名进去只会静默收不到任何东西（第一版就这么写错过一次）。
 */
interface HertaHttpPlugin {
  stream(options: {
    requestId: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<{ status: number }>;
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
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          max_tokens: req.maxTokens,
          stream: true,
        }),
      });
      // 非 2xx 时**不能立刻抛**：服务端把错误原因写在响应体里，而原生产生的是
      // 一串 chunk。先把它收完，再把真正的原因带出去——否则用户只看到一个光秃秃的
      // 状态码（422 那次就是这么瞎猜的）。
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
          for (const payload of sseData(next)) {
            try {
              const j = JSON.parse(payload);
              const piece = j?.choices?.[0]?.delta?.content;
              if (typeof piece === "string" && piece) yield piece;
            } catch {
              /* 半截 JSON */
            }
          }
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
  async search() {
    throw new Error("原生搜索通道未实现（M1 待办：HertaHttp 插件 + /v1/tools/search）");
  },
};

export function pickTransport(): ChatTransport {
  return Capacitor.isNativePlatform() ? nativeTransport : browserTransport;
}
