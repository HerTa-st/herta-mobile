import type { MemoryHit, MemoryRecord, SessionHit } from "@herta/core";
import "../styles/sessions.css";
import { formatPct } from "@herta/coin";
import { useEffect, useRef, useState } from "react";
import type { SessionMeta } from "../storage.ts";

/**
 * 抽屉：会话、导入。
 *
 * 记忆只剩一个入口（「最近记忆」→ 记忆页）：做梦、整理、删记忆都在记忆页里，
 * 这里不再重复第二份。
 * 会话长按出菜单（重命名 / 置顶 / 多选删除）；旁边的 ⋯ 是同一个菜单的可点入口——
 * 读屏和手套用户到不了长按，所以长按的每件事都得有一条点得到的路。
 */
export interface DrawerActions {
  newSession(): void;
  openSession(id: string): void;
  removeSession(id: string): void;
  renameSession(id: string, title: string): void;
  togglePin(id: string): void;
  removeSessions(ids: string[]): void;
  jump(sessionId: string, index: number): void;
  /** 打开某条记忆的详情（搜索结果用）。 */
  openMemory(record: MemoryRecord): void;
  /** 打开记忆页（最近记忆的入口）。 */
  openMemoryPage(): void;
  toggleImport(): void;
  setImportText(v: string): void;
  setShareInput(v: string): void;
  readImportFile(text: string, name: string): void;
  runImport(): void;
  importFromLink(): void;
  /** 打开黑塔币行情页。 */
  openCoin(): void;
  /** 打开星际和平播报（独立全屏页）。 */
  openBroadcast(): void;
}

export interface DrawerProps {
  sessions: SessionMeta[];
  /** 置顶会话 id（顺序表）。 */
  pinned: string[];
  currentId: string | null;
  filter: string;
  onFilter(v: string): void;
  memHits: MemoryHit[];
  sessHits: SessionHit[];
  memories: MemoryRecord[];
  showImport: boolean;
  importText: string;
  importNote: string | null;
  importBusy: boolean;
  shareInput: string;
  nowLine: string;
  /** 黑塔币最近一次行情的涨跌幅（有缓存才显示）。 */
  coinPct: number | null;
  /** 今天这期的期号；还没有就是 null。 */
  broadcastNo: number | null;
  /** 今天这期还没读：入口右侧亮一个点。 */
  broadcastUnread: boolean;
  /** 她找过我：这些会话里有她主动说的话还没看（打开即消）。 */
  sought: string[];
  actions: DrawerActions;
}

const LONG_PRESS_MS = 450;

