import { useCallback, useEffect, useState } from "react";
import { clearToolLog, listToolLog, type ToolLogEntry } from "../storage.ts";
import "../styles/settings-suite.css";

type Filter = "all" | "ok" | "fail";

const ICON = {
  back: "M15 6l-6 6 6 6",
  close: "M6 6l12 12M18 6L6 18",
} as const;

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

/**
 * 工具调用记录。
 *
 * 为什么单独一页：聊天里那些「（看了时间：…）」是给她的上下文，不是给你查账的——
 * 夹在下一条消息里就滚过去了。她说"我查过"的时候，你要能回来核对她查了什么、
 * 参数对不对、失败在哪一步。
 *
 * 只留最近两百条，存在本机，和别的本地数据一样。
 */
export function ToolLogSheet({ onClose }: { onClose(): void }) {
  const [rows, setRows] = useState<ToolLogEntry[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    setRows(await listToolLog());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const wipe = async () => {
    setBusy(true);
    await clearToolLog();
    await load();
    setBusy(false);
  };

  const failCount = rows.filter((r) => !r.ok).length;
  const shown = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => (filter === "all" ? true : filter === "ok" ? r.ok : !r.ok));

  const filters: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "全部", count: rows.length },
    { key: "ok", label: "成功", count: rows.length - failCount },
    { key: "fail", label: "拒绝", count: failCount },
  ];

  return (
    <div className="ss-page" data-part="panel" role="dialog" aria-label="工具调用记录">
      <header className="ss-top">
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="返回">
          <Icon d={ICON.back} size={18} />
        </button>
        <div className="ss-title">
          <b>工具调用记录</b>
          <span>只留最近两百条 · 存在本机</span>
        </div>
        <span className="ss-badge">
          <i />
          {rows.length} 条
        </span>
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="关闭">
          <Icon d={ICON.close} size={16} />
        </button>
      </header>

      <div className="ss-body">
        <section className="ss-card ss-cardPad">
          <div className="ss-cardHead">
            <div>
              <div className="ss-kicker">TOOL LOG · 她动过什么手</div>
              <div className="tl-count">
                共 <b>{rows.length}</b> 条调用 · {failCount} 条被拒绝
              </div>
            </div>
            <button
              type="button"
              className="ss-btn ss-btnGhost ss-btnSmall"
              onClick={() => void wipe()}
              disabled={busy || rows.length === 0}
            >
              {busy ? "清着…" : "全清掉"}
            </button>
          </div>
          <div className="tl-filters">
            {filters.map((f) => (
              <button
                key={f.key}
                type="button"
                className={filter === f.key ? "on" : ""}
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
              >
                {f.label} {f.count}
              </button>
            ))}
          </div>
        </section>

        <p className="ss-hint">
          她自己动手的每一次都记在这里：叫什么、带了什么参数、成没成、返回了什么；你放进来的文件（文件库）也记一条，聊天页不显示这些旁白。
        </p>

        <section className="ss-card tl-listCard">
          {rows.length === 0 ? (
            <p className="tl-empty">还没有记录。她调一次工具，这里就多一行。</p>
          ) : shown.length === 0 ? (
            <p className="tl-empty">这个筛选下没有记录。</p>
          ) : (
            <div className="tl-list">
              {shown.map(({ r, i }) => {
                const key = r.at + ":" + i;
                const time = new Date(r.at);
                const hh =
                  String(time.getHours()).padStart(2, "0") + ":" + String(time.getMinutes()).padStart(2, "0");
                const expanded = open === key;
                return (
                  <button
                    key={key}
                    type="button"
                    className={"tl-row" + (r.ok ? "" : " bad")}
                    onClick={() => setOpen(expanded ? null : key)}
                    aria-expanded={expanded}
                  >
                    <span className="tl-time">{hh}</span>
                    <span className="tl-rail">
                      <i className="tl-dot" />
                    </span>
                    <span className="tl-main">
                      <span className="tl-head">
                        <b>{r.label || r.name}</b>
                        <em>{r.name}</em>
                      </span>
                      <span className={"tl-body" + (expanded ? " full" : "")}>{r.content}</span>
                      {expanded && r.args && r.args !== "{}" && <span className="tl-args">参数：{r.args}</span>}
                    </span>
                    <span className={"tl-state" + (r.ok ? "" : " bad")}>{r.ok ? "成功" : "拒绝"}</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <p className="ss-hint">工具旁白不刷聊天页，只记在这里；聊天里只留一行灰字。</p>
      </div>
    </div>
  );
}
