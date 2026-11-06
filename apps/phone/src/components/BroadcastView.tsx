/**
 * 星际和平播报（全屏独立页）。
 *
 * 设计文档：docs/设计-星际和平播报-v1.md。
 * 只认 props：数据/生成/通知都在 broadcast/useBroadcast 与 broadcast/notify 里，
 * 这一层只管把一期画出来 + 设置面板。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import "../styles/broadcast.css";
import {
  BROADCAST_TAG_OPTIONS,
  countLabel,
  dateLabel,
  localDateId,
  type BroadcastDigest,
  type BroadcastIssue,
  type BroadcastItem,
} from "@herta/core";
import { BroadcastReader } from "./BroadcastReader.tsx";
import type { BroadcastConfig } from "../broadcast/storage.ts";
import type { BroadcastStatus } from "../broadcast/useBroadcast.ts";
import {
  broadcastReminderState,
  disableBroadcastReminder,
  enableBroadcastReminder,
} from "../broadcast/notify.ts";

export interface BroadcastViewProps {
  issues: BroadcastIssue[];
  today: BroadcastIssue | null;
  status: BroadcastStatus;
  error: string | null;
  generating: boolean;
  config: BroadcastConfig;
  onClose(): void;
  /** 下拉刷新：重新读一次今天这期（不重新生成）。 */
  onRefresh(): void;
  onRetry(): void;
  onMarkRead(): void;
  onOpenLink(url: string): void;
  onDiscuss(item: BroadcastItem): void;
  /** 点开一条读原文：抓网页 + 压成要点/短稿。失败抛人话。 */
  onReadItem(item: BroadcastItem): Promise<BroadcastDigest>;
  /** 读好的稿子存回这一期，下次点开不再读。 */
  onCacheItem(issueId: string, itemId: string, digest: BroadcastDigest): void | Promise<void>;
  onConfigChange(next: BroadcastConfig): void;
  onClearHistory(): void;
  /** 未接通（没有可用 Key）：今天还没有的时候，只说「接上她才会说话」，不给生成按钮。 */
  unconnected?: boolean;
}

type Permission = "granted" | "denied" | "prompt" | "unsupported";

function SourceMark({ source, domain }: { source: string; domain: string }) {
  const [broken, setBroken] = useState(false);
  const letter = (source || domain || "?").trim().slice(0, 1).toUpperCase();
  if (!domain || broken) {
    return (
      <span className="bcSourceMark bcSourceLetter" aria-hidden="true">
        {letter}
      </span>
    );
  }
  return (
    <img
      className="bcSourceMark"
      src={"https://" + domain + "/favicon.ico"}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

/** 桌面信息流里那张「站点封面」：没图就用站点首字压一个色块。 */
function SiteCover({ source }: { source: string }) {
  const letter = (source || "?").trim().slice(0, 1);
  return (
    <div className="bcCover" aria-hidden="true">
      <span>{letter}</span>
    </div>
  );
}

function FlowPost(props: {
  item: BroadcastItem;
  index: number;
  when: string;
  onOpen(item: BroadcastItem): void;
  onOpenLink(url: string): void;
  onDiscuss(item: BroadcastItem): void;
}) {
  const { item } = props;
  return (
    <article
      className={"bcPost bcTappable" + (item.egg ? " bcEgg" : "")}
      onClick={() => props.onOpen(item)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onOpen(item);
        }
      }}
    >
      <div className="bcPostBody">
        <div className="bcPostMeta">
          <SourceMark source={item.source} domain={item.domain} />
          <span className="bcSource">{item.source}</span>
          <span className="bcMeta">· {props.when}</span>
          {item.egg && <span className="bcEggBadge">本台虚构</span>}
          <span className="bcRowNum" aria-hidden="true">
            {String(props.index + 1).padStart(2, "0")}
          </span>
        </div>
        <h2 className="bcHeadline">{item.title}</h2>
        <p className="bcSummary">{item.summary}</p>
        {item.why && <span className="bcWhy">{item.why}</span>}
        <div className="bcWord">
          <b>黑塔</b>
          {item.comment}
        </div>
        {!item.egg && (
          <div className="bcActions">
            <button
              type="button"
              className="bcAction"
              onClick={(e) => {
                e.stopPropagation();
                props.onOpenLink(item.url);
              }}
            >
              查看原文 ↗
            </button>
            <button
              type="button"
              className="bcAction"
              onClick={(e) => {
                e.stopPropagation();
                props.onDiscuss(item);
              }}
            >
              引用到对话
            </button>
          </div>
        )}
      </div>
      <SiteCover source={item.source} />
    </article>
  );
}

