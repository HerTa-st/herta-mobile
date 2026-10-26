import type { MemoryRecord } from "@herta/core";
import { memoryTitle } from "@herta/core";

/** 记忆全文。只读，底部可以删。 */
export function MemoryViewer({
  record,
  onClose,
  onDelete,
}: {
  record: MemoryRecord;
  onClose(): void;
  onDelete(name: string): void;
}) {
  return (
    <div className="viewer" role="dialog" aria-label="记忆全文">
      <header className="vh">
        <span className="vt">{memoryTitle(record)}</span>
        <button className="vx" onClick={onClose}>
          关闭
        </button>
      </header>
      <p className="vmeta">
        {record.createdAt ? new Date(record.createdAt).toLocaleDateString("zh-CN") : "更早"}
        {record.sessionId ? " · 从对话里长出来的" : " · 自带的种子"}
        {record.tag ? " · " + record.tag : ""}
        {typeof record.weight === "number" ? " · 权重 " + record.weight.toFixed(2) : ""}
      </p>
      <pre className="vbody">{record.body}</pre>
      {record.links && record.links.length > 0 && (
        <p className="vmeta">她把它和这些串在一起：{record.links.map((l) => l.replace(/^### 废案_\d+：/, "").replace(/\.txt$/, "")).join("、")}</p>
      )}
      {record.gist && <p className="vmeta">简化后的要点：{record.gist}</p>}
      {record.deepenNote && <p className="vmeta">她说这条还能长：{record.deepenNote}</p>}
      <footer className="vf">
        <button
          className="vdel"
          onClick={() => {
            onDelete(record.name);
          }}
        >
          删掉这条
        </button>
      </footer>
    </div>
  );
}
