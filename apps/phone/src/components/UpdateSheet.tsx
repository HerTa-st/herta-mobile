import type { UpdateSnapshot } from "../update/store.ts";
import "../styles/settings-suite.css";

const ICON = {
  back: "M15 6l-6 6 6 6",
  close: "M6 6l12 12M18 6L6 18",
  download: "M12 4v10m0 0l-4-4m4 4l4-4M5 20h14",
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
 * B16 · 版本更新。
 *
 * 一页只回答三个问题：现在是什么版本、线上是什么版本、这版改了什么。
 * 下载按钮交给系统浏览器（设计文档 §6.5：不走应用内下载器，也不在 App 里装更新器）。
 *
 * 「必须更新」不是拦人的门：她还能用，只是把话说明白、把「以后再说」收起来。
 */
export function UpdateSheet({
  current,
  update,
  onDownload,
  onRecheck,
  onClose,
}: {
  current: string;
  update: UpdateSnapshot;
  onDownload(url: string): void;
  onRecheck(): void;
  onClose(): void;
}) {
  const verdict = update.verdict;
  const checking = update.status === "checking";
  const manifest = verdict?.manifest ?? null;
  const must = verdict?.must ?? false;

  return (
    <div className="ss-page" data-part="panel" role="dialog" aria-label="版本更新">
      <header className="ss-top">
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="返回">
          <Icon d={ICON.back} size={18} />
        </button>
        <div className="ss-title">
          <b>版本更新</b>
          <span>只取一份静态清单 · 不上报任何信息</span>
        </div>
        <span className="ss-badge">
          <i />
          {checking ? "检查中" : "本机"}
        </span>
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="关闭">
          <Icon d={ICON.close} size={16} />
        </button>
      </header>

      <div className="ss-body">
        <section className="ss-card ss-cardPad" data-part="update-state">
          <div className="ss-kicker">VERSION</div>
          {verdict ? (
            <>
              <div className="up-pair">
                <div>
                  <small>当前</small>
                  <b className="up-num">{current}</b>
                </div>
                <span className="up-arrow" aria-hidden="true">
                  →
                </span>
                <div>
                  <small>线上</small>
                  <b className="up-num up-new">{manifest?.latest}</b>
                </div>
              </div>
              <p className="up-line" data-part="update-headline">
                {must ? "这版不能再往后拖了。" : "有新的了。"}
              </p>
            </>
          ) : (
            <>
              <div className="up-pair">
                <div>
                  <small>当前</small>
                  <b className="up-num">{current}</b>
                </div>
              </div>
              <p className="up-line" data-part="update-headline">
                {checking ? "正在看一眼有没有新版…" : "这就是最新的。"}
              </p>
              <p className="ss-note">没联网或者那份清单暂时取不到时，这里也会是这句——取不到就静默，不给你弹错。</p>
            </>
          )}
        </section>

        {manifest && (
          <section className="ss-card ss-cardPad" data-part="update-note">
            <div className="ss-groupHead">
              <span>这版改了什么</span>
              <span>{manifest.latest}</span>
            </div>
            <p className="up-note">{manifest.note ?? "这版没说改了啥。"}</p>
          </section>
        )}

        {must && manifest && (
          <section className="ss-card ss-cardPad up-must" data-part="update-must">
            <div className="ss-kicker">REQUIRED</div>
            <p>
              你现在这版比 <b>{manifest.min}</b> 还旧。再往后可能会碰上已经修掉的问题，
              数据也可能对不上——建议现在就换。
            </p>
          </section>
        )}

        <section className="ss-card ss-cardPad">
          <div className="bk-actions">
            {manifest && (
              <button
                type="button"
                className="ss-btn ss-btnInk ss-btnWide"
                onClick={() => onDownload(manifest.url)}
                data-part="update-download"
              >
                <Icon d={ICON.download} size={15} />
                去下载
              </button>
            )}
            <button type="button" className="ss-btn ss-btnGhost ss-btnWide" onClick={onRecheck} disabled={checking}>
              {checking ? "检查中…" : "检查一次"}
            </button>
            {!must && (
              <button type="button" className="ss-btn ss-btnGhost ss-btnWide" onClick={onClose}>
                以后再说
              </button>
            )}
          </div>
          <p className="ss-hint">
            下载走系统浏览器，装不装由你决定。App 只发一个 GET，不带昵称、机型、版本号，也不带任何查询参数。
          </p>
        </section>
      </div>
    </div>
  );
}
