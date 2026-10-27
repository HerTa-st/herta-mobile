/**
 * 发出去的图。
 *
 * 手机截的长图动辄 1:13，原来给它一个 max-height:220 就完事——按比例缩下来只有
 * 十几像素宽，气泡跟着塌成一条窄缝，等于发了个寂寞。所以这里按原图比例分两种：
 * 正常图照旧按比例缩；长图裁成竖卡片（object-fit: cover，露最上面一截），
 * 点开再看整张——长图只有在整屏宽度下才读得出内容。
 *
 * 长图现在进模型前会被切成几片（见 vision.ts 的 prepareImage），所以这里是
 * 「一摞图」而不是一张：气泡用第一片当缩略图，点开把整摞按原样接起来。
 */
import { useState } from "react";
import { longPressProps } from "./long-press.ts";

/** 高 / 宽 超过这个数就算「长图」。1.9 ≈ 竖着的 A4 截图，再长就没法按比例缩了。 */
const TALL_RATIO = 1.9;

export function isTallImage(el: HTMLImageElement): boolean {
  return el.naturalWidth > 0 && el.naturalHeight / el.naturalWidth >= TALL_RATIO;
}

export function Shot({
  pieces,
  name,
  onOpen,
  onLongPress,
}: {
  pieces: string[];
  name?: string;
  onOpen(): void;
  /** 长按：存进表情箱。手机上这是唯一不打断看图的手势。 */
  onLongPress?(): void;
}) {
  const [tall, setTall] = useState(pieces.length > 1);
  const press = onLongPress ? longPressProps(onLongPress) : null;
  return (
    <button
      type="button"
      className={"shot" + (tall ? " tall" : "")}
      onClick={() => {
        // 长按之后补上来的那次 click 不算"点开"
        if (press?.fired()) return;
        onOpen();
      }}
      aria-label={tall ? "看长图" : "看图"}
      {...(press?.props ?? {})}
    >
      <img
        src={pieces[0] ?? ""}
        alt={name ?? "图"}
        onLoad={(e) => {
          setTall(pieces.length > 1 || isTallImage(e.currentTarget));
        }}
      />
      {tall && <span className="shotHint">长图 · 点开</span>}
    </button>
  );
}

/** 点开之后：整摞按屏宽铺开、上下滚。长图的内容在这里才看得见。 */
export function ShotViewer({ pieces, name, onClose }: { pieces: string[]; name?: string; onClose(): void }) {
  return (
    <div className="shotView" onClick={onClose} role="dialog" aria-modal="true" aria-label={name ?? "看图"}>
      <div className="shotStack">
        {pieces.map((src, i) => (
          <img key={i} src={src} alt={name ?? "图"} />
        ))}
      </div>
      <button type="button" className="shotClose" onClick={onClose} aria-label="关闭">
        ✕
      </button>
    </div>
  );
}
