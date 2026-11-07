import { Fragment, useState, type ReactNode } from "react";
import { DOC_FILE_EXTENSIONS, TEXT_FILE_EXTENSIONS } from "@herta/core";
import type { Settings } from "../settings.ts";
import type { StickerRecord } from "../storage.ts";
import { openNotifySettings } from "../notif.ts";
import { A11ySheet } from "./A11ySheet.tsx";
import "../styles/settings-suite.css";

const ALL_KEYS = [
  "statusEnabled",
  "notifyEnabled",
  "mediaEnabled",
  "locationEnabled",
  "remindersEnabled",
  "calendarEnabled",
  "openEnabled",
  "shareEnabled",
  "cameraEnabled",
  "a11yEnabled",
  "proactiveEnabled",
  "albumEnabled",
  "ttsEnabled",
] as const;

type CapKey =
  | "statusEnabled"
  | "notifyEnabled"
  | "mediaEnabled"
  | "locationEnabled"
  | "remindersEnabled"
  | "calendarEnabled"
  | "openEnabled"
  | "shareEnabled"
  | "cameraEnabled"
  | "a11yEnabled"
  | "proactiveEnabled"
  | "albumEnabled"
  | "ttsEnabled"
  | "proactiveDeepMemory";

type CapState = "off" | "ask" | "granted";

interface CapItem {
  key: CapKey;
  title: string;
  hint: string;
  /** 高权限单独标出来：授权前值得多想一秒的那几项。 */
  high?: "高权限" | "最高权限";
  /** 开着 = 她动手前会先在对话里问一句。 */
  ask?: boolean;
  after?: ReactNode;
}

