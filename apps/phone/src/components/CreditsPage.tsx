import { useEffect, useState, type ReactNode } from "react";
import { loadCredits, type CreditsDoc } from "../credits.ts";
import "../styles/settings-suite.css";
import "../styles/credits.css";

/**
 * 「关于」三页共用的壳：页头 + 加载 + **取不到** + 内容。
 *
 * 三个页面都不自己发请求：名单只在这里取一次，取不到就统一说「名单暂时取不到」。
 * 页面不会自己编一份名单垫上——断网时宁可空着说，也不给假数据。
 */

type CreditsState =
  | { state: "loading" }
  | { state: "ok"; doc: CreditsDoc; mock: boolean }
  | { state: "fail"; detail: string };

export interface CreditsView {
  state: CreditsState;
  /** 重新取一次（只重试，不清页面）。 */
  reload(): void;
}

export function useCredits(): CreditsView {
  const [current, setCurrent] = useState<CreditsState>({ state: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setCurrent({ state: "loading" });
    void loadCredits().then((result) => {
      if (!alive) return;
      setCurrent(
        result.ok
          ? { state: "ok", doc: result.doc, mock: result.mock }
          : { state: "fail", detail: result.detail }
      );
    });
    return () => {
      alive = false;
    };
  }, [nonce]);

  return { state: current, reload: () => setNonce((n) => n + 1) };
}

const ICON = {
  back: "M15 6l-6 6 6 6",
  close: "M6 6l12 12M18 6L6 18",
  chevron: "M9 6l6 6-6 6",
} as const;

export function Icon({ d, size = 16 }: { d: string; size?: number }) {
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

export const ICONS = ICON;

export function CreditsScreen({
  title,
  subtitle,
  badge,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  badge: string;
  onClose(): void;
  children(doc: CreditsDoc, info: { mock: boolean }): ReactNode;
}) {
  const view = useCredits();
  const mock = view.state.state === "ok" && view.state.mock;

  return (
    <div className="ss-page cr-page" data-part="panel" role="dialog" aria-label={title}>
      <header className="ss-top">
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="返回">
          <Icon d={ICON.back} size={18} />
        </button>
        <div className="ss-title">
          <b>{title}</b>
          <span>{subtitle}</span>
        </div>
        <span className="ss-badge">
          <i />
          {mock ? "本地 mock" : badge}
        </span>
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="关闭">
          <Icon d={ICON.close} size={16} />
        </button>
      </header>

      <div className="ss-body">
        {view.state.state === "loading" && (
          <section className="ss-card ss-cardPad">
            <p className="cr-loading">名单读取中…</p>
          </section>
        )}

        {view.state.state === "fail" && (
          <section className="ss-card ss-cardPad" data-part="credits-unavailable">
            <div className="ss-kicker">CREDITS · 名单</div>
            <h3 className="cr-failTitle">名单暂时取不到</h3>
            <p className="cr-failDetail">{view.state.detail}</p>
            <p className="cr-failHint">
              名单放在网站上那份 JSON 里，取不到就先不显示——这里不会编一份垫上。别的功能不受影响。
            </p>
            <button type="button" className="ss-btn ss-btnGhost ss-btnSmall" onClick={view.reload}>
              再试一次
            </button>
          </section>
        )}

        {view.state.state === "ok" && children(view.state.doc, { mock: view.state.mock })}
      </div>
    </div>
  );
}

/** 页里的小标题（「开发人员」「取材自」…）：和设置里的分组头同一套观感。 */
export function SectionHead({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="ss-groupHead cr-sectionHead">
      <span>{children}</span>
      {hint ? <span>{hint}</span> : null}
    </div>
  );
}

/** 名单里的一条：左边名字 + 右边说明。 */
export function CreditRow({
  name,
  detail,
  tag,
  onClick,
}: {
  name: string;
  detail?: string;
  tag?: ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="ss-rowMain">
        <b>{name}</b>
        {detail ? <small>{detail}</small> : null}
      </span>
      {tag ? <span className="cr-tag">{tag}</span> : null}
    </>
  );
  if (!onClick) return <div className="ss-row cr-row">{body}</div>;
  return (
    <button type="button" className="ss-row ss-rowTap cr-row" onClick={onClick}>
      {body}
    </button>
  );
}
