/**
 * 她在这台手机上真正能用的工具。
 *
 * 一条原则：**每个工具都必须在失败时说清楚为什么**，而不是抛一个空异常。
 * 她看不到控制台，只知道"刚才那下失败了"——所以她需要的那句话必须是能说给用户听的。
 */

import type { ToolImpl } from "@herta/core";
import { buildSystemTools, type SystemToolsContext } from "./devtools-system.ts";
import { captionImage } from "./vision.ts";
import { ensureGalleryPermission, listPhotos, readPhoto } from "./gallery.ts";
import type { StickerRecord } from "./storage.ts";
import type { ChatTransport } from "./transport.ts";

export interface ToolContext {
  transport: ChatTransport;
  apiKey: string;
  baseUrl: string;
  /** 用户手动选给她读的文件（名字 → 文本）。工具只能读这里，不能自己翻磁盘。 */
  files: Map<string, string>;
  /** 视觉模型名：看图要用它。 */
  visionModel: string;
  /** 允许翻相册。 */
  albumEnabled: boolean;
  /** 她自己的表情库（不含你的箱——混在一起她会开始发你存的图）。 */
  stickers: StickerRecord[];
  /** 挑中一张时回调给回合层，由它贴一张表情块。 */
  onSticker(record: StickerRecord): void;
  /** 你这一轮发的那张表情（没发就是空的）。她可以把它收进自己库里。 */
  currentSticker?: StickerRecord | null;
  /** 她把你的表情收进库时回调；回合层负责落库。 */
  onKeepSticker?(record: StickerRecord): void;
  /** 手机能力：提醒 / 日历 / 状态 / 打开 / 分享。每个对应设置里一个开关。 */
  system: SystemToolsContext;
  /** 省 token 档：写类工具不注册。 */
  cheap: boolean;
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
      if (names.length === 0) throw new Error("还没有文件——让他先选一个给你读（回形针的「选文件」，或者设置里）。");
      const want = String(args.name ?? "").trim();
      if (!want) return "现在能读的：" + names.join("、");
      const hit = names.find((n) => n === want) ?? names.find((n) => n.includes(want));
      if (!hit) throw new Error("没有这个文件。能读的是：" + names.join("、"));
      const text = ctx.files.get(hit) ?? "";
      return text.length > 8000 ? text.slice(0, 8000) + "…（截断，原文 " + text.length + " 字）" : text;
    },
  };

  const sticker: ToolImpl = {
    spec: {
      name: "sticker",
      description:
        "发一张表情包。想用表情代替一句话、或者话说完想补个反应时用。可以给 tag 说明想要什么感觉（例如 得意/无语/敷衍/生气），不给就随机。",
      parameters: {
        type: "object",
        properties: { tag: { type: "string", description: "想要的感觉，比如 无语 / 得意 / 敷衍" } },
        required: [],
      },
    },
    async run(args) {
      const list = ctx.stickers;
      if (list.length === 0) throw new Error("表情库是空的。让他先在设置里给你几张图。");
      const want = String(args.tag ?? "").trim().toLowerCase();
      const hit =
        want &&
        list.find(
          (s) => s.name.toLowerCase().includes(want) || s.tags.some((t) => t.toLowerCase().includes(want))
        );
      const pick = hit || list[Math.floor(Math.random() * list.length)];
      ctx.onSticker(pick);
      return "（发了一张表情包：" + pick.name + "）";
    },
  };

  /* ------------------------------------------------------------ 相册 */

  const album: ToolImpl = {
    spec: {
      name: "album",
      description: "翻他的相册，列出最近的照片。只给编号、文件名与时间——想真看某一张再用 look_at_photo。",
      parameters: { type: "object", properties: { limit: { type: "integer", description: "要几张，默认 40" } }, required: [] },
    },
    async run(args) {
      if (!ctx.albumEnabled) throw new Error("翻相册的开关关着。让他先去设置里打开。");
      const granted = await ensureGalleryPermission();
      if (!granted) throw new Error("他还没给相册权限——系统弹窗里点允许，或者去设置里开。");
      const limit = Math.min(80, Math.max(1, Number(args.limit ?? 40) || 40));
      const photos = await listPhotos(limit);
      if (photos.length === 0) return "相册里没有照片。";
      return photos
        .map((p, i) => i + 1 + ". " + p.name + " · " + new Date(p.takenAt).toLocaleString("zh-CN") + " · id=" + p.id)
        .join("\n");
    },
  };

  const lookAtPhoto: ToolImpl = {
    spec: {
      name: "look_at_photo",
      description: "真去看相册里的某一张。要先用 album 拿到 id。返回的是这张图的客观描述，不是原图。",
      parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    },
    async run(args) {
      if (!ctx.albumEnabled) throw new Error("翻相册的开关关着。");
      if (!ctx.visionModel) throw new Error("没配视觉模型，看了也说不出来。让他去设置里填一个。");
      const id = Number(args.id);
      if (!Number.isFinite(id)) throw new Error("id 不对");
      const granted = await ensureGalleryPermission();
      if (!granted) throw new Error("他还没给相册权限。");
      const { data } = await readPhoto(id);
      const caption = await captionImage(
        ctx.transport,
        { apiKey: ctx.apiKey, baseUrl: ctx.baseUrl, model: ctx.visionModel },
        data
      );
      return caption || "这张图没看出什么。";
    },
  };

  /**
   * 收下你发的这张表情。
   *
   * 只在"你这一轮确实发了一张"时才注册——她要是每轮都看得见这把工具，
   * 就会在你说「在吗」的时候把上一张表情再收一次。
   */
  const keepSticker: ToolImpl = {
    spec: {
      name: "keep_sticker",
      description: "把开拓者刚发的那张表情收进自己的库，以后可以自己发。觉得这张有用、合自己胃口时用。",
      parameters: { type: "object", properties: {}, required: [] },
    },
    async run() {
      const src = ctx.currentSticker;
      if (!src) throw new Error("他这一轮没有发表情。");
      ctx.onKeepSticker?.(src);
      return "收进库里了：" + src.name + (src.tags.length ? "（" + src.tags.join("、") + "）" : "");
    },
  };

  // 表情库空着就不给表情工具；相册开关关着就不给相册工具——
  // 否则她每轮都可能去调一个必然失败的东西
  const base = [now, clipboard, sandbox, search, device, readFile];
  const withSticker = ctx.stickers.length > 0 ? [...base, sticker] : base;
  const withKeep = ctx.currentSticker ? [...withSticker, keepSticker] : withSticker;
  const withSystem = [...withKeep, ...buildSystemTools(ctx.system, { cheap: ctx.cheap })];
  return ctx.albumEnabled ? [...withSystem, album, lookAtPhoto] : withSystem;
}
