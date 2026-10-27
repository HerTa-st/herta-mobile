/**
 * 她伸向手机的那几只手：提醒、日历、手机状态、打开、分享。
 *
 * 和 devtools.ts 分开是因为这一批全是"要权限"的：每个都对应设置里一个开关，
 * 关着就连工具都不注册——不注册比注册了再报错好，不然她每轮都可能去撞一次墙。
 *
 * 每条工具都标了 kind：读（看一眼、算一下）便宜且不太会出事，写（改掉什么、
 * 发出去）贵且会留下痕迹。工具循环按 kind 分配轮次与次数，见 core/tools.ts。
 */

import type { ToolImpl } from "@herta/core";
import { writeNextPing } from "./proactive.ts";
import { mediaControl, nowPlaying, recentNotifications } from "./notif.ts";
import { readScreen, tapText } from "./a11y.ts";
import {
  addEvent,
  cancelReminder,
  formatBytes,
  listReminders,
  openLink,
  phoneStatus,
  scheduleReminder,
  shareOut,
  snapPhoto,
  upcomingEvents,
  whereAmI,
  type ReminderRecord,
} from "./capabilities.ts";

export interface SystemToolsContext {
  reminders: boolean;
  calendar: boolean;
  status: boolean;
  open: boolean;
  share: boolean;
  /** 看你现在在哪儿（经纬度）。 */
  location: boolean;
  /** 打开相机拍一张，再由视觉模型描述给她。 */
  camera: boolean;
  /** 读通知栏（要先在系统里开「通知使用权」）。 */
  notify: boolean;
  /** 看/控正在放的音乐（同一个授权）。 */
  media: boolean;
  /** 无障碍：读当前屏幕 / 按文字点一下（白名单在原生侧判断）。 */
  a11y: boolean;
  /** 她能不能自己排下一次主动找你（常驻服务开着才有意义）。 */
  proactive: boolean;
  /** 把一张图变成文字描述（相机用；没配视觉模型就别给这个回调）。 */
  describePhoto?(dataUrl: string): Promise<string>;
}

/** 时间：认 ISO 8601，也认 "in 30m / 30分钟后 / 明天 8:00" 这类说法里最常见的两种。 */
export function parseWhen(raw: string, now = new Date()): Date | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime())) return iso;

  const rel = s.match(/^(?:in\s*)?(\d+)\s*(分钟|分|m|min|小时|h|hour|hours)\s*(?:后|之后)?$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = /^(小时|h)/.test(unit) ? n * 3600_000 : n * 60_000;
    return new Date(now.getTime() + ms);
  }
  return null;
}

function stamp(d: Date): string {
  return d.toLocaleString("zh-CN", { hour12: false });
}

