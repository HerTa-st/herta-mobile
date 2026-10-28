/**
 * 回形针抽起来的那一层：拍照 / 选文件。
 *
 * 以前回形针一点就直接弹系统选图——Android 各家的选择器长相不一，有的根本没有
 * 「拍照」，用户想拍一张反而找不到入口。把两个来源摆成两个按钮，点哪个进哪个。
 *
 * 两样最终都进同一条看图管线（切片 → 待发），所以这里只负责「从哪儿来」，
 * 不碰切图和发送。
 */
export function AttachTray({
  onCamera,
  onFile,
  onClose,
  busy,
}: {
  onCamera(): void;
  onFile(): void;
  onClose(): void;
  /** 上一张还在处理（或相机还开着）时先别再点。 */
  busy?: boolean;
}) {
  return (
    <div className="attachTray">
      <div className="attachHead">
        <span>给她看点什么</span>
        <button type="button" className="trayClose" onClick={onClose} aria-label="收起附件面板">
          ✕
        </button>
      </div>
      <div className="attachGrid">
        <button type="button" className="attachOpt" onClick={onCamera} disabled={busy}>
          <span className="ico" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4.6 8.1h2.1l1.4-2h7.8l1.4 2h2.1c.8 0 1.4.6 1.4 1.4v8.1c0 .8-.6 1.4-1.4 1.4H4.6c-.8 0-1.4-.6-1.4-1.4V9.5c0-.8.6-1.4 1.4-1.4Z" />
              <circle cx="12" cy="13.1" r="3.3" />
            </svg>
          </span>
          <span>
            <b>拍照</b>
            <em>用相机拍一张</em>
          </span>
        </button>
        <button type="button" className="attachOpt" onClick={onFile} disabled={busy}>
          <span className="ico" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3.7 7.4c0-1 .8-1.8 1.8-1.8h3.3l1.8 2h7.7c1 0 1.8.8 1.8 1.8v7.8c0 1-.8 1.8-1.8 1.8H5.5c-1 0-1.8-.8-1.8-1.8V7.4Z" />
            </svg>
          </span>
          <span>
            <b>选文件</b>
            <em>图片 / 文本 / 文档</em>
          </span>
        </button>
      </div>
    </div>
  );
}
