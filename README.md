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

## 素材

`assets/` 是从桌面版 Herta **原样搬来**的素材：自传、办公室设定、11 篇废案种子、41 条 .opus 原声、13 篇记忆语料、以及 `prompts-code.zh.mjs`（从 `app.asar` 按 AST 抽出的 196 个提示词/校验函数原文）。

**算法重写，素材不改**——她是谁由这些字节决定，不由代码决定。素材的授权边界见 dsh-herta 仓库的 `NOTICE.md` / `THIRD-PARTY.md`，本仓库沿用。