function IssueBody(props: {
  issue: BroadcastIssue;
  isToday: boolean;
  onOpen(item: BroadcastItem): void;
  onOpenLink(url: string): void;
  onDiscuss(item: BroadcastItem): void;
}) {
  const { issue, isToday } = props;
  const when = isToday ? "今天" : dateLabel(issue.date);
  return (
    <section className={"bcIssue" + (isToday ? " bcToday" : "")}>
      <header className="bcMasthead">
        <p className="bcMast">星际和平播报 · 空间站「黑塔」转播</p>
        <div className="bcMastMeta">
          <span className="bcMastNo">第 {issue.no} 期</span>
          <span>{dateLabel(issue.date)}</span>
          {isToday && <span className="bcToday">今日已生成</span>}
        </div>
      </header>

      {issue.items.length === 0 && <p className="bcThin">这一期没有新的内容。</p>}

      {issue.items.map((item, i) => (
        <FlowPost
          key={item.id}
          item={item}
          index={i}
          when={when}
          onOpen={props.onOpen}
          onOpenLink={props.onOpenLink}
          onDiscuss={props.onDiscuss}
        />
      ))}

      {issue.items.length > 0 && <p className="bcEnd">以上为本期全部内容，下一期将于明日更新。</p>}
    </section>
  );
}

