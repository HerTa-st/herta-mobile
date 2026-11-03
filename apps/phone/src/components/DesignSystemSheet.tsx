/**
 * 设计系统：只读一页，给「以后加功能的人」对样用。
 * 从「设置 · 界面 · 设计系统」进；不占一级入口，不写库、不联网、不打点。
 * 颜色/字阶/圆角只做展示，真源在 styles.css 的 :root 与 :root[data-theme="dark"]。
 */
import "../styles/settings-suite.css";
import "../styles/design-system.css";

const COLORS: { token: string; name: string; use: string }[] = [
  { token: "--ink", name: "正文", use: "标题、正文" },
  { token: "--ink-soft", name: "二级墨", use: "强调正文、引导语" },
  { token: "--muted", name: "弱化", use: "元数据、说明" },
  { token: "--line", name: "线", use: "描边、分隔" },
  { token: "--card", name: "卡面", use: "卡片、抽屉、气泡" },
  { token: "--mine", name: "你的气泡", use: "你发的那句" },
  { token: "--accent", name: "强调", use: "选中、信号、链接" },
  { token: "--sheet-bg", name: "整屏底", use: "设置、整屏页" },
];

const TYPE: { name: string; size: string; sample: string; className?: string }[] = [
  { name: "显示", size: "25 / 1.2", sample: "黑塔", className: "ds-t-display" },
  { name: "页面标题", size: "18–20 / 1.3", sample: "星际和平播报", className: "ds-t-h1" },
  { name: "卡片标题", size: "15–16 / 1.4", sample: "第 17 期", className: "ds-t-h2" },
  { name: "正文", size: "14–15 / 1.7", sample: "她从这里往下说。", className: "ds-t-body" },
  { name: "元数据", size: "10–11", sample: "02:14 · 1.2k tok", className: "ds-t-meta" },
];

export function DesignSystemSheet({ onClose }: { onClose(): void }) {
  return (
    <div className="ss-page" role="dialog" aria-label="设计系统">
      <header className="ss-top">
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="返回">
          ←
        </button>
        <div className="ss-title">
          <b>设计系统</b>
          <span>D · 混合推荐</span>
        </div>
        <span className="ss-badge">
          <i />
          只读
        </span>
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="关闭设计系统">
          ✕
        </button>
      </header>

      <div className="ss-body">
        <section className="ss-card">
          <div className="ss-groupHead">
            <span>颜色</span>
            <span>token</span>
          </div>
          <div className="ds-swatches">
            {COLORS.map((c) => (
              <div className="ds-swatch" key={c.token} title={c.use}>
                <i style={{ background: `var(${c.token})` }} />
                <b>{c.name}</b>
                <code>{c.token}</code>
              </div>
            ))}
          </div>
          <p className="ss-note">只写在 styles.css：浅色 :root、深色 :root[data-theme="dark"]；组件里不许写死表面色。</p>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>字阶</span>
            <span>Noto Sans SC</span>
          </div>
          <div className="ds-type">
            {TYPE.map((t) => (
              <div className="ds-typeRow" key={t.name}>
                <span className="ds-typeName">{t.name}</span>
                <span className={"ds-typeSample " + (t.className ?? "")}>{t.sample}</span>
                <span className="ds-typeMeta">{t.size}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>圆角与厚度</span>
            <span>4px 基准</span>
          </div>
          <div className="ds-radiusRow">
            <i className="ds-radius card" />
            <span className="ds-typeMeta">卡面 18</span>
            <i className="ds-radius ctl" />
            <span className="ds-typeMeta">控件 10–14</span>
            <i className="ds-radius pill" />
            <span className="ds-typeMeta">胶囊 999</span>
          </div>
          <p className="ss-note">间隔只走 4 / 8 / 12 / 16 / 20 / 24；浮层只用 --shadow 或 --shadow-soft，不混用。</p>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>部件</span>
            <span>样例</span>
          </div>
          <div className="ds-parts">
            <div className="ds-bubble">她的话：气泡圆角 18，卡面 + 1px 线。</div>
            <div className="ds-bubble mine">你的话：--mine 底，右对齐。</div>
            <span className="ds-chip">
              <i />
              心情 · 平静
            </span>
            <div className="ds-btnRow">
              <button type="button" className="ds-btn primary">主按钮</button>
              <button type="button" className="ds-btn">次按钮</button>
            </div>
            <input className="ds-input" placeholder="输入框走 --field" readOnly />
          </div>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>组合规则</span>
            <span>D</span>
          </div>
          <div className="ds-rule">
            <b>骨架</b>
            <span>A 的左轨、对话、记忆、黑塔币、设置</span>
          </div>
          <div className="ds-rule">
            <b>播报 / 开屏</b>
            <span>A 的信息流与玻璃封面；不用 B 的报纸 / 书封</span>
          </div>
          <div className="ds-rule">
            <b>夜</b>
            <span>C 的深空底 / 青色信号，只换 token 不换布局</span>
          </div>
        </section>

        <p className="ss-hint">这页跟着当前主题走；深浅两套 token 一改，这里立刻能看出来。</p>
      </div>
    </div>
  );
}
