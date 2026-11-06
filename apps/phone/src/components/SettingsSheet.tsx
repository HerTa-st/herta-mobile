import { CHEAP_LIMITS } from "@herta/core";
import type { Settings } from "../settings.ts";
import type { StickerRecord } from "../storage.ts";
import "../styles/settings-suite.css";

/**
 * 设置：只留跨件事的全局项（就地原则）。
 *
 * 一件事的设置留在那件事的页面里：做梦 / 深睡 / 语气 → 记忆页；关注标签 / 提醒时间 → 播报页；
 * 会话管理 → 抽屉；相册 / 语音 / 文件 / 表情 → 她能做什么。
 */
const CAP_KEYS = [
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
] as const;

const ICON = {
  back: "M15 6l-6 6 6 6",
  close: "M6 6l12 12M18 6L6 18",
  chevron: "M9 6l6 6-6 6",
  caps: "M12 3l7 3v5c0 4.5-2.8 7.8-7 10-4.2-2.2-7-5.5-7-10V6zM9 12l2 2 4-4",
  backup: "M4 7l8-3 8 3v10l-8 3-8-3zM4 7l8 3 8-3M12 10v10",
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

/** 设置面板：只放跨件事的全局项。全部是本机状态，没有一处上传。 */
export function SettingsSheet({
  settings,
  onChange,
  onClose,
  mood,
  fileNames,
  stickers,
  onOpenCapabilities,
  onOpenToolLog,
  onOpenBackup,
  onReplayOnboarding,
  onOpenDesignSystem,
}: {
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
  onClose(): void;
  mood: string;
  /** 只用来显示「数据统计」里的数量，不在这里编辑。 */
  fileNames: string[];
  /** 同上：只数数，编辑在「她能做什么」。 */
  stickers: StickerRecord[];
  onOpenCapabilities(): void;
  onOpenToolLog(): void;
  onOpenBackup(): void;
  onReplayOnboarding(): void;
  onOpenDesignSystem(): void;
}) {
  const capCount = CAP_KEYS.filter((key) => settings[key]).length;
  const capHint = capCount > 0 ? capCount + " 项开着" : "全关着";

  return (
    <div className="ss-page" data-part="panel" role="dialog" aria-label="设置">
      <header className="ss-top">
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="返回">
          <Icon d={ICON.back} size={18} />
        </button>
        <div className="ss-title">
          <b>设置</b>
          <span>本机 · 不上传</span>
        </div>
        <span className="ss-badge">
          <i />
          {mood || "平静"}
        </span>
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="关闭设置">
          <Icon d={ICON.close} size={16} />
        </button>
      </header>

      <div className="ss-body">
        <section className="ss-card ss-profileCard">
          <img className="ss-avatar" src="/herta.png" alt="黑塔" />
          <div className="ss-profileMain">
            <b>黑塔</b>
            <span>herta · 单人格 · 单记忆分区</span>
          </div>
          <span className="ss-badge">
            <i />
            本机
          </span>
        </section>

        <div className="ss-shortcuts">
          <button type="button" className="ss-shortcut" onClick={onOpenCapabilities}>
            <Icon d={ICON.caps} size={16} />
            <b>她能做什么</b>
            <small>{capHint}</small>
          </button>
        </div>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>外观</span>
            <span>theme</span>
          </div>
          <div className="ss-appearance">
            <div className="ss-rowMain">
              <b>主题</b>
              <small>
                夜间 = 轨道控制台（C）的深空底 / 青色信号；只换 token，不换布局。开屏的 ASCII
                白底保持不动。
              </small>
            </div>
            <div className="ss-seg" role="group" aria-label="外观">
              {(["system", "light", "dark"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={settings.theme === t ? "on" : ""}
                  aria-pressed={settings.theme === t}
                  onClick={() => onChange({ theme: t })}
                >
                  {t === "system" ? "跟随系统" : t === "light" ? "日间" : "夜间"}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>连接</span>
            <span>6 项</span>
          </div>
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>API Key</b>
              <small>只存本机；备份包不带</small>
            </span>
            <input
              className="ss-input"
              type="password"
              value={settings.apiKey}
              onChange={(e) => onChange({ apiKey: e.target.value.trim() })}
              placeholder="sk-..."
              autoComplete="off"
            />
          </label>
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>Base URL</b>
              <small>模型请求发往哪里</small>
            </span>
            <input
              className="ss-input"
              value={settings.baseUrl}
              onChange={(e) => onChange({ baseUrl: e.target.value.trim() })}
            />
          </label>
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>模型</b>
              <small>deepseek-flash 能看图；deepseek-v4-pro 只能读字</small>
            </span>
            <input
              className="ss-input"
              value={settings.model}
              onChange={(e) => onChange({ model: e.target.value.trim() })}
            />
          </label>
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>视觉模型（可选）</b>
              <small>主模型不收图时用来描述；翻相册也靠它</small>
            </span>
            <input
              className="ss-input"
              value={settings.visionModel}
              onChange={(e) => onChange({ visionModel: e.target.value.trim() })}
              placeholder="例如 deepseek-vl 或你服务商的多模态模型名"
            />
          </label>
          <label className="ss-row">
            <span className="ss-rowMain">
              <b>省 token 模式</b>
              <small>
                不判心情、不复核；历史压到 {CHEAP_LIMITS.contextBlocks} 块、记忆 ≤ {CHEAP_LIMITS.memorySeeds} 篇、长图 ≤{" "}
                {CHEAP_LIMITS.imagePieces} 段、工具 ≤ {CHEAP_LIMITS.toolRounds} 轮
              </small>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, flex: "none" }}>
              <input
                className="ss-input"
                style={{ width: 54 }}
                type="number"
                aria-label="每轮带多少块历史"
                title="每轮带多少块历史"
                disabled={settings.cheapMode}
                value={settings.contextBlocks}
                onChange={(e) => onChange({ contextBlocks: Number(e.target.value) || 24 })}
              />
              <input
                type="checkbox"
                className="ss-switch"
                checked={settings.cheapMode}
                onChange={(e) => onChange({ cheapMode: e.target.checked })}
              />
            </span>
          </label>
          {settings.cheapMode && (
            <p className="ss-note">
              每轮少两次请求（判心情、复核），上下文与长图也压小了。代价：她更容易跑题、记性更短，复核也拦不住她吹牛。
            </p>
          )}
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>黑塔币接口地址</b>
              <small>留空 = 打包时注入；改这里不用重打 APK</small>
            </span>
            <input
              className="ss-input"
              value={settings.coinApiBase}
              onChange={(e) => onChange({ coinApiBase: e.target.value.trim() })}
              placeholder="https://你的域名，例如 https://htc.example.com"
            />
          </label>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>数据</span>
            <span>本机</span>
          </div>
          <button type="button" className="ss-row ss-rowTap" onClick={onOpenBackup}>
            <span className="ss-rowMain">
              <b>备份与迁移</b>
              <small>打包随身、换机带走；API Key 不进包</small>
            </span>
            <span className="ss-rowValue">
              <Icon d={ICON.chevron} size={13} />
            </span>
          </button>
          <div className="ss-row">
            <span className="ss-rowMain">
              <b>数据统计</b>
              <small>
                {fileNames.length} 个文件 · {stickers.length} 张表情 · 全部只留在这台手机
              </small>
            </span>
          </div>
          <p className="ss-links" style={{ display: "flex", gap: 8, alignItems: "center", margin: "6px 2px 0", fontSize: 11, color: "var(--muted)" }}>
            <button type="button" className="ss-linkBtn" style={{ border: 0, background: "none", padding: 0, font: "inherit", color: "var(--accent)", cursor: "pointer" }} onClick={onOpenToolLog}>
              工具调用记录
            </button>
            <i>·</i>
            <button type="button" className="ss-linkBtn" style={{ border: 0, background: "none", padding: 0, font: "inherit", color: "var(--accent)", cursor: "pointer" }} onClick={onReplayOnboarding}>
              开屏与引导
            </button>
            <i>·</i>
            <button type="button" className="ss-linkBtn" style={{ border: 0, background: "none", padding: 0, font: "inherit", color: "var(--accent)", cursor: "pointer" }} onClick={onOpenDesignSystem}>
              设计系统
            </button>
          </p>
        </section>

        <p className="ss-hint">
          只放跨件事的全局项；一件事自己的设置（做梦、语气、播报时间、会话管理）都在那件事的页面里。
        </p>
      </div>
    </div>
  );
}