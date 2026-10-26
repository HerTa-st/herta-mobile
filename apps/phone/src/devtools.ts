/**
 * 她在这台手机上真正能用的工具。
 *
 * 一条原则：**每个工具都必须在失败时说清楚为什么**，而不是抛一个空异常。
 * 她看不到控制台，只知道"刚才那下失败了"——所以她需要的那句话必须是能说给用户听的。
 */

import type { ToolImpl } from "@herta/core";
import type { ChatTransport } from "./transport.ts";

export interface ToolContext {
  transport: ChatTransport;
  apiKey: string;
  baseUrl: string;
  /** 用户手动选给她读的文件（名字 → 文本）。工具只能读这里，不能自己翻磁盘。 */
  files: Map<string, string>;
}

/** 在 Web Worker 里跑一小段 JS，超时就掐掉——不阻塞界面，也不让她卡死整个 App。 */
export function runSandboxed(code: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const src = `
      self.onmessage = (e) => {
        try {
          const out = (0, eval)(e.data);
          self.postMessage({ ok: true, value: out });
        } catch (err) {
          self.postMessage({ ok: false, error: String(err && err.message || err) });
        }
      };
    `;
    const blob = new Blob([src], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    const timer = setTimeout(() => {
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error("算了超过 " + timeoutMs + " 毫秒，已经掐掉"));
    }, timeoutMs);

    worker.onmessage = (e) => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      const d = e.data ?? {};
      if (d.ok) {
        const v = d.value;
        resolve(typeof v === "string" ? v : JSON.stringify(v ?? null));
      } else {
        reject(new Error(String(d.error ?? "运行失败")));
      }
    };
    worker.postMessage(code);
  });
}

function weekday(d: Date): string {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
}

export function buildTools(ctx: ToolContext): ToolImpl[] {
  const now: ToolImpl = {
    spec: {
      name: "now",
      description: "查现在的时间。需要知道今天几号、星期几、几点时用。",
      parameters: { type: "object", properties: {}, required: [] },
    },
    async run() {
      const d = new Date();
      const off = -d.getTimezoneOffset() / 60;
      return (
        d.getFullYear() +
        " 年 " +
        (d.getMonth() + 1) +
        " 月 " +
        d.getDate() +
        " 日 " +
        weekday(d) +
        " " +
        String(d.getHours()).padStart(2, "0") +
        ":" +
        String(d.getMinutes()).padStart(2, "0") +
        "（时区 UTC" +
        (off >= 0 ? "+" : "") +
        off +
        "）"
      );
    },
  };

  const clipboard: ToolImpl = {
    spec: {
      name: "clipboard",
      description: "读写手机剪贴板。action=read 读出他复制的东西；action=write 把 text 放进剪贴板。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "write"] },
          text: { type: "string", description: "action=write 时要写入的内容" },
        },
        required: ["action"],
      },
    },
    async run(args) {
      const action = String(args.action ?? "");
      if (action === "write") {
        const text = String(args.text ?? "");
        if (!text) throw new Error("要写什么？text 是空的");
        await navigator.clipboard.writeText(text);
        return "已经放进剪贴板了（" + text.length + " 字）。";
      }
      try {
        const text = await navigator.clipboard.readText();
        return text ? text.slice(0, 4000) : "剪贴板是空的。";
      } catch {
        throw new Error("手机不让读剪贴板（要你在系统里给过权限）。可以把内容贴进输入框给我。");
      }
    },
  };

  const sandbox: ToolImpl = {
    spec: {
      name: "calc",
      description:
        "在沙箱里跑一小段 JavaScript 并返回结果。用来算数、处理他贴的数据。只有表达式或同步代码，不能联网、不能碰文件。",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "要执行的 JS，最后一个表达式的值就是结果" } },
        required: ["code"],
      },
    },
    async run(args) {
      const code = String(args.code ?? "").trim();
      if (!code) throw new Error("code 是空的");
      const out = await runSandboxed(code);
      return out.length > 2000 ? out.slice(0, 2000) + "…（截断）" : out;
    },
  };

  const search: ToolImpl = {
    spec: {
      name: "web_search",
      description: "用 DeepSeek 的搜索接口上网查东西。返回标题、链接和摘要。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词" },
          count: { type: "integer", description: "要几条，默认 5，最多 10" },
        },
        required: ["query"],
      },
    },
    async run(args) {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("搜什么？query 是空的");
      if (!ctx.apiKey) throw new Error("还没填 API Key");
      const count = Math.min(10, Math.max(1, Number(args.count ?? 5) || 5));
      const hits = await ctx.transport.search(query, { apiKey: ctx.apiKey, baseUrl: ctx.baseUrl, count });
      if (hits.length === 0) return "没搜到东西。";
      return hits
        .map((h, i) => i + 1 + ". " + h.title + "\n   " + h.url + "\n   " + (h.summary ?? "").slice(0, 220))
        .join("\n");
    },
  };

  const device: ToolImpl = {
    spec: {
      name: "device",
      description: "看这台手机的状态：是否联网、屏幕大小、语言。",
      parameters: { type: "object", properties: {}, required: [] },
    },
    async run() {
      const conn = (navigator as unknown as { connection?: { effectiveType?: string; downlink?: number } }).connection;
      return [
        "联网：" + (navigator.onLine ? "在" : "断了"),
        conn?.effectiveType ? "网络类型：" + conn.effectiveType : "",
        "屏幕：" + window.screen.width + "×" + window.screen.height,
        "语言：" + (navigator.language || "未知"),
      ]
        .filter(Boolean)
        .join("；");
    },
  };

  const readFile: ToolImpl = {
    spec: {
      name: "read_file",
      description: "读他选给你的文件。不给 name 就先列出有哪些。",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: [] },
    },
    async run(args) {
      const names = [...ctx.files.keys()];
      if (names.length === 0) throw new Error("还没有文件——让他先在「设置」里选一个给你读。");
      const want = String(args.name ?? "").trim();
      if (!want) return "现在能读的：" + names.join("、");
      const hit = names.find((n) => n === want) ?? names.find((n) => n.includes(want));
      if (!hit) throw new Error("没有这个文件。能读的是：" + names.join("、"));
      const text = ctx.files.get(hit) ?? "";
      return text.length > 8000 ? text.slice(0, 8000) + "…（截断，原文 " + text.length + " 字）" : text;
    },
  };

  return [now, clipboard, sandbox, search, device, readFile];
}
