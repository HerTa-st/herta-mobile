import { useState } from "react";
import type { StickerRecord } from "../storage.ts";

/**
 * 表情面板：从输入框抽起来的一层。
 *
 * 两个页签——「她的」是她的库（她发给你用），「我的」是你的箱（你发给她用）。
 * 分开放是刻意的：她的库决定她挑表情时能挑到什么，你的箱决定你能发什么；
 * 混在一起，她会开始发你存的图，你就分不清谁在说话了。
 *
 * 加图入口就一个「+」：它跟着当前页签走，加到哪个库里看你在哪一页。
 * 长按一张是删（删除要二次确认，手机上没有右键，误触很容易）。
 */
export function StickerTray({
  her,
  mine,
  onPick,
  onAdd,
  onRemove,
  onClose,
}: {
  her: StickerRecord[];
  mine: StickerRecord[];
  onPick(record: StickerRecord): void;
  onAdd(files: File[], owner: "herta" | "mine"): void;
  onRemove(id: string): void;
  onClose(): void;
}) {
  const [tab, setTab] = useState<"herta" | "mine">("herta");
  const list = tab === "herta" ? her : mine;

  return (
    <div className="stickerTray">
      <div className="trayHead">
        <button type="button" className={tab === "herta" ? "on" : ""} onClick={() => setTab("herta")}>
          她的（{her.length}）
        </button>
        <button type="button" className={tab === "mine" ? "on" : ""} onClick={() => setTab("mine")}>
          我的（{mine.length}）
        </button>
        <button type="button" className="trayClose" onClick={onClose} aria-label="收起表情">
          ✕
        </button>
      </div>
      <div className="trayGrid">
        {list.map((s) => (
          <button
            type="button"
            key={s.id}
            className="trayCell"
            onClick={() => onPick(s)}
            onContextMenu={(e) => {
              e.preventDefault();
              onRemove(s.id);
            }}
            title={s.tags.length > 0 ? s.tags.join("、") : s.name}
          >
            <img src={s.data} alt={s.name} />
          </button>
        ))}
        <label className="trayAdd">
          <span>＋</span>
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => {
              // 必须先取快照再清 value：FileList 是活引用，清了就一张都加不进去
              const picked = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (picked.length > 0) onAdd(picked, tab);
            }}
          />
        </label>
      </div>
      <p className="memNote">
        {list.length === 0
          ? tab === "herta"
            ? "她的库还是空的。加几张，她就会在合适的时候自己挑一张发出来。"
            : "你的箱还是空的。加几张，或者长按聊天里的图存进来。"
          : "点一张发给对方；长按一张删掉。"}
      </p>
    </div>
  );
}
