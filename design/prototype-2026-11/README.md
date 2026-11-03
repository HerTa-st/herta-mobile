# Herta 手机端 UI 原型 · 2026.11

**一次性原型，不是 production 代码。** 它只回答一个问题：手机端应该长什么样。

## 跑起来

    cd E:\deepseek工作区\HerTa\herta-mobile
    npm run prototype:ui

打开：

    http://127.0.0.1:5199/prototype-2026-11/index.html

用 ?variant=A|B|C|D 换版本（D 是选定稿：A 的日常 + C 的夜），用 ?screen=chat|sessions|memory|coin|broadcast|settings|caps|import|backup|tools|onboarding|system 跳模块，用 ?theme=dark 看 D 的夜间。键盘 ← / → 换版本，M 开模块索引。也可以直接双击 index.html（纯静态、无构建、无依赖）。

## 三个方向 + 一个选定稿

| key | 名字 | 一句话 |
|---|---|---|
| A | 站内工作台 Station Desk | 桌面玻璃工作区压进手机：左轨 + 玻璃卡 + 墨色文字 |
| B | 档案室 The Archive | 纸面、卷目、图版、印章；导航是翻页与索引 |
| C | 轨道控制台 Orbit Console | 深空底、青色信号、等宽读数；对话是频道 |
| D | 选定稿 A+C | A 的壳 + A 的播报/开屏 + C 的夜；左轨可收，主题可切 |

每个版本都覆盖 12 个模块：对话、会话与检索、记忆/NMS、星际和平播报、黑塔币、设置、她能做什么、导入、备份与迁移、工具调用、开屏与引导、设计系统。D 是默认版本，也是最终选择；播报和开屏用的是 A，夜间只换 C 的 token。打开页面点顶栏的「夜」，或在 URL 加 &theme=dark。

## 文件

    index.html        陈列页：设备框、方向说明、模块索引、底部切换条
    base.css          只属于原型陈列页的样式
    data.js           手写 mock 数据（会话 / 消息 / 记忆 / 行情 / 播报 / 设置 / 权限 / 工具 / 备份）
    charts.js         K 线、记忆网络、迷你走势（canvas，确定性数据）
    variant-a.js / b / c / d   三个方向的屏幕与外壳，以及 D 选定稿
    a.css / b.css / c.css / d.css  四个版本的样式（作用域锁在 .a-root / .b-root / .c-root / .d-root）
    app.js            URL 状态、方向/模块切换、键盘、只读提示

## 明确是假的

- 所有会话、行情、新闻、记忆、权限状态都是手写 mock，不来自任何接口。
- 所有按钮不写库、不联网、不调模型；点了会出「原型只读」提示。
- K 线与记忆网络是确定性假数据，只负责看清视觉结构。
- 字体用系统字体；桌面端真实字体是 Inter + 系统中文，Windows 上会略宽。
- 6.5–9px 的等宽小字是为了在 390 宽度里塞下信息密度，**不代表正式版的字号**；正式版元数据最小 10–11px，正文 14–15px。

## 已知边界

- 原型不是 App 路由，不参与 vite build，不打进 APK。
- B 的索引是纯 CSS checkbox 覆盖层，Escape 不会关它；点「关闭索引」或任意一卷会关。
- 手机上（窄屏）会把设备框去掉，并在底部留 56px 给原型切换条；正式版没有这条。
- D 的左轨收起只在当前页有效（原型没有把 rail 状态写进 URL）；重新渲染会恢复 58px。
- 没有做 RTL、横屏、系统字号放大、TalkBack 的完整验证；这些属于正式实现阶段的验收项。
