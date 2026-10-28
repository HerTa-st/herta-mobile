import { useCallback, useEffect, useState } from "react";
import { clearToolLog, listToolLog, type ToolLogEntry } from "../storage.ts";

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

  return (
    <div className="sheet">
      <div className="sheetHead">
        <span>工具调用记录（{rows.length}）</span>
        <button type="button" className="sheetClose" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>
      <p className="memNote">
        她自己动手的每一次都记在这里：叫什么、带了什么参数、成没成、返回了什么；
        你放进来的文件（文件库）也记一条，聊天页不显示这些旁白。只留最近两百条。
      </p>
      <button type="button" className="onboardBtn" onClick={() => void wipe()} disabled={busy || rows.length === 0}>
        {busy ? "清着…" : "全清掉"}
      </button>

      {rows.length === 0 && <p className="memNote">还没有记录。她调一次工具，这里就多一行。</p>}

      <div className="toolLog">
        {rows.map((r, i) => {
          const key = r.at + ":" + i;
          const time = new Date(r.at);
          const hh = String(time.getHours()).padStart(2, "0") + ":" + String(time.getMinutes()).padStart(2, "0");
          const expanded = open === key;
          return (
            <button key={key} type="button" className={"toolRow" + (r.ok ? "" : " bad")} onClick={() => setOpen(expanded ? null : key)}>
              <span className="toolHead">
                <b>{r.label || r.name}</b>
                <em>
                  {hh} · {r.name}
                </em>
              </span>
              <span className={"toolBody" + (expanded ? " full" : "")}>{r.content}</span>
              {expanded && r.args && r.args !== "{}" && <span className="toolArgs">{r.args}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
