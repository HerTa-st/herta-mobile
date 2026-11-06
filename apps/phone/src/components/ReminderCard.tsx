/**
 * 提醒卡片。
 *
 * 提醒到点时会以「她说话」的形式写进对话（见 App 的 flushReminders），
 * 但那是**提醒**，不是对话——所以这里用一张独立卡片渲染：
 * 琥珀色边框 + 标题 + 正文 + 时间，和左右两侧的对话气泡区分开。
 *
 * 认领方式有两条：
 *   1. 本机提醒记录 title + "\n" + text 与消息正文完全一致（最可靠）；
 *   2. 老数据/记录被删时，退化成保守的格式识别：短标题 + 第二行以 HH:MM 开头。
 */
import type { ReminderRecord } from "../capabilities.ts";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

/** 提醒卡片头部的重复规则文案。 */
export function reminderMeta(record: ReminderRecord): string {
  if (record.repeat === "daily") return "每天 " + record.when;
  if (record.repeat === "weekly") {
    return "每周" + (WEEK[(record.weekday ?? 1) - 1] ?? "一") + " " + record.when;
  }
  const d = new Date(record.when);
  if (!Number.isNaN(d.getTime())) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return d.getMonth() + 1 + "月" + d.getDate() + "日 " + hh + ":" + mm;
  }
  return String(record.when);
}

/** 消息块 at → 卡片右上角的时间（HH:MM）。 */
export function reminderTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

/**
 * 老数据兜底：把「很短的标题 + 换行 + 以时间开头的正文」认成提醒。
 * 故意保守：标题 ≤12 字、不带句末标点，正文必须以 8:30 / 22:00 这种时间开头。
 */
export function parseReminderLike(text: string): { title: string; text: string } | null {
  const m = /^([^\n]{1,12})\n([^\n].*)$/.exec(text);
  if (!m) return null;
  const title = m[1].trim();
  const body = m[2].trim();
  if (!title || !body) return null;
  if (/[，。！？；：、,.!?;:]$/.test(title)) return null;
  if (!/^\d{1,2}[:：]\d{2}/.test(body)) return null;
  return { title: title, text: body };
}

export interface ReminderCardProps {
  index: number;
  title: string;
  text: string;
  at: string;
  meta?: string;
}

export function ReminderCard({ index, title, text, at, meta }: ReminderCardProps) {
  return (
    <article className="reminderCard" data-idx={index} data-part="message-card" aria-label="提醒">
      <div className="reminderCardHead">
        <span className="reminderCardBadge">⏰ 提醒</span>
        {meta && <span className="reminderCardMeta">{meta}</span>}
        <span className="reminderCardTime">{reminderTime(at)}</span>
      </div>
      <p className="reminderCardTitle">{title}</p>
      <p className="reminderCardText">{text}</p>
    </article>
  );
}
