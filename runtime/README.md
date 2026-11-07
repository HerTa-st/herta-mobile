# runtime/

这里的硬依赖只有一对：`prompts-code.zh.mjs` 与 `dream-io.mjs`，**但只有后者进仓库**。

- `prompts-code.zh.mjs` —— 桌面版 196 个提示词/校验函数原文（acorn 从 `app.asar` 按 AST 切出，未改写）。
  **正文不入库**：824KB，且夹着私聊原文。已列进 `.gitignore`，clone 下来默认没有这个文件。
- `dream-io.mjs` —— 它的"磁盘"：内存虚拟文件系统，顶替桌面版的 fs。**这个必须留在仓库里。**
- `prompts-code.zh.d.mts` —— 只钉住我们真正调用的入口，纯类型、无正文，可以留在仓库里。

前者第 52 行硬编码 `from '../runtime/dream-io.mjs'`，所以两兄弟必须保持这个相对位置。

它们**不在** `assets/` 里：`assets/` 是 vite 的 publicDir（会被整份摊到站点根），
而这两份只能当模块被 bundler 处理——摊进 dist 当静态文件等于白背 824KB。

## 生成 prompts-code.zh.mjs

1. 在旧仓库（桌面版 Herta 仓库）跑 `node tools/extract-code-prompts.mjs`——它依赖本机的
   `<Herta-桌面端安装目录>\resources\app.asar`，产出 `runtime/prompts-code.zh.mjs`；
2. 把产物拷到本仓库 `runtime/prompts-code.zh.mjs`（必须与 `dream-io.mjs` 同目录）；
3. 桌面版更新后要重跑，否则她的语气会停在旧版本。

## 没有这个文件时会怎样

```
npm run typecheck   → 照过（apps/phone/src/prompts.ts 用 import.meta.glob 取它，不是静态 import）
npm test            → 照过：打印 [SKIP] 一行，core 的 5 条「桌面版原文」用例标 skip
                      （143 条里 138 过 / 5 skip / 0 失败）
npm run build:phone → 照过（Vite 只打一条 "did not match any files" warning），产物里没有这段 chunk
```

文件在的时候三者照旧：typecheck 过、5 条用例真跑、构建把原文单独打成一个按需加载的 chunk。

**发布前必须先生成**，否则发出去的包里没有原文——App 里复核与做梦会在用到的那一刻抛
「缺 runtime/prompts-code.zh.mjs」，正常聊天不受影响。
