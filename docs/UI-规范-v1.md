# Herta 手机端 UI 规范（v1 · 2026.11）

> 适用范围：<code>apps/phone</code> 的所有界面，以及以后新加的模块、卡片、开关、全屏页。
> 目的只有一句：**以后加功能，不许长出第四套界面。**
> 拍板结果：日常用 A（站内工作台），夜间用 C（轨道控制台）；播报与开屏保持 A，不用 B 的报纸 / 书封。

---

## 1. 四条原则

1. **只换 token，不换布局。** 浅色和深色共用同一套 DOM 与尺寸；主题只改变量、表面、图表色。
2. **一个模块只有一个入口。** 一级页进左轨，低频页进抽屉 / 设置；不要同一个功能同时挂三个入口。
3. **先有状态，再谈好看。** 每个新页面/卡片必须同时有：加载、空、错误、离线（如适用）、深色。缺一个就不算完成。
4. **手机端不预装记忆，但安装/升级不清理已有记忆。** <code>assets/memory</code> 留空，新装首次打开记忆库就是空的；老安装的 IndexedDB / NMS 原样保留，迁移、备份恢复都不删任何一条。

---

## 2. Token 唯一真源

颜色只允许写在 <code>apps/phone/src/styles.css</code>：

- 浅色：<code>:root { ... }</code>
- 深色：<code>:root[data-theme="dark"] { ... }</code>

组件里禁止写 <code>#fff</code>、<code>#111</code>、<code>rgba(255,255,255,...)</code> 这类表面色；文本用 <code>var(--ink)</code> / <code>var(--ink-soft)</code> / <code>var(--muted)</code>，表面用 <code>var(--card)</code> / <code>var(--field)</code>，线用 <code>var(--line)</code>。

### 2.1 颜色

| token | 浅色 | 深色（C） | 用途 |
|---|---|---|---|
| <code>--ink</code> | #111417 | #e6f7fc | 正文、标题 |
| <code>--ink-soft</code> | #3b4350 | #b6d0df | 强调正文、引导语 |
| <code>--muted</code> | #717984 | #8fadc2 | 元数据、说明 |
| <code>--line</code> | rgba(17,20,23,.08) | rgba(110,231,255,.14) | 描边、分隔 |
| <code>--card</code> | rgba(255,255,255,.62) | rgba(10,26,38,.72) | 卡面、抽屉、气泡 |
| <code>--mine</code> | #eceef0 | rgba(110,231,255,.10) | 你的气泡 |
| <code>--mine-ink</code> | #111417 | #e6f7fc | 你的气泡文字 |
| <code>--accent</code> | #2f7d92 | #6ee7ff | 主强调、选中态 |
| <code>--accent-ink</code> | #ffffff | #041016 | 强调底上的字 |
| <code>--sheet-bg</code> | rgba(248,251,253,.96) | rgba(8,20,30,.96) | 整屏页/大面板底 |
| <code>--field</code> | rgba(255,255,255,.7) | rgba(8,21,31,.82) | 输入框底 |
| <code>--shadow</code> | 0 12px 32px rgba(32,45,58,.045) | 0 12px 32px rgba(0,0,0,.24) | 浮层 |
| <code>--shadow-soft</code> | 0 8px 24px rgba(34,45,57,.08) | 0 8px 24px rgba(0,0,0,.28) | 卡面 |

**新增 token 的规则：** 浅色和深色必须同时加，并在本表登记；不允许只加浅色再靠组件里写死。

### 2.2 字体

- 中文：**打包的 Noto Sans SC**（`assets/fonts/NotoSansSC-VF.ttf`，`--app-font` 的 `Herta Sans`）。不跟随手机系统主题字体，避免同一份 UI 在不同机器上变成手写体/宋体。
- 拉丁：同一套 `--app-font` 兜底；组件不要自己写 `Inter, system-ui` 这类字体栈。
- 聊天正文 15/1.62；列表副文 12–13；元数据 10.5–12；标题 15–17。
- 播报标题也用 `--app-font`，不再引衬线；要引入衬线必须先登记，不能只在某个组件里写。
- 等宽只用于 token、价格、权重、时间；不用于整段正文。
- **加载顺序**：`main.tsx` 必须先 `import "./styles.css"`，再 import `App`。组件自己的 `styles/*.css` 必须排全局之后，否则同权重规则会被全局旧样式盖掉（字体、卡面、封面尺寸都会中招）。

