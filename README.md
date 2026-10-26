# herta-mobile

Herta 的手机端。**双模**：离线时她是自己（人格 / 叙述 / 记忆 / 做梦 / 基础工具，直连 DeepSeek）；连上 PC 时她还是她，但长出了 bash、工作区、板砖那一整套手。

外加一件事：**从 DeepSeek 官方把你说过的话搬进来**——没有官方导出接口，所以采集端在 PC 上（油猴脚本），手机只负责接收、归一、归档、消化。

- 设计决策与验收标准：[docs/设计-v1.md](docs/设计-v1.md)
- 代码分五包：`protocol`（三端共用的类型与消息）/ `core`（人格、叙述、记忆、工具循环）/ `apps/phone`（UI）/ `packages/gateway`（连 PC）/ `tools/userscript`（抓历史）

```bash
npm install
npm test          # core 的纯 Node 测试（吃不依赖浏览器的真素材）
npm run dev:phone # 浏览器里跑 UI
```

## 现状（v0.2.0，2026-10-26）

| 能力 | 状态 |
|---|---|
| 人格装配（自传 + 废案 + 设定 + 手机处境 + 输出契约） | ✅ 单测覆盖 |
| 双轨叙述解析（想 / 说），缺闭合标签也不会把心里话当台词 | ✅ 单测覆盖 |
| 复核（桌面版原文 `buildSupervisorPrompt` + 四步评分 + 最多打回两次） | ✅ 可开关 |
| 开局独白（36 篇 + 原声播放） | ✅ |
| 原生 HTTP 通道（HttpURLConnection 插件，绕开 CORS） | ✅ 已编译进 APK |
| 会话持久化（IndexedDB） | ✅ 关掉 App 再开，记录还在 |
| 多会话（列表 / 新建 / 切换 / 删除 / 自动标题） | ✅ |
| 撤回上一轮 | ✅ |
| 打断 | ✅ 留下已说出口的半句，不报错 |
| 类型检查 | ✅ `npm run typecheck`（打包脚本第一步就跑） |

下一步（M2）：记忆 / dream、图片、8 种心情、云端 TTS。

### 打 APK

```powershell
pwsh -File tools\build-apk.ps1
```

产物在 `apps/phone/android/app/build/outputs/apk/debug/app-debug.apk`，
也会拷一份到 `dist-apk/`。

脚本会先把依赖缓存指到仓库内 `.gradle-home`，因为这个工作区的沙箱不让写
gradle 默认的 `G:\gradle-home`（构建会死在 `.lck` 打开的权限上）。
换台机器：`-GradleHome` 指向任意一份解压好的 gradle 9.2.x。

### 装到手机

1. APK 拷过去点开（首次要放行「未知来源」）
2. 打开后点右上「设置」，填 DeepSeek API Key，Base URL 保持 `https://api.deepseek.com`
3. 顶部会显示「原生通道」——显示「浏览器通道」说明跑在浏览器里，不是 APK

## 素材

`assets/` 是从桌面版 Herta **原样搬来**的素材：自传、办公室设定、11 篇废案种子、41 条 .opus 原声、13 篇记忆语料、以及 `prompts-code.zh.mjs`（从 `app.asar` 按 AST 抽出的 196 个提示词/校验函数原文）。

**算法重写，素材不改**——她是谁由这些字节决定，不由代码决定。素材的授权边界见 dsh-herta 仓库的 `NOTICE.md` / `THIRD-PARTY.md`，本仓库沿用。
