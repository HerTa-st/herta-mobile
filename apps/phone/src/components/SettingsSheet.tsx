import { CHEAP_LIMITS, formatTokens } from "@herta/core";
import { faceSrc, type Settings } from "../settings.ts";
import type { StickerRecord } from "../storage.ts";
import { APP_VERSION } from "../theme/version.ts";
import { useEffect } from "react";
import { useUsageToday } from "../hooks/useUsageToday.ts";
import { useUpdate } from "../hooks/useUpdate.ts";
import { ensureUpdateChecked } from "../update/store.ts";
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
  onOpenAppearance,
  onOpenTheme,
  onOpenUsage,
  onOpenUpdate,
  onOpenSponsors,
  onOpenDevs,
  onOpenIssues,
  onOpenFeedback,
  themeName,
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
  onOpenAppearance(): void;
  onOpenTheme(): void;
  /** B14：用量明细整屏页（就地——用量属于「连接」这件事）。 */
  onOpenUsage(): void;
  onOpenUpdate(): void;
  /** B13：关于三页各自压栈，返回键回到这一层设置。 */
  onOpenSponsors(): void;
  onOpenDevs(): void;
  onOpenIssues(): void;
  /** 反馈走第三方表单（与网站同一条飞书链接），App 里不收集。 */
  onOpenFeedback(): void;
  /** 当前生效的主题名（"内置" 或已安装主题的显示名）。 */
  themeName: string;
}) {
  const usage = useUsageToday();
  const update = useUpdate();
  /** 进设置时顺手看一眼——六小时内不会再发请求（启动那一次已经强制拉过了）。 */
  useEffect(() => {
    void ensureUpdateChecked();
  }, []);
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
          <img className="ss-avatar" src={faceSrc(settings)} data-herta-user="face" alt="她现在的样子" />
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
          {/* 外观只有这一个入口：头像 / 聊天背景 / 作用域都在那一页，别把设置页撑回去 */}
          <button type="button" className="ss-row ss-rowTap" onClick={onOpenAppearance}>
            <span className="ss-rowMain">
              <b>她的样子</b>
              <small>头像与聊天背景 · 预设像 / 相册自选 · 全局或按会话</small>
            </span>
            <span className="ss-rowValue">
              <Icon d={ICON.chevron} size={13} />
            </span>
          </button>
          <button type="button" className="ss-row ss-rowTap" onClick={onOpenTheme}>
            <span className="ss-rowMain">
              <b>主题包</b>
              <small>{themeName} · 安装 / 切换 / 卸载 zip 主题（只改样式）</small>
            </span>
            <span className="ss-rowValue">
              <Icon d={ICON.chevron} size={13} />
            </span>
          </button>
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
            <span className="ss-tokenCtl">
              <input
                className="ss-input ss-inputNum"
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
          {/* B14：今日用量。数字来自接口回执，不涉及这次发出去的请求怎么写——只读。 */}
          <button type="button" className="ss-row ss-rowTap" onClick={onOpenUsage}>
            <span className="ss-rowMain">
              <b>今日用量</b>
              <small>输入 / 输出分开 · 含后台那些你看不见的调用 · 过零点清零</small>
            </span>
            <span className="ss-rowValue">
              {usage.calls > 0
                ? "入 " + formatTokens(usage.prompt) + " · 出 " + formatTokens(usage.completion)
                : "还没调用"}
              <Icon d={ICON.chevron} size={13} />
            </span>
          </button>
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
          <p className="ss-links">
            <button type="button" className="ss-linkBtn" onClick={onOpenToolLog}>
              工具调用记录
            </button>
            <i>·</i>
            <button type="button" className="ss-linkBtn" onClick={onReplayOnboarding}>
              开屏与引导
            </button>
            <i>·</i>
            <button type="button" className="ss-linkBtn" onClick={onOpenDesignSystem}>
              设计系统
            </button>
          </p>
        </section>

        {/* B13：最底部一组「关于」。版本号直接读打包时注入的那份，不在这里写死。 */}
        <section className="ss-card">
          <div className="ss-groupHead">
            <span>关于</span>
            <span>about</span>
          </div>
          <button type="button" className="ss-row ss-rowTap" onClick={onOpenSponsors}>
            <span className="ss-rowMain">
              <b>赞助名单</b>
              <small>按月的名单 · 换名单换码都不用发版</small>
            </span>
            <span className="ss-rowValue">
              <Icon d={ICON.chevron} size={13} />
            </span>
          </button>
          <button type="button" className="ss-row ss-rowTap" onClick={onOpenDevs}>
            <span className="ss-rowMain">
              <b>开发人员</b>
              <small>作者与每人负责哪块 · 取材自 / 点子来自</small>
            </span>
            <span className="ss-rowValue">
              <Icon d={ICON.chevron} size={13} />
            </span>
          </button>
          <button type="button" className="ss-row ss-rowTap" onClick={onOpenIssues}>
            <span className="ss-rowMain">
              <b>已知问题</b>
              <small>还没修的边界 · 反馈前先看一眼，能省一轮</small>
            </span>
            <span className="ss-rowValue">
              <Icon d={ICON.chevron} size={13} />
            </span>
          </button>
          <button type="button" className="ss-row ss-rowTap" onClick={onOpenFeedback}>
            <span className="ss-rowMain">
              <b>反馈</b>
              <small>第三方表单（飞书）· 能收截图，不用注册</small>
            </span>
            <span className="ss-rowValue">
              <Icon d={ICON.chevron} size={13} />
            </span>
          </button>
          <button type="button" className="ss-row ss-rowTap" onClick={onOpenUpdate} data-part="version-row">
            <span className="ss-rowMain">
              <b>
                版本号
                {update.verdict && <i className="ss-dot" aria-label="有新版本" role="img" />}
              </b>
              <small>
                {update.verdict
                  ? update.verdict.must
                    ? "这版不能再往后拖了，点开看"
                    : "有新版本了 · " + update.verdict.manifest.latest + "，点开看"
                  : "打包时从 version.json 注入，不另存一份"}
              </small>
            </span>
            <span className="ss-rowValue">
              {APP_VERSION}
              <Icon d={ICON.chevron} size={13} />
            </span>
          </button>
        </section>

        <p className="ss-hint">
          只放跨件事的全局项；一件事自己的设置（做梦、语气、播报时间、会话管理）都在那件事的页面里。
        </p>
      </div>
    </div>
  );
}