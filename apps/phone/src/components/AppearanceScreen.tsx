import {
  BACKGROUND_PRESETS,
  PRESET_FACE_SRC,
  backgroundKind,
  backgroundOf,
  faceSrc,
  isCustomImage,
  type Settings,
} from "../settings.ts";
import "../styles/settings-suite.css";

const ICON = {
  back: "M15 6l-6 6 6 6",
  close: "M6 6l12 12M18 6L6 18",
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
 * 外观 · 她的样子。
 *
 * 三件事收在一处（设计 §6.1）：当前的脸、聊天背景、背景作用域。
 * 入口只有一个——设置里「外观」组的那一行；设置页本身不再撑大。
 *
 * 这一页只管「选了什么」，不自己读写存储：头像/背景/作用域都写回 settings，
 * 「按会话」的覆盖由 App 落 kv。这样 4 处头像渲染永远只认 settings 里的同一个值。
 */
export function AppearanceScreen({
  settings,
  onChange,
  onClose,
  sessionId,
  sessionBackground,
  onBackground,
  onPickPhoto,
  picking,
  note,
}: {
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
  onClose(): void;
  /** 当前会话；没有会话时「按会话」不可选。 */
  sessionId: string | null;
  /** 这条会话自己设过的背景（null = 没设过，继承全局）。 */
  sessionBackground: string | null;
  /** 选背景：作用域是全局就改全局，是按会话就写当前这条。 */
  onBackground(value: string): void;
  /** 走已有的相册/拍照管线，不在这里另开 file input。 */
  onPickPhoto(target: "avatar" | "background"): void;
  picking: "avatar" | "background" | null;
  /** 读图失败 / 这张太大之类，只在页内说一句。 */
  note: string | null;
}) {
  const face = faceSrc(settings);
  const background = backgroundOf(settings, sessionBackground);
  const backgroundName = backgroundKind(background);
  const scopeSession = settings.backgroundScope === "session";
  const customFace = isCustomImage(settings.avatar);

  const scopeHint = !sessionId
    ? "还没有会话，按会话暂时用不了；先按全局设一张。"
    : scopeSession
      ? sessionBackground === null
        ? "这条会话还没单独设过，先用全局那张。改一次就只改这一条。"
        : "这条会话有自己的一张；新会话仍然继承全局。"
      : "一张背景管全部会话。切到按会话，就能只改当前这一条。";

  return (
    <div className="ss-page as-page" data-part="panel" role="dialog" aria-label="外观 · 她的样子">
      <header className="ss-top">
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="返回">
          <Icon d={ICON.back} size={18} />
        </button>
        <div className="ss-title">
          <b>外观 · 她的样子</b>
          <span>头像 / 聊天背景 / 作用域 · 只存本机</span>
        </div>
        <span className="ss-badge">
          <i />
          {customFace ? "相册" : "预设"}
        </span>
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="关闭">
          <Icon d={ICON.close} size={16} />
        </button>
      </header>

      <div className="ss-body">
        {note && (
          <p className="as-banner as-noteBad" role="status">
            {note}
          </p>
        )}
        <section className="ss-card">
          <div className="ss-groupHead">
            <span>当前的脸</span>
            <span>全应用唯一</span>
          </div>

          <div className="as-faceRow">
            <img className="as-faceBig" src={face} data-herta-user="face" alt="她现在的样子" />
            <div className="as-faceMeta">
              <b>{customFace ? "相册里的这张" : "预设像"}</b>
              <small>
                换完之后，历史消息里的头像也跟着换——头像不进每条消息，全应用只存这一个值。
              </small>
            </div>
          </div>

          <div className="as-choices" role="group" aria-label="选头像">
            <button
              type="button"
              className={"as-choice" + (customFace ? "" : " on")}
              aria-pressed={!customFace}
              onClick={() => onChange({ avatar: "preset" })}
            >
              <img src={PRESET_FACE_SRC} alt="" />
              <span>预设像</span>
            </button>
            <button
              type="button"
              className={"as-choice" + (customFace ? " on" : "")}
              aria-pressed={customFace}
              disabled={picking !== null}
              onClick={() => onPickPhoto("avatar")}
            >
              {customFace ? <img src={settings.avatar} data-herta-user="face" alt="" /> : <span className="as-choicePlus">＋</span>}
              <span>{picking === "avatar" ? "读图中…" : "相册自选"}</span>
            </button>
          </div>
          <p className="ss-note">
            预设像是程序生成的一半调 H，不依赖立绘；相册那张会压到 320 像素只留在这台手机上。
          </p>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>聊天背景</span>
            <span>{scopeSession ? "这会话" : "全局"}</span>
          </div>

          <div className="as-bgGrid" role="group" aria-label="聊天背景">
            <button
              type="button"
              className={"as-bgTile" + (backgroundName === "none" ? " on" : "")}
              aria-pressed={backgroundName === "none"}
              onClick={() => onBackground("")}
            >
              <span className="as-bgSwatch" data-bg="none" aria-hidden="true" />
              <span>不设</span>
            </button>
            {BACKGROUND_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={"as-bgTile" + (backgroundName === preset.id ? " on" : "")}
                aria-pressed={backgroundName === preset.id}
                onClick={() => onBackground(preset.id)}
              >
                <span className="as-bgSwatch" data-bg={preset.id} aria-hidden="true" />
                <span>{preset.label}</span>
              </button>
            ))}
            <button
              type="button"
              className={"as-bgTile" + (backgroundName === "custom" ? " on" : "")}
              aria-pressed={backgroundName === "custom"}
              disabled={picking !== null}
              onClick={() => onPickPhoto("background")}
            >
              <span className="as-bgSwatch as-bgSwatchCustom" aria-hidden="true">
                {backgroundName === "custom" ? <img src={background} alt="" /> : "＋"}
              </span>
              <span>{picking === "background" ? "读图中…" : "相册自选"}</span>
            </button>
          </div>

          <p className="ss-note">
            预设是程序画的，不占包体；相册图压到 1080 像素、只存在这台手机上，深色下会自己加一层暗罩。
          </p>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>背景作用域</span>
            <span>{scopeSession ? "session" : "global"}</span>
          </div>
          <div className="as-scopeRow">
            <span className="ss-rowMain">
              <b>这张背景管到哪儿</b>
              <small>全局 = 所有会话；按会话 = 只改当前这一条，新会话继承全局。</small>
            </span>
          </div>
          <div className="ss-seg as-scopeSeg" role="group" aria-label="背景作用域">
            <button
              type="button"
              className={scopeSession ? "" : "on"}
              aria-pressed={!scopeSession}
              onClick={() => onChange({ backgroundScope: "global" })}
            >
              全局
            </button>
            <button
              type="button"
              className={scopeSession ? "on" : ""}
              aria-pressed={scopeSession}
              disabled={!sessionId}
              onClick={() => onChange({ backgroundScope: "session" })}
            >
              按会话
            </button>
          </div>
          <p className="ss-note">{scopeHint}</p>
        </section>

        <p className="ss-hint">
          只在这里改；主题仍是设置里那个（这一批没动主题系统）。顶栏点头像也是进设置。
        </p>
      </div>
    </div>
  );
}