### 2.3 间距、圆角、层级

- 4px 基准：4 / 8 / 12 / 16 / 20 / 24。
- 圆角：卡面 18，控件 10–14，胶囊 999；不新增 6/22/27 这类随手圆角。
- 厚度：<code>--line</code> 1px；浮层加 <code>--shadow</code> 或 <code>--shadow-soft</code>，不要两套阴影混用。
- z-index 只允许这几档：看图 50，黑塔币 55，播报 56，读原文 57，设置 60，开屏 90；新模块先申请档位，不要随手写 99。

---

## 3. 布局骨架

- **左轨**：58px，图标（H / + / 对话 / 记忆 / 播报 / 黑塔币 / 设置 / 更多）；会话标题不塞进左轨，放抽屉。
- **顶栏**：54px，菜单 + 「黑塔」+ 行踪副标题 + 心情胶囊 + 夜/日 + 头像；标题必须单行省略。
- **对话**：上下文条（记忆 / 复核 / 省 token + 时间）→ 日期线 → 消息；feed 滚动 + composer 固定在底部；键盘弹出时 composer 不能被顶掉。
- **整屏页**：<code>position: fixed; inset: 0;</code>，头部固定、主体自己滚；参考 <code>.coinView</code> / <code>.broadcastView</code> / <code>.bcrView</code>。
- **设置**：整屏 sheet，顶部吸顶；新增长项直接往下排，不要另起一套设置页。
- **弹层**：表情 / 附件 / 看图；不抢整屏页的 z-index。

新模块先选形态，再写代码：

1. 一级页 → 左轨入口 + 整屏页。
2. 低频页 → 抽屉或设置里的入口 + 整屏页或 sheet。
3. 页面内功能 → 卡面 / 行 / 开关，不要新开一层导航。
4. 临时选择 → 弹层，必须能点外部/返回关闭。

---

## 4. 组件规范

### 4.1 气泡与叙述

- 一条消息 = <code>.turn</code> + 头像 + <code>.bubble</code>；她左、你右。头像 28px，气泡圆角 18。
- 她：<code>.bubble.herta</code>，卡面 + 1px 线 + 18px 圆角；你的：<code>.bubble.user</code>，<code>--mine</code>。
- 想：<code>.thought</code>（想 + 正文）放在同一张卡里；**想永远不念、不伪装成说出口的话**。连续的 thought + speech 必须合成一张卡，不要两个头像、两个时间。
- 动作：文本开头括号里的动作拆成 <code>.action</code>，斜体、不念；没有动作就不占一行。
- 时间：<code>.bubbleTime</code> 等宽 8px，右下；用量 <code>UsageChip</code> 在正文下。
- 上下文条：<code>.chatContext</code>（记忆 / 复核 / 省 token + 时间），不要塞进顶栏。
- 输入区：<code>.composerQuick</code>（撤回 + Enter 提示）+ <code>.composerBar</code> + <code>.composerFoot</code>（本机 + 模型名）。
- <code>.composerBar</code> 固定 46px、<code>align-items:center</code>；发送键 34px、附件键 30px，三者必须同一中线，不许用底对齐。
- 工具旁白：<code>.note</code>，一行灰字；完整参数进工具记录，不刷聊天。
- 用量：<code>UsageChip</code>；失败/省 token 状态不能隐藏。
- 图片/长图：<code>Shot</code>；长图按宽度切片，气泡只放第一片缩略图。

### 4.2 按钮