export function Drawer(props: DrawerProps) {
  const { actions } = props;
  const sought = new Set(props.sought);
  /** 打开菜单的会话 id；null = 没开。 */
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  /** 多选模式与选中集合。 */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const timer = useRef<number | null>(null);
  /** 长按已经弹出菜单时，随后的 click 不该再把菜单关掉。 */
  const longPressed = useRef(false);

  useEffect(() => {
    // 换会话 / 关抽屉时把半截状态收干净
    setMenuId(null);
    setRenaming(false);
    setSelecting(false);
    setSelected([]);
  }, [props.currentId]);

  useEffect(() => {
    if (menuId && !props.sessions.some((s) => s.id === menuId)) setMenuId(null);
  }, [menuId, props.sessions]);

  function clearTimer() {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }

  function startLongPress(id: string) {
    clearTimer();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      longPressed.current = true;
      setMenuId(id);
      setRenaming(false);
    }, LONG_PRESS_MS);
  }

  function openMenu(id: string) {
    clearTimer();
    setMenuId((current) => (current === id ? null : id));
    setRenaming(false);
  }

  function startRename(session: SessionMeta) {
    setRenaming(true);
    setDraftTitle(session.title);
  }

  function commitRename(session: SessionMeta) {
    const next = draftTitle.trim();
    if (next && next !== session.title) actions.renameSession(session.id, next);
    setRenaming(false);
  }

  function toggleSelected(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  }

  /** 置顶的排前面，其余按最近更新。 */
  const ordered = [...props.sessions].sort((a, b) => {
    const ai = props.pinned.indexOf(a.id);
    const bi = props.pinned.indexOf(b.id);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });

  return (
    <div className="drawer" data-part="panel" aria-label="抽屉">
      <button className="new" onClick={actions.newSession}>
        ＋ 新的对话
      </button>
      <button className="coinEntry" onClick={actions.openCoin}>
        <span className="coinEntryName">黑塔币 HTC</span>
        {props.coinPct != null && (
          <span
            className={
              "coinEntryPct" + (props.coinPct > 0.0001 ? " up" : props.coinPct < -0.0001 ? " down" : "")
            }
          >
            {formatPct(props.coinPct)}
          </span>
        )}
      </button>
      <button className="broadcastEntry" onClick={actions.openBroadcast}>
        <span className="broadcastEntryName">星际和平播报</span>
        {props.broadcastNo != null && <span className="broadcastEntryNo">第 {props.broadcastNo} 期</span>}
        {props.broadcastUnread && <span className="broadcastEntryDot" aria-label="有新一期" />}
      </button>
      <p className="nowLine">{props.nowLine}</p>

      <input className="filter" value={props.filter} onChange={(e) => props.onFilter(e.target.value)} placeholder="搜记忆和对话…" />

      {props.filter.trim() ? (
        <div className="results">
          <p className="rsum">
            {props.filter.trim()} · 记忆 {props.memHits.length} · 对话 {props.sessHits.length}
          </p>
          {props.memHits.map((h) => {
            const rec = props.memories.find((m) => m.name === h.name);
            return (
              <button key={"m" + h.name} className="rhit" onClick={() => rec && actions.openMemory(rec)}>
                <span className="rt">{h.title}</span>
                <span className="rs">{h.snippet}</span>
              </button>
            );
          })}
          {props.sessHits.map((h) =>
            (h.hits.length > 0 ? h.hits : [{ index: 0, snippet: "标题命中" }]).map((hit, k) => (
              <button key={"s" + h.sessionId + k} className="rhit" onClick={() => actions.jump(h.sessionId, hit.index)}>
                <span className="rt">
                  {h.title}
                  <em>第 {hit.index + 1} 块</em>
                </span>
                <span className="rs">{hit.snippet}</span>
              </button>
            ))
          )}
          {props.memHits.length === 0 && props.sessHits.length === 0 && <p className="rsum">没找到。</p>}
        </div>
      ) : (
        <>
          <ul className={selecting ? "sessions selecting" : "sessions"}>
            {ordered.map((s) => {
              const pinned = props.pinned.includes(s.id);
              const isMenu = menuId === s.id;
              const isSelected = selected.includes(s.id);
              return (
                <li key={s.id} className={(s.id === props.currentId ? "on " : "") + (isMenu ? "menuOpen " : "") + (isSelected ? "picked" : "")}>
                  {selecting && (
                    <input
                      type="checkbox"
                      className="pick"
                      style={{ width: 14, height: 14, margin: "0 2px 0 6px", flex: "none" }}
                      checked={isSelected}
                      onChange={() => toggleSelected(s.id)}
                      aria-label={"选中「" + s.title + "」"}
                    />
                  )}
                  <button
                    className="row"
                    onClick={() => {
                      if (longPressed.current) {
                        // 这次是长按收尾，别当点击处理
                        longPressed.current = false;
                        return;
                      }
                      if (selecting) {
                        toggleSelected(s.id);
                        return;
                      }
                      if (isMenu) {
                        setMenuId(null);
                        return;
                      }
                      actions.openSession(s.id);
                    }}
                    onPointerDown={() => startLongPress(s.id)}
                    onPointerUp={clearTimer}
                    onPointerLeave={clearTimer}
                    onPointerCancel={clearTimer}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openMenu(s.id);
                    }}
                    aria-haspopup="menu"
                    aria-expanded={isMenu}
                  >
                    <span className="st">
                      {pinned && <span className="pin" aria-label="已置顶" style={{ color: "var(--accent)" }}>◇ </span>}
                      {s.title}
                    </span>
                    {sought.has(s.id) && (
                      <span
                        role="img"
                        aria-label="她找过你"
                        style={{ flex: "none", width: 7, height: 7, borderRadius: "50%", background: "#d96a7a" }}
                      />
                    )}
                    <span className="sm">{s.origin === "import" ? "导入" : s.blocks + " 块"}</span>
                  </button>
                  {!selecting && (
                    <button
                      className="del"
                      onClick={() => openMenu(s.id)}
                      aria-label={"会话菜单：" + s.title}
                      title="更多"
                    >
                      ⋯
                    </button>
                    )}

                  {isMenu && (
                    <div className="sessionMenu" role="menu" style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "4px 8px 6px 26px" }} aria-label={"「" + s.title + "」的操作"}>
                      {renaming ? (
                        <div className="renameRow" style={{ display: "flex", gap: 6, width: "100%" }}>
                          <input
                            className="renameInput"
                            style={{ flex: 1, minWidth: 0, fontSize: 11 }}
                            value={draftTitle}
                            autoFocus
                            onChange={(e) => setDraftTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename(s);
                              if (e.key === "Escape") setRenaming(false);
                            }}
                            aria-label="新标题"
                          />
                          <button type="button" onClick={() => commitRename(s)}>存</button>
                          <button type="button" onClick={() => setRenaming(false)}>取消</button>
                        </div>
                      ) : (
                        <>
                          <button type="button" role="menuitem" onClick={() => startRename(s)}>
                            重命名
                          </button>
                          <button type="button" role="menuitem" onClick={() => { actions.togglePin(s.id); setMenuId(null); }}>
                            {pinned ? "取消置顶" : "置顶"}
                          </button>
                          <button type="button" role="menuitem" onClick={() => { setSelecting(true); setSelected([s.id]); setMenuId(null); }}>
                            多选删除…
                          </button>
                          <button type="button" role="menuitem" className="danger" onClick={() => { actions.removeSession(s.id); setMenuId(null); }}>
                            删除这条
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
            {props.sessions.length === 0 && <li className="none">还没有别的对话</li>}
          </ul>

          {selecting && (
            <div className="multiBar" role="toolbar" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", fontSize: 11, color: "var(--muted)" }} aria-label="多选删除">
              <span>已选 {selected.length}</span>
              <button type="button" className="danger" disabled={selected.length === 0} onClick={() => { actions.removeSessions(selected); setSelecting(false); setSelected([]); }}>
                删除选中
              </button>
              <button type="button" onClick={() => { setSelecting(false); setSelected([]); }}>取消</button>
            </div>
          )}
        </>
      )}

      <div className="mem">
        <div className="memHead">
          <span>记忆 {props.memories.filter((m) => !m.forgotten).length} 篇</span>
        </div>
        <button className="dream" onClick={actions.openMemoryPage}>
          最近记忆 · 删除 / 整理 / 做梦都在那边 →
        </button>
      </div>

      <div className="imp">
        <button className="impToggle" onClick={actions.toggleImport}>
          {props.showImport ? "收起导入" : "导入 DeepSeek 对话"}
        </button>
        {props.showImport && (
          <>
            <p className="impHelp">
              最省事的是**分享链接**：在 DeepSeek 里打开那条对话 → 分享 → 创建链接 → 把链接贴到下面。
              接口是公开的，不需要登录，链接用完可以在 DeepSeek 里删掉。
            </p>
            <div className="shareRow">
              <input
                value={props.shareInput}
                onChange={(e) => actions.setShareInput(e.target.value)}
                placeholder="https://chat.deepseek.com/share/…"
              />
              <button onClick={actions.importFromLink} disabled={props.importBusy || !props.shareInput.trim()}>
                {props.importBusy ? "取…" : "取"}
              </button>
            </div>
            <p className="impHelp">也可以用油猴脚本导出 JSON，把内容贴进来（或选文件）。</p>
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void file.text().then((t) => actions.readImportFile(t, file.name));
              }}
            />
            <textarea
              className="impBox"
              value={props.importText}
              onChange={(e) => actions.setImportText(e.target.value)}
              placeholder='{"format":"herta-import","version":1,...}'
              rows={4}
            />
            <button className="impGo" onClick={actions.runImport} disabled={!props.importText.trim()}>
              导进来
            </button>
            {props.importNote && <p className="impNote">{props.importNote}</p>}
          </>
        )}
      </div>
    </div>
  );
}