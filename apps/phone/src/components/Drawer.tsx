import type { DreamState, MemoryHit, MemoryRecord, SessionHit } from "@herta/core";
import "../styles/sessions.css";
import { effectiveWeight, memoryTitle } from "@herta/core";
import { formatPct } from "@herta/coin";
import type { SessionMeta } from "../storage.ts";

/**
 * 抽屉：会话、记忆、导入。
 *
 * 从 App.tsx 里整块搬出来的——那块 JSX 原本占了一百六十多行，
 * 和聊天流程混在一个组件里，改一次导入要翻半篇。
 * 现在它只认 props，不碰任何状态管理。
 */
export interface DrawerActions {
  newSession(): void;
  openSession(id: string): void;
  removeSession(id: string): void;
  jump(sessionId: string, index: number): void;
  openMemory(record: MemoryRecord): void;
  removeMemory(name: string): void;
  showGraph(): void;
  dream(): void;
  distill(): void;
  toggleImport(): void;
  setImportText(v: string): void;
  setShareInput(v: string): void;
  readImportFile(text: string, name: string): void;
  runImport(): void;
  importFromLink(): void;
  /** 打开黑塔币行情页（聊天之外的小模块，v1 只在抽屉里有入口）。 */
  openCoin(): void;
  /** 打开星际和平播报（独立全屏页）。 */
  openBroadcast(): void;
}

export interface DrawerProps {
  sessions: SessionMeta[];
  currentId: string | null;
  filter: string;
  onFilter(v: string): void;
  memHits: MemoryHit[];
  sessHits: SessionHit[];
  memories: MemoryRecord[];
  dreamState: DreamState | null;
  /** 自动语气（NMS）；有它就不显示旧的冻结语气。 */
  voice?: { profile: string; version: number } | null;
  maintaining: string | null;
  dreaming: boolean;
  distilling: boolean;
  distillNote: string | null;
  showImport: boolean;
  importText: string;
  importNote: string | null;
  importBusy: boolean;
  shareInput: string;
  nowLine: string;
  canDistill: boolean;
  /** 黑塔币最近一次行情的涨跌幅（有缓存才显示，没打开过就是 null）。 */
  coinPct: number | null;
  /** 今天这期的期号；还没有就是 null。 */
  broadcastNo: number | null;
  /** 今天这期还没读：入口右侧亮一个点。 */
  broadcastUnread: boolean;
  actions: DrawerActions;
}

export function Drawer(props: DrawerProps) {
  const { actions } = props;

  return (
    <div className="drawer">
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
        <ul>
          {props.sessions.map((s) => (
            <li key={s.id} className={s.id === props.currentId ? "on" : ""}>
              <button className="row" onClick={() => actions.openSession(s.id)}>
                <span className="st">{s.title}</span>
                <span className="sm">{s.origin === "import" ? "导入" : s.blocks + " 块"}</span>
              </button>
              <button className="del" onClick={() => actions.removeSession(s.id)} aria-label="删除">
                ✕
              </button>
            </li>
          ))}
          {props.sessions.length === 0 && <li className="none">还没有别的对话</li>}
        </ul>
      )}

      <div className="mem">
        <div className="memHead">
          <span>记忆 {props.memories.filter((m) => !m.forgotten).length} 篇</span>
          {props.dreamState?.forgottenTotal ? <span className="sm">已忘 {props.dreamState.forgottenTotal}</span> : null}
          <button className="mgraph" onClick={actions.showGraph} disabled={props.memories.length === 0}>
            记忆网络
          </button>
        </div>
        {props.maintaining && <p className="memNote">{props.maintaining}</p>}
        {props.dreamState?.lastNote && <p className="memNote">{props.dreamState.lastNote}</p>}

        <button className="dream" onClick={actions.dream} disabled={props.dreaming || props.distilling}>
          {props.dreaming ? "她正在想…" : "让她做梦"}
        </button>
        <button className="dream" onClick={actions.distill} disabled={props.dreaming || props.distilling || !props.canDistill}>
          {props.distilling ? "正在整理这段对话…" : "把这段对话整理成记忆"}
        </button>
        {props.distillNote && <p className="memNote">{props.distillNote}</p>}

        <ul className="memList">
          {[...props.memories]
            .filter((m) => !m.forgotten)
            .reverse()
            .map((m) => (
              <li key={m.name}>
                <span className="mw">{effectiveWeight(m, Date.now()).toFixed(2)}</span>
                <button className="mt" onClick={() => actions.openMemory(m)} title={memoryTitle(m)}>
                  {memoryTitle(m)}
                </button>
                {(m.links?.length ?? 0) > 0 && <span className="ml">↔{m.links?.length}</span>}
                <button className="mx" onClick={() => actions.removeMemory(m.name)} aria-label="删掉这条记忆">
                  ✕
                </button>
              </li>
            ))}
          {props.memories.length === 0 && <li className="none">记忆库是空的</li>}
        </ul>

        {props.voice ? (
          <details className="voice">
            <summary>她写字的样子（v{props.voice.version}，她自己写的）</summary>
            <p>{props.voice.profile}</p>
          </details>
        ) : props.dreamState?.voice ? (
          <details className="voice">
            <summary>她写字的样子（旧版，冻结的）</summary>
            <p>{props.dreamState.voice.text}</p>
          </details>
        ) : (
          <p className="memNote">她还没写过自己说话的样子——聊几轮、睡一觉，她就会写第一版。</p>
        )}
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