| 类型 | 类 | 规则 |
|---|---|---|
| 主按钮 | <code>.coinBtnPrimary</code> 或模块主按钮 | 强调色底，<code>--accent-ink</code> 字；一屏最多一个 |
| 次按钮 | <code>.coinBtn</code> / <code>.sheetLink</code> | 透明/卡面底，线框 |
| 文字按钮 | <code>.bcAction</code> / <code>.link</code> | 无底，颜色用 muted/accent |
| 危险 | 删除类 | 红色 #c2596a（深浅色都可用） |
| 图标按钮 | 34–36px 圆/方 | 必须有 aria-label，热区 44px |

不要给按钮加渐变、阴影堆叠、第二种圆角；主按钮不要用绿色（她不是成功提示）。

### 4.3 输入

- 所有 input / textarea / select 必须有：<code>background: var(--field)</code>、<code>color: var(--ink)</code>、<code>border: 1px solid var(--line)</code>。
- focus 只允许青色 outline（深色 <code>rgba(110,231,255,.5)</code>）。
- 搜索框、昵称框、下单框用同一套；不要出现白底输入框在深色页上。
- 文件 input 单独处理，不套 <code>.coinIdentityInput</code>。

### 4.4 卡面与列表

- 卡面：<code>background: var(--card)</code>、<code>border: 1px solid var(--line)</code>、<code>border-radius: 18px</code>、<code>box-shadow: var(--shadow-soft)</code>。
- 列表行：标题 + 副文（muted）+ 右侧值/箭头；行高 ≥44；删除按钮与行分离。
- 空态：一句话 + 动作（如「重试」），不要空白屏。
- 错误：内容区内联显示，不用 toast 代替；保留重试。
- 加载：骨架或一行状态，不要只转圈把布局撑开。

### 4.5 开关与选择

- 开关用现有 checkbox / 胶囊样式；选中态用 <code>--accent</code>，不要新造滑动开关。
- 三选一（如外观）用 <code>.themeSeg</code>：跟随系统 / 日间 / 夜间；不要下拉。
- 多选标签用 <code>.bcTagChoice</code> 那类胶囊。

### 4.6 图表

- canvas 必须从 <code>document.documentElement.dataset.theme</code> 或传入主题读色，不能写死浅色。
- 深色下：网格 <code>rgba(110,231,255,.08)</code>，轴 #6f8ea3，涨 #ff6b7d，跌 #57e3b2，线 #6ee7ff。
- 切主题后图表要重绘；不要把 canvas 留成浅色。
- 空数据画空态，不画假曲线。

---

## 5. 夜间模式（C）

### 5.1 接入方式

- 设置字段：<code>settings.theme = "system" | "light" | "dark"</code>（<code>settings.ts</code>）。
- 解析后写到 <code><html data-theme="dark|light"></code>（<code>App.tsx</code> effect）。
- <code>index.html</code> 在 CSS/React 前先读 localStorage + 系统偏好，避免首帧闪白。
- 顶栏的「夜 / 日」是快捷开关；设置里的三选一是完整入口。

**实现位置（改之前先看这里）：**

| 位置 | 作用 |
|---|---|
| <code>apps/phone/src/settings.ts</code> | <code>theme: "system" \| "light" \| "dark"</code>，默认 <code>system</code> |
| <code>apps/phone/src/App.tsx</code> | 解析主题、写 <code>data-theme</code>、顶栏夜/日 |
| <code>apps/phone/index.html</code> | 首帧前读 localStorage，避免闪白 |
| <code>apps/phone/src/styles.css</code> | 浅色 <code>:root</code> 与深色 <code>:root[data-theme="dark"]</code> |
| <code>apps/phone/src/coin/chart.ts</code> | 行情浅色 / 深色两套 canvas 配色 |
| <code>apps/phone/src/nms/NmsScreen.tsx</code> | 整屏页背景 / 输入用 token |
| <code>apps/phone/src/nms/network/network-canvas.tsx</code> | 网络标签从 <code>--ink</code> / <code>--accent</code> 取色 |

### 5.2 硬规则

