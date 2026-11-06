import { sortIssues, type CreditsDoc } from "../credits.ts";
import { CreditsScreen, SectionHead } from "./CreditsPage.tsx";
import { APP_VERSION } from "../theme/version.ts";

/**
 * 已知问题。
 *
 * 列的是**还没修**的边界，不是让你操作一遍才发现。内容来自同一份名单 JSON，
 * 和网站 issues.html 是同一批 title/detail/status。
 * 反馈前先看一眼，能省你我时间——反馈入口在本页底部，指向第三方表单。
 */
export function IssuesScreen({
  onClose,
  onOpenFeedback,
}: {
  onClose(): void;
  onOpenFeedback(): void;
}) {
  return (
    <CreditsScreen
      title="已知问题"
      subtitle="还没修的边界 · 不是你操作错了"
      badge="名单来自网站"
      onClose={onClose}
    >
      {(doc) => <IssuesBody doc={doc} onOpenFeedback={onOpenFeedback} />}
    </CreditsScreen>
  );
}

function IssuesBody({ doc, onOpenFeedback }: { doc: CreditsDoc; onOpenFeedback(): void }) {
  const rows = sortIssues(doc.issues);
  const open = rows.filter((row) => row.status === "open").length;
  const fixed = rows.length - open;

  return (
    <>
      <section className="ss-card ss-cardPad">
        <div className="ss-kicker">KNOWN ISSUES · 已知问题</div>
        <p className="cr-lead">
          这些是<b>还没修</b>的，不是你操作错了。反馈之前先看一眼，能省你我时间。
        </p>
        <p className="cr-footNote">
          {rows.length === 0
            ? "这份名单还没列已知问题"
            : "共 " + rows.length + " 条 · 没修 " + open + " 条" + (fixed > 0 ? " · 标了已修 " + fixed + " 条" : "")}
          {" · "}App {APP_VERSION}
        </p>
      </section>

      {rows.length === 0 ? (
        <section className="ss-card ss-cardPad">
          <p className="cr-empty" data-part="empty-state">
            还没列已知问题——不是没有问题，是这份名单还没写。
          </p>
        </section>
      ) : (
        <section className="ss-card cr-issues">
          <SectionHead hint="现象 · 原因">清单</SectionHead>
          {rows.map((issue, i) => (
            <div key={"issue:" + issue.title + ":" + i} className={"cr-issue " + issue.status}>
              <div className="cr-issueHead">
                <b>{issue.title}</b>
                <em>{issue.status === "fixed" ? "已修" : "未修"}</em>
              </div>
              {issue.detail ? <p>{issue.detail}</p> : null}
            </div>
          ))}
        </section>
      )}

      <section className="ss-card ss-cardPad">
        <b className="cr-ctaTitle">还是没解决？去反馈</b>
        <p className="cr-lead">
          反馈时带上：手机型号、Android 版本、App 版本号（{APP_VERSION}），以及你做了什么才出现的。
        </p>
        <button type="button" className="ss-btn ss-btnInk ss-btnSmall" onClick={onOpenFeedback}>
          打开反馈表单
        </button>
      </section>

      <p className="ss-hint">表单是第三方（飞书）的，提交内容不经这个 App。</p>
    </>
  );
}
