import { useEffect, useState } from "react";
import { groupSponsorsByMonth, type CreditsDoc } from "../credits.ts";
import { CreditRow, CreditsScreen, Icon, ICONS } from "./CreditsPage.tsx";

/**
 * 赞助名单。
 *
 * 一条边界：**这页不是收款页**。页面上没有二维码、也没有可点的收款链接；
 * 收款码与群号只在「我要赞助」点开的那层弹层里出现，而且码是 <img>、不是 <a>。
 * 名单按月分组，最近一个月默认展开，历史折叠。
 */
export function SponsorsScreen({ onClose }: { onClose(): void }) {
  return (
    <CreditsScreen
      title="赞助名单"
      subtitle="按月的名单 · 改名单不用发版"
      badge="名单来自网站"
      onClose={onClose}
    >
      {(doc) => <SponsorsBody doc={doc} />}
    </CreditsScreen>
  );
}

function SponsorsBody({ doc }: { doc: CreditsDoc }) {
  const months = groupSponsorsByMonth(doc.sponsors);
  const [openMonths, setOpenMonths] = useState<string[]>(() =>
    months.length > 0 ? [months[0].month] : []
  );
  const [asking, setAsking] = useState(false);

  const toggle = (month: string) =>
    setOpenMonths((list) =>
      list.includes(month) ? list.filter((item) => item !== month) : [...list, month]
    );

  const total = doc.sponsors.length;

  return (
    <>
      <section className="ss-card ss-cardPad">
        <div className="ss-kicker">SPONSORS · 赞助名单</div>
        <p className="cr-lead">
          她是你手机里一个不联网记账、不上报数据的小东西。想让她继续长下去，可以在这里留一点钱——
          不留也没关系，给个 Star、提一条反馈，同样算。
        </p>
        <div className="cr-askRow">
          <button type="button" className="ss-btn ss-btnInk ss-btnSmall" onClick={() => setAsking(true)}>
            我要赞助
          </button>
          <span className="cr-askHint">微信 / 支付宝 · 赞助群 · 都在弹层里</span>
        </div>
        <p className="cr-footNote">
          {total > 0 ? "共 " + total + " 位 · 最近的月份默认展开" : "还没有赞助名单"} · 名单来自网站那份
          JSON，改它不用发版
        </p>
      </section>

      {months.length === 0 ? (
        <section className="ss-card ss-cardPad">
          <p className="cr-empty" data-part="empty-state">
            还没有赞助名单。赞助不是必须的——给个 Star、提一条反馈，同样算支持。
          </p>
        </section>
      ) : (
        <section className="ss-card cr-monthCard">
          {months.map((group, index) => {
            const open = openMonths.includes(group.month);
            return (
              <div key={group.month} className={index === 0 ? "cr-month first" : "cr-month"}>
                <button
                  type="button"
                  className="cr-monthHead"
                  onClick={() => toggle(group.month)}
                  aria-expanded={open}
                >
                  <span className="cr-monthName">
                    {group.label}
                    {index === 0 ? <em>最近</em> : null}
                  </span>
                  <span className="cr-monthMeta">
                    {group.rows.length} 位
                    <Icon d={ICONS.chevron} size={13} />
                  </span>
                </button>
                {open ? (
                  <div className="cr-monthBody">
                    {group.rows.map((sponsor, i) => (
                      <CreditRow
                        key={group.month + ":" + sponsor.name + ":" + i}
                        name={sponsor.name}
                        detail={sponsor.tier}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="cr-folded">历史上的一个月，点上面的月份展开。</p>
                )}
              </div>
            );
          })}
        </section>
      )}

      <p className="ss-hint">
        名单只写名字与月份；不想留名的话，赞助时说一声「不署名」就行。
      </p>

      {asking ? <SponsorAsk donate={doc.donate} onClose={() => setAsking(false)} /> : null}
    </>
  );
}

/** 弹层里的一张收款码：只当图片显示，不带任何跳转。 */
function QrShot({ src, label }: { src?: string; label: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <figure className="cr-qr">
      {src && !broken ? (
        <img src={src} alt={label + "收款码"} loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <div className="cr-qrMissing">{src ? "这张码没加载出来" : "这份名单没给码"}</div>
      )}
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function SponsorAsk({
  donate,
  onClose,
}: {
  donate: CreditsDoc["donate"];
  onClose(): void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const qq = (donate.qqGroup ?? "").replace(/\s/g, "");

  const copy = async () => {
    if (!qq) return;
    try {
      await navigator.clipboard.writeText(qq);
      setCopied(true);
    } catch {
      // 老 WebView 没给 clipboard 权限：textarea 那套兜底。
      const area = document.createElement("textarea");
      area.value = qq;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
        setCopied(true);
      } finally {
        document.body.removeChild(area);
      }
    }
  };

  return (
    <div className="cr-modal" role="dialog" aria-modal="true" aria-label="赞助她">
      <button type="button" className="cr-backdrop" aria-label="关闭" onClick={onClose} />
      <div className="cr-sheet">
        <div className="cr-sheetHead">
          <b>赞助她</b>
          <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="关闭赞助弹层">
            <Icon d={ICONS.close} size={16} />
          </button>
        </div>
        <p className="cr-sheetLead">两块也是钱，她记得。</p>

        <div className="cr-qrRow">
          <QrShot src={donate.wechat} label="微信" />
          <QrShot src={donate.alipay} label="支付宝" />
        </div>

        <div className="cr-groupRow">
          <span className="cr-groupLabel">赞助群（QQ）</span>
          <code className="cr-qq">{qq || "这份名单没给群号"}</code>
          <button
            type="button"
            className="ss-btn ss-btnGhost ss-btnSmall"
            onClick={() => void copy()}
            disabled={!qq}
          >
            {copied ? "已复制" : "复制群号"}
          </button>
        </div>

        <p className="cr-sheetFoot">
          赞助是为了让她能继续更新下去。赞助不等于任何授权，也不代表与版权方的任何关联。
          收款码与群号都来自远程名单，换码不用发版。
        </p>
      </div>
    </div>
  );
}