1. **布局不许变。** 深色不隐藏左轨、不改字号、不改卡片顺序。
2. **表面走 token。** 新组件如果写了 <code>background: #fff</code>，深色就一定坏。
3. **输入/图表/空态必须单独检查。** 这三处最容易漏。
4. **开屏固定白底。** <code>.opening</code> 是 ASCII 半调，夜间也不反色；它是「启动时的白光」，不是主题的一部分。
5. **照片/表情不反色。** 不套滤镜，不用 mix-blend-mode。
6. **内联样式尽量用 var。** 非要用内联，写 <code>var(--field)</code>，不要写死。

### 5.3 自测口令

在浏览器控制台：

    document.documentElement.dataset.theme = "dark"
    document.documentElement.dataset.theme = "light"

或设置里点「夜间 / 日间」。至少检查：对话、设置、黑塔币、播报、记忆、抽屉、开屏。

---

## 6. 新模块接入清单（复制到 PR / issue）

新增一个功能模块时，逐条打勾；缺一项就不合并：

- [ ] 形态选对：一级页 / 低频页 / 页面内卡 / 弹层，入口 ≤2 次点击。
- [ ] 组件文件放在 <code>apps/phone/src/components/</code>，模块逻辑放 <code>src/&lt;module&gt;/</code>；不往 <code>App.tsx</code> 里再塞一百行 JSX。
- [ ] 有页面头：标题、返回/关闭、可选右侧动作。
- [ ] 有滚动主体；键盘弹出、safe-area、长屏 360/390/412 不横向溢出。
- [ ] 有加载 / 空 / 错误 / 离线（如适用）四种状态。
- [ ] 浅色与深色都看过；没有新增硬编码表面色。
- [ ] 输入框用 <code>var(--field)</code>；图表用主题色并重绘。
- [ ] 所有图标按钮有 aria-label；触控目标 ≥44×44；正文对比度 ≥4.5:1。
- [ ] 文案用她的语气：「她」不叫「助手」，不用成功学词，不冒充记录。
- [ ] <code>npm run typecheck</code> 通过；相关测试通过。
- [ ] 截两张图（日/夜）贴进 PR；改样式的话附完整页截图，不只截局部。
- [ ] 在本规范第 7 节登记新组件/新 token；没有登记就不算完成。

---

## 7. 最小骨架

### 7.1 整屏页组件

    // apps/phone/src/components/ExampleView.tsx
    export function ExampleView({ onClose }: { onClose(): void }) {
      return (
        <section className="exampleView">
          <header className="exampleHead">
            <button className="exampleBack" type="button" onClick={onClose} aria-label="返回">
              ←
            </button>
            <span className="exampleTitle">示例</span>
          </header>
          <div className="exampleBody">
            <p className="exampleEmpty">还没有内容。</p>
          </div>
        </section>
      );
    }

### 7.2 样式

    .exampleView {
      position: fixed;
      inset: 0;
      z-index: 58; /* 按第 2.3 节申请档位 */
      display: flex;
      flex-direction: column;
      background: var(--sheet-bg);
      color: var(--ink);
    }
    .exampleHead {
      flex: none;
      display: flex;
      align-items: center;
      gap: 8px;
      height: 54px;
      padding: 0 14px;
      background: var(--card);
      border-bottom: 1px solid var(--line);
    }
    .exampleTitle { flex: 1; font-weight: 600; color: var(--ink); }
    .exampleBody { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 24px; }
    .exampleEmpty { color: var(--muted); font-size: 13px; }

### 7.3 接入 App

- 在 <code>App.tsx</code> 加一个布尔状态（沿用现有模式，暂不引 router）。
- 在左轨或抽屉加入口；整屏页用 <code>{showExample && &lt;ExampleView onClose={() =&gt; setShowExample(false)} /&gt;}</code>。
- 返回键先关整屏页，再关抽屉；不要用「再按一次退出」。

---

## 8. 评审与验收

每次 UI 改动至少：

