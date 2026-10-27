# 开屏动画（原样取自 dsh-herta 主题）

- `ascii-renderer.js`、`opening-player.js`、`segment-b-0.json`
  取自 `dsh-herta/theme/dsh-theme-herta/lib/opening/` 与 `lib/opening-segments/`，
  **一行没改**。
- 授权沿用 `dsh-herta` 的 `NOTICE.md` / `THIRD-PARTY.md`。

## 为什么放在 assets/（publicDir）而不是 src/

播放器是浏览器原生 ES 模块，用 `import(url)` 动态取；放进 `src/` 会让 TS 去
检查一份上游代码，还要处理类型声明。放这里，构建时原样拷进包，改上游也方便。

## 手机上为什么要裁

段落是桌面 16:9（1908×1080）。整张塞进手机只有 221px 高，字符全糊成灰点。
`apps/phone/src/opening/crop-segment.ts` 按 `detail` 层（她本人）的包围盒裁一刀，
帧字节按保留格子重排、层名按连续段重登记——**逐帧数据是平铺字节数组，不能用
普通数组过滤糊弄**。

改段落或改渲染逻辑，请回 `dsh-herta` 主题仓库改，再把文件搬回来；这里不维护
第二份实现。
