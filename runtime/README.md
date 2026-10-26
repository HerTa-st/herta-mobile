# runtime/

别动这个目录。里面两份东西是一对：

- `prompts-code.zh.mjs` —— 桌面版 196 个提示词/校验函数原文（acorn 从 `app.asar` 按 AST 切出，未改写）
- `dream-io.mjs` —— 它的"磁盘"：内存虚拟文件系统，顶替桌面版的 fs

前者第 52 行硬编码 `from '../runtime/dream-io.mjs'`，所以两兄弟必须保持这个相对位置。

它们**不在** `assets/` 里：`assets/` 是 vite 的 publicDir（会被整份摊到站点根），
而这两份只能当模块被 bundler 处理——摊进 dist 当静态文件等于白背 805KB。

重新生成 `prompts-code.zh.mjs` 要跑旧仓库的 `tools/extract-code-prompts.mjs`（依赖本机的
`D:\Herta\resources\app.asar`）。桌面版更新后要重跑，否则她的语气会停在旧版本。