1. <code>npm run typecheck</code>（在 <code>herta-mobile</code> 根目录）。
2. <code>npm test</code>（纯 Node 核心/币/播报测试；不要求浏览器）。
3. 390×844 截图：日间 + 夜间；涉及全屏页的附整页。
4. 检查一遍第 6 节清单。
5. 如果改了 <code>styles.css</code> 的 token，确认浅色没有回归（尤其玻璃卡与气泡）。

**Review 时最容易被退回的三件事：**

- 深色下出现白底输入框 / 白底卡片。
- 新模块没有空态或错误态。
- 用了 B 的报纸 / 书封或 C 的坞，混进日常 A 的壳里。

---

## 9. 反例（看到就改）

- 组件里写 <code>background: #fff</code>、<code>color: #111</code>、<code>border: 1px solid #eee</code>。
- 给新页面加一套新的圆角 / 新字体 / 新阴影。
- 深色下用 <code>filter: invert</code> 或给真人照片套反色。
- 把二级 sheet 当成一级页，或者一级页又套一层 sheet。
- 用 toast 代替内联错误；用假数据填空态。
- 在 <code>App.tsx</code> 里堆 500 行新模块 JSX。
- 不跑 typecheck 就截图。

---

## 10. 模块清单与实现位置

| 模块 | 组件 | 样式 | 壳 |
|---|---|---|---|
| 对话 | <code>App.tsx</code> | <code>styles.css</code>（.turn / .bubble / .composer*） | rail 58 + top 54 |
| 会话 / 导入 | <code>components/Drawer.tsx</code> | <code>styles/sessions.css</code> | workspace 内，top 54 |
| 记忆 NMS | <code>nms/NmsScreen.tsx</code> | <code>styles/nms.css</code> | workspace 内，页头 54 |
| 黑塔币 | <code>components/CoinView.tsx</code> | <code>styles/coin.css</code> | workspace 内，页头 54 |
| 播报 | <code>components/BroadcastView.tsx</code> | <code>styles/broadcast.css</code> | workspace 内，页头 54 |
| 设置 / 能力 / 备份 / 工具 | 四个 Sheet 组件 | <code>styles/settings-suite.css</code>（.ss-*） | fixed + left 58，页头 54 |
| 开屏 / 引导 | <code>components/Onboarding.tsx</code> | <code>styles/onboarding.css</code>（.onboard*） | 全屏，首启 |
| 启动 ASCII | <code>components/Splash.tsx</code> | <code>styles.css</code> | 固定白底，不随主题 |

**新模块要么复用上表的壳，要么先在本表登记新壳；不允许第三种 rail / 页头 / 卡面。**

---

## 11. 变更记录

- 2026.11：首版。拍板 A 日常 + C 夜间；播报/开屏保持 A；新增 <code>theme</code> 设置、顶栏夜/日、<code>[data-theme="dark"]</code> token、NMS/黑塔币/播报/设置的深色覆盖。
- 2026.11：主界面按 prototype A 重做：左轨 58、顶栏（黑塔 / 行踪 / 心情 / 夜日 / 头像）、上下文条、<code>.turn</code> 气泡与 thought/speech 合卡、动作斜体、输入条 quick/foot。
- 2026.11：全部模块搬入同一套壳：会话抽屉、记忆 NMS、黑塔币、播报、设置套件（设置/能力/备份/工具）、开屏引导；每块有独立 <code>styles/*.css</code>，rail 58 与页头 54 保持一致。
- 2026.11：去掉手机端随包预装的 4 篇「废案」记忆。启动不再 seed；**安装/升级不清理已有记忆**，旧 IndexedDB / NMS / 备份原样保留。
- 2026.11：字体固定为打包的 Noto Sans SC（`--app-font`），不再跟随手机系统主题字体；修正 CSS 加载顺序（全局先于模块），并修播报报头重复、来源列挤压、封面过大、标题截断。
- 2026.11：输入条改为垂直居中（原来继承 `align-items:flex-end`，回形针/表情/发送键贴底，看起来错位）。
