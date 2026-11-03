/**
 * 播报里点开一条 = 读这一条的原文稿。
 *
 * 稿子是她读完网页后写的（要点 + 短正文），不是把网页原样塞进手机：
 * 原文链接永远留在页脚，想看原样可以跳出去。
 * Markdown 只认她会被要求用的子集：### 小标题、- 列表、| 表格 |、**加粗**。
 */

import type { ReactNode } from "react";
import { type BroadcastDigest, type BroadcastItem } from "@herta/core";

export interface BroadcastReaderProps {
  item: BroadcastItem;
  /** 「今天 11月2日」这类日期条，由页面算好传进来。 */
  dateText: string;
  digest: BroadcastDigest | null;
  loading: boolean;
  error: string | null;
  onRetry(): void;
  onClose(): void;
  onOpenLink(url: string): void;
  onDiscuss(item: BroadcastItem): void;
}

function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter((part) => part !== "")
    .map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? <b key={i}>{part.slice(2, -2)}</b> : <span key={i}>{part}</span>
    );
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let table: string[][] = [];

  const flushList = () => {
    if (list.length === 0) return;
    const items = list;
    list = [];
    blocks.push(
      <ul className="bcrList" key={"l" + blocks.length}>
        {items.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>
    );
  };
  const flushTable = () => {
    if (table.length === 0) return;
    const rows = table;
    table = [];
    const [head, ...body] = rows;
    blocks.push(
      <div className="bcrTableWrap" key={"t" + blocks.length}>
        <table className="bcrTable">
          <thead>
            <tr>
              {head.map((cell, i) => (
                <th key={i}>{inline(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>{inline(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      flushList();
      flushTable();
      continue;
    }
    if (line.startsWith("|")) {
      flushList();
      if (/^[|\s:-]+$/.test(line)) continue;
      table.push(tableCells(line));
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      flushTable();
      list.push(line.slice(2).trim());
      continue;
    }
    flushList();
    flushTable();
    if (line.startsWith("### ")) {
      blocks.push(
        <h3 className="bcrH3" key={"h" + blocks.length}>
          {inline(line.slice(4))}
        </h3>
      );
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push(
        <h3 className="bcrH3" key={"h" + blocks.length}>
          {inline(line.slice(3))}
        </h3>
      );
      continue;
    }
    blocks.push(
      <p className="bcrP" key={"p" + blocks.length}>
        {inline(line)}
      </p>
    );
  }
  flushList();
  flushTable();
  return <>{blocks}</>;
}

export function BroadcastReader(props: BroadcastReaderProps) {
  const { item, dateText, digest, loading, error } = props;
  return (
    <div className="bcrView" role="dialog" aria-label={item.title}>
      <header className="bcrHead">
        <button type="button" className="bcrBack" onClick={props.onClose} aria-label="返回播报">
          ←
        </button>
        <span className="bcrHeadLabel">{item.source || "原文"}</span>
      </header>

      <div className="bcrScroll">
        <p className="bcrKicker">
          {item.source}
          <span>·</span>
          {dateText}
          {item.tag && <span className="bcrKickerTag">你关注 {item.tag}</span>}
        </p>
        <h1 className="bcrTitle">{item.title}</h1>

        {loading && (
          <div className="bcrState" role="status">
            <span className="bcSpinner" aria-hidden="true" />
            <p className="bcrStateTitle">她正在读原文…</p>
            <p className="bcrStateHint">读完整篇再压成要点，十几秒。</p>
          </div>
        )}

        {!loading && error && (
          <div className="bcrState" role="alert">
            <p className="bcrStateTitle">这篇没读下来。</p>
            <p className="bcrStateErr">{error}</p>
            <div className="bcrStateActions">
              <button type="button" className="bcRetry" onClick={props.onRetry}>
                再读一次
              </button>
              {item.url && (
                <button type="button" className="bcrGhost" onClick={() => props.onOpenLink(item.url)}>
                  去原文 ↗
                </button>
              )}
            </div>
          </div>
        )}

        {!loading && !error && digest && (
          <>
            {digest.points.length > 0 && (
              <section className="bcrPoints" aria-label="要点">
                <h2>要点</h2>
                <ul>
                  {digest.points.map((point, i) => (
                    <li key={i}>{inline(point)}</li>
                  ))}
                </ul>
              </section>
            )}
            <article className="bcrBody">
              <Markdown text={digest.detail} />
            </article>
          </>
        )}

        {!loading && !error && !digest && (
          <p className="bcrSummary">{item.summary}</p>
        )}

        <footer className="bcrFoot">
          {item.url && (
            <button type="button" className="bcrGhost" onClick={() => props.onOpenLink(item.url)}>
              去原文 ↗
            </button>
          )}
          {!item.egg && (
            <button type="button" className="bcrGhost" onClick={() => props.onDiscuss(item)}>
              引用到对话
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