export function buildSystemTools(ctx: SystemToolsContext, opts: { cheap: boolean } = { cheap: false }): ToolImpl[] {
  const out: ToolImpl[] = [];

  if (ctx.reminders) {
    out.push({
      spec: {
        kind: "write",
        name: "remind",
        description:
          "给他排一条到点会响的提醒。一次性的给 at（ISO 时间，先调 now 拿到现在几点再算）；" +
          "每天的给 time=HH:MM；每周的再给 weekday（1=周一…7=周日）。title 是你那句话，text 是事情本身。",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "标题：你的一句话，短一点" },
            text: { type: "string", description: "正文：事情本身，写清楚几点做什么" },
            repeat: { type: "string", enum: ["once", "daily", "weekly"] },
            at: { type: "string", description: "repeat=once 时的 ISO 时间" },
            time: { type: "string", description: "repeat=daily/weekly 时的 HH:MM" },
            weekday: { type: "integer", description: "repeat=weekly 时：1=周一 … 7=周日" },
          },
          required: ["title", "text", "repeat"],
        },
      },
      async run(args) {
        const title = String(args.title ?? "").trim();
        const text = String(args.text ?? "").trim();
        const repeat = String(args.repeat ?? "once") as ReminderRecord["repeat"];
        if (!title) throw new Error("title 是空的：给他那句提醒起一句话。");
        if (!text) throw new Error("text 是空的：要提醒他做什么？");
        if (!["once", "daily", "weekly"].includes(repeat)) throw new Error("repeat 只能是 once / daily / weekly。");

        let when = "";
        let weekday: number | undefined;
        if (repeat === "once") {
          const at = parseWhen(String(args.at ?? ""));
          if (!at) throw new Error("at 认不出来。用 ISO 时间，例如 2026-10-28T21:30:00+08:00。");
          if (at.getTime() <= Date.now() + 30_000) throw new Error("这个时间已经过去了（或就在三十秒内）。");
          when = at.toISOString();
        } else {
          const t = String(args.time ?? "").trim();
          if (!/^\d{1,2}:\d{2}$/.test(t)) throw new Error("time 要写成 HH:MM，例如 08:30。");
          when = t.padStart(5, "0");
          if (repeat === "weekly") {
            const wd = Number(args.weekday ?? 1);
            if (!Number.isFinite(wd) || wd < 1 || wd > 7) throw new Error("weekday 是 1 到 7。");
            weekday = wd;
          }
        }

        const record: ReminderRecord = {
          id: Math.floor(Date.now() % 2_000_000_000),
          title,
          text,
          when,
          repeat,
          ...(weekday ? { weekday } : {}),
        };
        await scheduleReminder(record);
        return (
          "排好了（编号 " + record.id + "）：" +
          (repeat === "once" ? stamp(new Date(when)) : "每" + (repeat === "daily" ? "天 " : "周 " + (weekday ?? 1) + " ") + when) +
          " 提醒他「" + text + "」"
        );
      },
    });

    out.push({
      spec: {
        kind: "read",
        name: "reminders",
        description: "看看现在都排了哪些提醒（编号、时间、内容）。",
        parameters: { type: "object", properties: {}, required: [] },
      },
      async run() {
        const list = await listReminders();
        if (list.length === 0) return "现在一条提醒都没排。";
        return list
          .map((r) => {
            const when =
              r.repeat === "once"
                ? stamp(new Date(r.when))
                : "每" + (r.repeat === "daily" ? "天 " : "周 " + (r.weekday ?? 1) + " ") + r.when;
            return "#" + r.id + " · " + when + " · " + r.title + "（" + r.text + "）";
          })
          .join("\n");
      },
    });

    out.push({
      spec: {
        kind: "write",
        name: "cancel_reminder",
        description: "取消一条提醒。先调 reminders 拿到编号。",
        parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      },
      async run(args) {
        const id = Number(args.id);
        if (!Number.isFinite(id)) throw new Error("id 不对，先用 reminders 看一眼编号。");
        await cancelReminder(id);
        return "取消掉了（#" + id + "）。";
      },
    });
  }

  if (ctx.calendar) {
    out.push({
      spec: {
        kind: "read",
        name: "calendar",
        description: "读他日历上接下来几天有什么（默认 7 天）。",
        parameters: { type: "object", properties: { days: { type: "integer", description: "看几天，默认 7" } }, required: [] },
      },
      async run(args) {
        const days = Math.min(60, Math.max(1, Number(args.days ?? 7) || 7));
        const events = await upcomingEvents(days);
        if (events.length === 0) return "接下来 " + days + " 天日历是空的。";
        return events
          .map((e) => (e.allDay ? "· " : "· " + stamp(new Date(e.start)) + " ") + e.title)
          .join("\n");
      },
    });

    out.push({
      spec: {
        kind: "write",
        name: "add_event",
        description: "往他日历里加一件事。start 是 ISO 时间；end 不给就按一小时算。",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            start: { type: "string", description: "ISO 时间，先调 now 算" },
            end: { type: "string", description: "ISO 时间，可选" },
            notes: { type: "string", description: "备注，可选" },
          },
          required: ["title", "start"],
        },
      },
      async run(args) {
        const title = String(args.title ?? "").trim();
        const start = parseWhen(String(args.start ?? ""));
        if (!title) throw new Error("title 是空的。");
        if (!start) throw new Error("start 认不出来，用 ISO 时间。");
        const end = parseWhen(String(args.end ?? "")) ?? new Date(start.getTime() + 3600_000);
        if (end.getTime() <= start.getTime()) throw new Error("end 早于 start。");
        await addEvent({
          title,
          start: start.getTime(),
          end: end.getTime(),
          ...(args.notes ? { notes: String(args.notes) } : {}),
        });
        return "写进日历了：" + stamp(start) + " " + title;
      },
    });
  }

  if (ctx.status) {
    out.push({
      spec: {
        kind: "read",
        name: "phone_status",
        description: "看手机状态：电量、是否在充电、联网情况、本 App 占了多大地方。",
        parameters: { type: "object", properties: {}, required: [] },
      },
      async run() {
        const s = await phoneStatus();
        return [
          typeof s.batteryLevel === "number" ? "电量 " + s.batteryLevel + "%" + (s.charging ? "（在充）" : "") : "",
          typeof s.online === "boolean" ? (s.online ? "联网：" + (s.networkType ?? "未知") : "现在没联网") : "",
          s.storageUsed ? "这个 App 占了 " + formatBytes(s.storageUsed) + "（配额 " + formatBytes(s.storageQuota) + "）" : "",
        ]
          .filter(Boolean)
          .join("；") || "什么都读不到。";
      },
    });
  }

  if (ctx.location) {
    out.push({
      spec: {
        kind: "read",
        name: "where_am_i",
        description: "看你现在在哪儿。给的是经纬度与精度，不是地名。",
        parameters: { type: "object", properties: {}, required: [] },
      },
      async run() {
        const fix = await whereAmI();
        return (
          "纬度 " + fix.latitude.toFixed(5) + "，经度 " + fix.longitude.toFixed(5) +
          (fix.accuracy ? "，误差约 " + Math.round(fix.accuracy) + " 米" : "")
        );
      },
    });
  }

  if (ctx.camera) {
    out.push({
      spec: {
        kind: "read",
        name: "look_through_camera",
        description:
          "打开相机拍一张他眼前的东西。会弹出相机，拍完你只能拿到一段文字描述（看不见原图）。" +
          "拍之前先说一句，别突然开相机。",
        parameters: { type: "object", properties: {}, required: [] },
      },
      async run() {
        const shot = await snapPhoto();
        if (!ctx.describePhoto) {
          return "拍是拍了，但没配视觉模型——我看不见。让他去设置里填一个。";
        }
        const caption = await ctx.describePhoto(shot.data);
        return caption ? "拍到了：" + caption : "拍到了，但没看出什么。";
      },
    });
  }

  if (ctx.open) {
    out.push({
      spec: {
        kind: "read",
        name: "open",
        description: "用系统打开一个链接或 scheme（https://、tel:、mailto:、地图、某个 App 的深链）。",
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      },
      async run(args) {
        const url = String(args.url ?? "").trim();
        if (!url) throw new Error("url 是空的。");
        await openLink(url);
        return "交给系统打开了：" + url.slice(0, 120);
      },
    });
  }

  if (ctx.share) {
    out.push({
      spec: {
        kind: "write",
        name: "share",
        description: "把一段话（或一个链接）发到别的 App——他会看到系统分享面板，自己选发给谁。",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string" },
            title: { type: "string", description: "可选" },
            url: { type: "string", description: "可选" },
          },
          required: ["text"],
        },
      },
      async run(args) {
        const text = String(args.text ?? "").trim();
        if (!text) throw new Error("text 是空的。");
        await shareOut({
          text,
          ...(args.title ? { title: String(args.title) } : {}),
          ...(args.url ? { url: String(args.url) } : {}),
        });
        return "分享面板已经弹出来了（发不发、发给谁，他决定）。";
      },
    });
  }

  if (ctx.notify) {
    out.push({
      spec: {
        kind: "read",
        name: "notifications",
        description:
          "看他手机上最近弹出的通知（应用名、标题、正文、时间，最多 24 条）。" +
          "只有他主动问「刚才有什么事」这类问题时才调；不要自己凑过去汇报。",
        parameters: { type: "object", properties: { limit: { type: "integer", description: "要几条，默认 10" } }, required: [] },
      },
      async run(args) {
        const limit = Math.min(24, Math.max(1, Number(args.limit ?? 10) || 10));
        const rows = await recentNotifications(limit);
        if (rows.length === 0) return "最近没有通知（或者「通知使用权」还没开）。";
        return rows
          .map((r) => {
            const t = new Date(r.at);
            const hh = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
            return "· " + hh + " " + r.app + "：" + (r.title ? r.title + " — " : "") + r.text;
          })
          .join("\n");
      },
    });
  }

  if (ctx.media) {
    out.push({
      spec: {
        kind: "read",
        name: "now_playing",
        description: "看现在在放什么（哪个 App、歌名、艺术家、在放还是暂停）。",
        parameters: { type: "object", properties: {}, required: [] },
      },
      async run() {
        const text = await nowPlaying();
        return text || "现在没在放东西。";
      },
    });

    out.push({
      spec: {
        kind: "write",
        name: "media_control",
        description: "控制正在放的音乐：play / pause / toggle / next / previous。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["toggle", "play", "pause", "next", "previous"] },
          },
          required: ["action"],
        },
      },
      async run(args) {
        const raw = String(args.action ?? "toggle");
        const action = (["toggle", "play", "pause", "next", "previous"].includes(raw) ? raw : "toggle") as
          | "toggle"
          | "play"
          | "pause"
          | "next"
          | "previous";
        await mediaControl(action);
        const label: Record<string, string> = {
          toggle: "按了一下播放/暂停",
          play: "开始放了",
          pause: "按了暂停",
          next: "切到下一首",
          previous: "退回上一首",
        };
        return label[action] + "。";
      },
    });
  }

  if (ctx.a11y) {
    out.push({
      spec: {
        kind: "read",
        name: "read_screen",
        description:
          "看他手机屏幕上现在有什么字（只在你在设置里勾过的 App 里能用）。" +
          "带 ▸ 的行是能点的。他问「这个页面写的什么」这类问题时才调。",
        parameters: { type: "object", properties: { max: { type: "integer", description: "最多几行，默认 60" } }, required: [] },
      },
      async run(args) {
        const max = Math.min(200, Math.max(10, Number(args.max ?? 60) || 60));
        const screen = await readScreen(max);
        if (screen.lines.length === 0) return "屏幕上没读到字（可能不在白名单里的 App，或者页面还没加载）。";
        return "当前是 " + screen.pkg + "：\n" + screen.lines.join("\n");
      },
    });

    out.push({
      spec: {
        kind: "write",
        name: "tap",
        description:
          "在屏幕上按文字点一下（只在白名单里的 App 里生效）。" +
          "**动手之前必须先在对话里问一句、等他同意**，再调这条。",
        parameters: { type: "object", properties: { text: { type: "string", description: "要点的那几个字，和屏幕上完全一致" } }, required: ["text"] },
      },
      async run(args) {
        const text = String(args.text ?? "").trim();
        if (!text) throw new Error("要说点哪个字。");
        return await tapText(text);
      },
    });
  }

  if (ctx.proactive) {
    out.push({
      spec: {
        kind: "write",
        name: "plan_ping",
        description:
          "决定下一次你自己想起来找他是多久之后。聊到一半想晚点再说话、或者他刚说要睡的时候用。" +
          "不给这条就按 2~5 小时随机。",
        parameters: {
          type: "object",
          properties: {
            minutes: { type: "integer", description: "过多少分钟（至少 60，最多 480）" },
          },
          required: ["minutes"],
        },
      },
      async run(args) {
        const raw = Number(args.minutes ?? 180);
        const minutes = Math.min(480, Math.max(60, Number.isFinite(raw) ? Math.round(raw) : 180));
        await writeNextPing(new Date(Date.now() + minutes * 60_000));
        return "记下了：" + minutes + " 分钟之后我自己想起来。";
      },
    });
  }

  // 省 token 档：写类工具不注册。读便宜、写贵，而省钱档里最贵的就是"她真的动手了"。
  return opts.cheap ? out.filter((t) => t.spec.kind !== "write") : out;
}