export function BroadcastView(props: BroadcastViewProps) {
  const { issues, today, status, error, generating, config, onClose, onRefresh, onRetry, onMarkRead, onOpenLink, onDiscuss, onConfigChange, onClearHistory, unconnected } = props;
  /** 下拉刷新：手指在顶部往下拉超过阈值就刷新（另有可点按钮兜底）。 */
  const [pull, setPull] = useState(0);
  const pullStart = useRef<{ y: number; top: number } | null>(null);
  const [permission, setPermission] = useState<Permission>("prompt");
  const [reminderNote, setReminderNote] = useState<string | null>(null);
  const [clearArmed, setClearArmed] = useState(false);
  /** 点开的那一条（读原文的独立阅读页）；null = 没在读。 */
  const [reading, setReading] = useState<{ issue: BroadcastIssue; item: BroadcastItem } | null>(null);
  const [digest, setDigest] = useState<BroadcastDigest | null>(null);
  const [readBusy, setReadBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const runRead = async (issue: BroadcastIssue, item: BroadcastItem) => {
    setReadBusy(true);
    setReadError(null);
    try {
      const next = await props.onReadItem(item);
      setDigest(next);
      await props.onCacheItem(issue.id, item.id, next);
    } catch (readFailure) {
      setReadError(readFailure instanceof Error ? readFailure.message : String(readFailure));
    } finally {
      setReadBusy(false);
    }
  };

  const openItem = (issue: BroadcastIssue, item: BroadcastItem) => {
    setReading({ issue, item });
    setReadError(null);
    // 彩蛋没有原文：点开只看摘要，不去抓
    if (item.egg || !item.url) {
      setDigest(null);
      setReadBusy(false);
      return;
    }
    // 读过一次就存回来，再点开不再花一次模型调用
    if (item.detail) {
      setDigest({ points: item.points ?? [], detail: item.detail });
      setReadBusy(false);
      return;
    }
    setDigest(null);
    void runRead(issue, item);
  };

  useEffect(() => {
    void broadcastReminderState()
      .then((state) => setPermission(state.permission))
      .catch(() => setPermission("unsupported"));
  }, []);

  useEffect(() => {
    if (today) onMarkRead();
  }, [today?.id, onMarkRead]);

  useEffect(() => {
    setClearArmed(false);
  }, [issues.length]);

  const past = useMemo(() => issues.filter((issue) => issue.id !== today?.id), [issues, today]);
  const reminderOn = config.notify && permission === "granted";

  const toggleTag = (tag: string) => {
    const has = config.tags.includes(tag);
    const next = has ? config.tags.filter((item) => item !== tag) : [...config.tags, tag];
    if (next.length === 0) return;
    onConfigChange({ ...config, tags: next });
  };

  const toggleReminder = async () => {
    setReminderNote(null);
    if (reminderOn) {
      await disableBroadcastReminder();
      onConfigChange({ ...config, notify: false });
      return;
    }
    const state = await enableBroadcastReminder();
    setPermission(state.permission);
    if (state.enabled) {
      onConfigChange({ ...config, notify: true });
      return;
    }
    setReminderNote(state.permission === "denied" ? "系统通知权限被拒了，去系统设置里开一下。" : "没拿到通知权限，先在系统里允许通知。");
  };

  const renderState = () => {
    // 未接通：今天还没有这一期时，别转圈、别让她「正在翻新闻」，明说接上才会有。
    if (unconnected) {
      return (
        <div className="bcState">
          <p className="bcStateTitle">今天还没有；接上她才会说话</p>
          <p className="bcStateHint">在主界面点「她还没接上」填上 Key，她明天早上就会自己写一期。</p>
        </div>
      );
    }
    if (status === "loading" || generating) {
      return (
        <div className="bcState" role="status">
          <span className="bcSpinner" aria-hidden="true" />
          <p className="bcStateTitle">她正在翻今天的新闻…</p>
          <p className="bcStateHint">挑 3–7 条、每条写一句评，大概十几秒。</p>
        </div>
      );
    }
    if (status === "failed") {
      return (
        <div className="bcState bcStateFail" role="alert">
          <p className="bcStateTitle">今天这期还没出来。</p>
          {error && <p className="bcStateErr">{error}</p>}
          <button type="button" className="bcRetry" onClick={onRetry} disabled={generating}>
            重试
          </button>
        </div>
      );
    }
    if (status === "before") {
      return (
        <div className="bcState">
          <p className="bcStateTitle">今天的播报 08:00 后才出。</p>
          <p className="bcStateHint">到点后打开 app，她会自己写；写好会在这里和聊天里各出现一次。</p>
          <button type="button" className="bcRetry" onClick={onRetry} disabled={generating}>
            现在就来一期
          </button>
        </div>
      );
    }
    return (
      <div className="bcState" data-part="empty-state">
        <p className="bcStateTitle">还没有播报。</p>
        <p className="bcStateHint">现在做一期，还是等明天早上她自己写？</p>
        <button type="button" className="bcRetry" onClick={onRetry} disabled={generating}>
          来一期
        </button>
      </div>
    );
  };

  const renderSettings = () => (
    <section className="bcSettings" aria-label="播报设置">
      <h2>播报设置</h2>
      <p className="bcSettingsHint">关注标签决定下一次抓什么；改动从下一期开始生效。</p>
      <div className="bcTags">
        {BROADCAST_TAG_OPTIONS.map((tag) => {
          const on = config.tags.includes(tag);
          return (
            <label key={tag} className={"bcTagChoice" + (on ? " on" : "")}>
              <input type="checkbox" checked={on} onChange={() => toggleTag(tag)} />
              {tag}
            </label>
          );
        })}
      </div>
      <div className="bcSettingRow">
        <div>
          <b>每天提醒</b>
          <span>{reminderOn ? "每天 " + config.notifyTime : "已关闭"}</span>
        </div>
        <button
          type="button"
          className={"bcSwitch" + (reminderOn ? " on" : "")}
          onClick={() => void toggleReminder()}
          aria-pressed={reminderOn}
          aria-label="播报提醒开关"
        >
          <span />
        </button>
      </div>
      <label className="bcTimeRow">
        提醒时间
        <input
          type="time"
          value={config.notifyTime}
          onChange={(e) => {
            const value = e.target.value;
            if (/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) onConfigChange({ ...config, notifyTime: value });
          }}
        />
      </label>
      {reminderNote && <p className="bcNote">{reminderNote}</p>}
      {permission === "unsupported" && (
        <p className="bcNote">浏览器里没有系统通知；装成 APK 后才会响。</p>
      )}
      <button
        type="button"
        className={"bcClear" + (clearArmed ? " armed" : "")}
        onClick={() => {
          if (!clearArmed) {
            setClearArmed(true);
            return;
          }
          onClearHistory();
          setClearArmed(false);
        }}
      >
        {clearArmed ? "再点一次，确认清空" : "清空播报历史"}
      </button>
    </section>
  );

  return (
    <div className="broadcastView" data-part="panel" role="dialog" aria-label="星际和平播报">
      <header className="bcHead">
        <button type="button" className="bcBack" onClick={onClose} aria-label="返回聊天">
          ←
        </button>
        <span className="bcHeadTitle">星际和平播报</span>
        <button type="button" className="bcGear" onClick={onRefresh} aria-label="刷新播报" title="刷新">
          ⟳
        </button>
      </header>

      <div
        className="bcScroll"
        onTouchStart={(e) => {
          const el = e.currentTarget;
          pullStart.current = el.scrollTop <= 0 ? { y: e.touches[0].clientY, top: el.scrollTop } : null;
        }}
        onTouchMove={(e) => {
          const start = pullStart.current;
          if (!start) return;
          const dy = e.touches[0].clientY - start.y;
          setPull(dy > 0 ? Math.min(dy, 90) : 0);
        }}
        onTouchEnd={() => {
          const reached = pull >= 64;
          setPull(0);
          pullStart.current = null;
          if (reached) onRefresh();
        }}
      >
        <div
          className={"bcPull" + (pull > 0 ? " on" : "")}
          aria-hidden="true"
          style={{ height: pull > 0 ? 24 : 0, overflow: "hidden", textAlign: "center", fontSize: 11, color: "var(--muted)", lineHeight: "24px" }}
        >
          {pull >= 64 ? "松手刷新" : "下拉刷新"}
        </div>
        {renderSettings()}
        {today && status === "ready" ? (
          <IssueBody
            issue={today}
            isToday
            onOpen={(item) => openItem(today, item)}
            onOpenLink={onOpenLink}
            onDiscuss={onDiscuss}
          />
        ) : (
          renderState()
        )}

        {past.length > 0 && (
          <section className="bcPast" aria-label="往期">
            <h2 className="bcPastTitle">往期</h2>
            {past.map((issue) => (
              <details key={issue.id} className="bcPastIssue">
                <summary>
                  <span>第 {issue.no} 期</span>
                  <span>{dateLabel(issue.date)}</span>
                  <span>{countLabel(issue.items)}</span>
                </summary>
                <IssueBody
                  issue={issue}
                  isToday={false}
                  onOpen={(item) => openItem(issue, item)}
                  onOpenLink={onOpenLink}
                  onDiscuss={onDiscuss}
                />
              </details>
            ))}
          </section>
        )}

        <p className="bcFoot">内容来自公开新闻搜索 · 她的评是模型写的 · {localDateId()}</p>
      </div>

      {reading && (
        <BroadcastReader
          item={{
            ...reading.item,
            ...(digest ? { points: digest.points, detail: digest.detail } : {}),
          }}
          dateText={(reading.issue.id === localDateId() ? "今天 " : "") + dateLabel(reading.issue.date)}
          digest={digest}
          loading={readBusy}
          error={readError}
          onRetry={() => void runRead(reading.issue, reading.item)}
          onClose={() => {
            setReading(null);
            setDigest(null);
            setReadError(null);
          }}
          onOpenLink={onOpenLink}
          onDiscuss={onDiscuss}
        />
      )}
    </div>
  );
}