const ICON = {
  back: "M15 6l-6 6 6 6",
  close: "M6 6l12 12M18 6L6 18",
  caps: "M12 3l7 3v5c0 4.5-2.8 7.8-7 10-4.2-2.2-7-5.5-7-10V6zM9 12l2 2 4-4",
  lock: "M5 10h14v10H5zM8 10V8a4 4 0 018 0v2",
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

const STATE_TEXT: Record<CapState, string> = { off: "关闭", ask: "询问", granted: "已开" };

/**
 * 「她能做什么」——一整页，不是塞在设置里的一堆勾。
 *
 * 三组按**敏感度**排，而不是按功能排：她能看见什么 / 她会动手做什么 / 她是不是
 * 一直在后台。这个顺序和"她在对话里先问一句"那条规矩是一条线：越往下越需要
 * 你自己想清楚再打开。
 *
 * 全部默认关。她自己不能替你把它们打开——权限是用户给的，不是人格给的。
 */
export function CapabilitiesSheet({
  settings,
  onChange,
  onClose,
  fileNames,
  onFile,
  onRemoveFile,
  onClearFiles,
  stickers,
  onAddStickers,
  onRemoveSticker,
}: {
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
  onClose(): void;
  /** 她从设置里搬过来的：读的文件 */
  fileNames: string[];
  onFile(file: File): void;
  onRemoveFile(name: string): void;
  onClearFiles(): void;
  /** 同上：她的表情包 */
  stickers: StickerRecord[];
  onAddStickers(files: File[]): void;
  onRemoveSticker(id: string): void;
}) {
  const [showA11y, setShowA11y] = useState(false);

  const setKey = (key: CapKey, on: boolean) => {
    onChange({ [key]: on } as Partial<Settings>);
  };

  const stateOf = (on: boolean, ask?: boolean): CapState => {
    if (!on) return "off";
    return ask ? "ask" : "granted";
  };

  const notifyBtn = (settings.notifyEnabled || settings.mediaEnabled) ? (
    <button type="button" className="ss-linkRow" onClick={() => void openNotifySettings()}>
      去系统里开「通知使用权」
      <span>系统设置 ›</span>
    </button>
  ) : null;

  const a11yBtn = settings.a11yEnabled ? (
    <button type="button" className="ss-linkRow" onClick={() => setShowA11y(true)}>
      允许她碰哪些 App
      <span>白名单 ›</span>
    </button>
  ) : null;

  const groups: { title: string; hint: string; items: CapItem[] }[] = [
    {
      title: "只看得见",
      hint: "看，不碰",
      items: [
        {
          key: "statusEnabled",
          title: "看手机状态",
          hint: "电量、是否在充电、联网方式、这个 App 占多大地方。看不到你的照片和消息。",
        },
        {
          key: "notifyEnabled",
          title: "看通知栏",
          high: "高权限",
          hint: "她只会读最近二十几条（应用名、标题、正文、时间），不落盘、不常驻盯着；问她「刚才有什么事」才用得上。",
        },
        {
          key: "mediaEnabled",
          title: "看 / 控正在放的音乐",
          high: "高权限",
          hint: "和上面共用同一个系统授权；只能暂停、继续、切歌，看不到播放列表。",
          after: notifyBtn,
        },
        {
          key: "locationEnabled",
          title: "知道你在哪",
          high: "高权限",
          hint: "只给经纬度和精度，不做逆地理编码。只在你要她查的时候查一次，不会在后台跟着你。",
        },
      ],
    },
    {
      title: "会动手",
      hint: "先问，再做",
      items: [
        {
          key: "remindersEnabled",
          title: "排提醒",
          hint: "到点由系统响。标题是她那句话，正文写清楚事情。关掉之后她只能说「你自己记一下」。",
        },
        {
          key: "calendarEnabled",
          title: "你的日历",
          ask: true,
          hint: "能看接下来几天有什么，也能往里写字。写之前她会先说一句，你说行才写。",
        },
        {
          key: "openEnabled",
          title: "打开链接或别的 App",
          ask: true,
          hint: "把 https、tel:、地图、深链交给系统打开。她不会自己偷偷打开。",
        },
        {
          key: "shareEnabled",
          title: "分享出去",
          ask: true,
          hint: "调出系统分享面板，发不发、发给谁由你点。",
        },
        {
          key: "cameraEnabled",
          title: "打开相机",
          high: "高权限",
          ask: true,
          hint: "她会先问一句再开；拍完只拿到一段文字描述，原图不留在她那儿。这条要配了视觉模型才有用。",
        },
        {
          key: "a11yEnabled",
          title: "无障碍：替你看屏、替你点",
          high: "最高权限",
          ask: true,
          hint: "只在下面勾过的 App 里生效；动手之前她会先在对话里问一句。这是这批里权限最重的一样。",
          after: a11yBtn,
        },
      ],
    },
    {
      title: "常驻后台",
      hint: "她自己会醒",
      items: [
        {
          key: "proactiveEnabled",
          title: "她自己找你",
          hint: "通知栏会挂一条「她在后台」。一天几次、隔多久，由她自己那档「主动程度」决定（默认一天两次），二十二点到早上八点不吵；省 token 模式下不发。",
        },
        ...(settings.proactiveEnabled
          ? [
              {
                key: "proactiveDeepMemory" as const,
                title: "主动找你时翻完整记忆",
                hint: "默认只带最近八块对话（几 k token）；打开后她会先检索一遍记忆，更像她，但一次可能上万 token。",
              },
            ]
          : []),
      ],
    },
    {
      title: "她的眼睛与嘴",
      hint: "默认关",
      items: [
        {
          key: "albumEnabled",
          title: "翻你的相册",
          hint: "要配视觉模型才会真看；她只在你让她看的时候读那一张。",
        },
        {
          key: "ttsEnabled",
          title: "用云端语音念出来",
          hint: "不然只能播那 41 条录音；要填语音接口。",
          after: settings.ttsEnabled ? (
            <div className="ss-sub">
              <label className="ss-subField">
                语音接口
                <select
                  className="ss-select"
                  value={settings.ttsProvider}
                  onChange={(e) => onChange({ ttsProvider: e.target.value as Settings["ttsProvider"] })}
                >
                  <option value="openai">OpenAI 兼容（/audio/speech）</option>
                  <option value="minimax">MiniMax（/t2a_v2）</option>
                </select>
              </label>
              <label className="ss-subField">
                语音 Key
                <input
                  className="ss-input"
                  type="password"
                  value={settings.ttsApiKey}
                  onChange={(e) => onChange({ ttsApiKey: e.target.value.trim() })}
                  placeholder="sk-..."
                  autoComplete="off"
                />
              </label>
              <label className="ss-subField">
                语音 Base URL
                <input className="ss-input" value={settings.ttsBaseUrl} onChange={(e) => onChange({ ttsBaseUrl: e.target.value.trim() })} />
              </label>
              <label className="ss-subField">
                语音模型
                <input className="ss-input" value={settings.ttsModel} onChange={(e) => onChange({ ttsModel: e.target.value.trim() })} />
              </label>
              <label className="ss-subField">
                音色 ID
                <input className="ss-input" value={settings.ttsVoice} onChange={(e) => onChange({ ttsVoice: e.target.value.trim() })} />
              </label>
              {settings.ttsProvider === "minimax" && (
                <label className="ss-subField">
                  GroupId
                  <input className="ss-input" value={settings.ttsGroupId} onChange={(e) => onChange({ ttsGroupId: e.target.value.trim() })} />
                </label>
              )}
            </div>
          ) : null,
        },
      ],
    },
  ];

  const onCount = ALL_KEYS.filter((key) => settings[key]).length;

  const row = (item: CapItem) => {
    const on = Boolean(settings[item.key]);
    const state = stateOf(on, item.ask);
    return (
      <Fragment key={item.key}>
        <label className="cap-row">
          <span className="cap-icon">
            <Icon d={item.high ? ICON.lock : ICON.caps} size={15} />
          </span>
          <span className="cap-main">
            <b>
              {item.title}
              {item.high && (
                <em className={"cap-high" + (item.high === "最高权限" ? " top" : "")}>{item.high}</em>
              )}
            </b>
            <small>{item.hint}</small>
          </span>
          <span className={"cap-state " + state}>{STATE_TEXT[state]}</span>
          <input
            type="checkbox"
            className="cap-check"
            checked={on}
            aria-label={item.title}
            onChange={(e) => setKey(item.key, e.target.checked)}
          />
        </label>
        {item.after}
      </Fragment>
    );
  };

  return (
    <div className="ss-page" data-part="panel" role="dialog" aria-label="她能做什么">
      <header className="ss-top">
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="返回">
          <Icon d={ICON.back} size={18} />
        </button>
        <div className="ss-title">
          <b>她能做什么</b>
          <span>
            {onCount} / {ALL_KEYS.length} 项开着 · 默认全关
          </span>
        </div>
        <span className="ss-badge">
          <i />
          权限
        </span>
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="关闭">
          <Icon d={ICON.close} size={16} />
        </button>
      </header>

      <div className="ss-body">
        <section className="ss-card ss-cardPad">
          <div className="ss-cardHead">
            <div>
              <h3>她能碰手机到什么程度</h3>
              <p>
                每一项都单独开，默认全关；没开的那些，她连工具都看不见。开一项，她那一轮才拿得到那只手。
              </p>
            </div>
            <span className="ss-count">
              {onCount} / {ALL_KEYS.length}
            </span>
          </div>
        </section>

        {groups.map((group) => (
          <section className="ss-card" key={group.title}>
            <div className="ss-groupHead">
              <span>{group.title}</span>
              <span>
                {group.items.filter((item) => Boolean(settings[item.key])).length} / {group.items.length} ·{" "}
                {group.hint}
              </span>
            </div>
            {group.items.map(row)}
          </section>
        ))}

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>她读的、她发的</span>
            <span>本机</span>
          </div>
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>给她读的文件</b>
              <small>文本 / PDF / Word / Excel / PPT</small>
            </span>
            <input
              className="ss-file"
              type="file"
              accept={
                TEXT_FILE_EXTENSIONS.map((ext) => "." + ext)
                  .concat(DOC_FILE_EXTENSIONS.map((ext) => "." + ext))
                  .join(",") + ",text/*"
              }
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onFile(file);
              }}
            />
          </label>
          {fileNames.length > 0 ? (
            <div className="ss-fileList">
              {fileNames.map((name) => (
                <span className="ss-fileRow" key={name}>
                  <span className="ss-fileName" title={name}>
                    {name}
                  </span>
                  <button
                    type="button"
                    className="ss-btnSmall ss-btnGhost"
                    onClick={() => onRemoveFile(name)}
                    aria-label={"删掉「" + name + "」"}
                    title="删掉这一份"
                  >
                    ✕
                  </button>
                </span>
              ))}
              <button type="button" className="ss-btnSmall ss-btnGhost" onClick={onClearFiles}>
                全清（{fileNames.length}）
              </button>
            </div>
          ) : (
            <p className="ss-note" data-part="empty-state">还没给她文件。回形针的「选文件」也可以加；她只能读你选的，不能自己翻手机。</p>
          )}
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>她的表情包（{stickers.length} 张）</b>
              <small>加几张，她就会在合适的时候自己挑一张发出来</small>
            </span>
            <input
              className="ss-file"
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                // 先取快照：把 value 清空会把 files 一起清掉
                const picked = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (picked.length > 0) onAddStickers(picked);
              }}
            />
          </label>
          {stickers.length > 0 ? (
            <div className="stickerGrid">
              {stickers.map((s) => (
                <div key={s.id} className="stickerCell">
                  <img src={s.data} alt={s.name} />
                  <button onClick={() => onRemoveSticker(s.id)} aria-label="删掉">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="ss-note">她还没有表情包。加几张，她就会在合适的时候自己挑一张发出来。</p>
          )}
        </section>

        <p className="ss-hint">
          标记「高权限」的那几项，系统会再问你一次；她在会话里只能先说「我需要」，不能自己打开。这一批到这里就齐了，再往后是 M4 双模（连 PC）——那是另一整块。
        </p>
      </div>

      {showA11y && <A11ySheet onClose={() => setShowA11y(false)} />}
    </div>
  );
}