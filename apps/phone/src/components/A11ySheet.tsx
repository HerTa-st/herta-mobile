import { useEffect, useMemo, useState } from "react";
import { a11yStatus, getWhitelist, listApps, openA11ySettings, setWhitelist, type AppRow } from "../a11y.ts";

/**
 * 无障碍的白名单。
 *
 * 这一页只有一件事：告诉你"她能碰哪些 App"。默认一个都不许；勾了才许。
 * 白名单存原生侧（服务自己判断），这里只是它的编辑器。
 *
 * 上面那行状态比勾选重要——没在系统里开服务，勾了也不生效。
 */
export function A11ySheet({ onClose }: { onClose(): void }) {
  const [apps, setApps] = useState<AppRow[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<{ enabled: boolean; connected: boolean }>({ enabled: false, connected: false });
  const [filter, setFilter] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [st, list, white] = await Promise.all([a11yStatus(), listApps(), getWhitelist()]);
      if (!alive) return;
      setStatus(st);
      setApps(list);
      setPicked(new Set(white));
    })();
    return () => {
      alive = false;
    };
  }, []);

  const toggle = async (pkg: string) => {
    const next = new Set(picked);
    if (next.has(pkg)) next.delete(pkg);
    else next.add(pkg);
    setPicked(next);
    try {
      await setWhitelist([...next]);
    } catch (e) {
      setNote("没存上：" + (e instanceof Error ? e.message : String(e)));
    }
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((a) => a.label.toLowerCase().includes(q) || a.pkg.toLowerCase().includes(q));
  }, [apps, filter]);

  return (
    <div className="sheet">
      <div className="sheetHead">
        <span>允许她碰哪些 App</span>
        <button type="button" className="sheetClose" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>

      <p className="memNote">
        {status.connected
          ? "服务在跑。下面勾了的 App，她才能读屏、才能按你说的字点一下；没勾的一个都碰不到。"
          : status.enabled
            ? "系统里开了，但服务还没连上——切出去再回来，或者重启一下 App。"
            : "系统里还没开这个服务。上面勾了也不会生效，要先点下面那个按钮去开。"}
      </p>
      {!status.connected && (
        <button type="button" className="onboardBtn" onClick={() => void openA11ySettings()}>
          去系统里开「无障碍」
        </button>
      )}

      <label>
        找应用
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="输入名字或包名" />
      </label>

      <div className="a11yList">
        {shown.length === 0 && <p className="memNote">没找到应用（浏览器里列不出来，真机上才有）。</p>}
        {shown.map((a) => (
          <label key={a.pkg} className="check capRow">
            <input type="checkbox" checked={picked.has(a.pkg)} onChange={() => void toggle(a.pkg)} />
            <span>
              <b>{a.label}</b>
              <em>{a.pkg}</em>
            </span>
          </label>
        ))}
      </div>

      {note && <p className="memNote">{note}</p>}
      <p className="memNote">
        她动手之前会先在对话里问一句——这条是写在她人格契约里的，不是这页的开关。这页能收窄的只有范围。
      </p>
    </div>
  );
}
