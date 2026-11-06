# 开屏动画

## 现在这套（B9 · 竖流）

- `vertical-flow.json`（600 字节）——**只有参数，没有帧**：390×844 / CELL=7 /
  ramp `" .:-=+*#%@"` / 明暗两套配色 / 每列速度 0.6–2.4、拖尾 0.20–0.75 屏高。
- `vertical-flow.js` —— 播放器：把 `tools/prototypes/gen-splash-vertical-flow.py`
  的 `rain()` 搬成 JS，逐列水头 + 逐格密度实时算；字符预烘成图谱后逐格
  `drawImage`，不逐字 `fillText`。
- 掉帧时按 q0→q3 降档（降密度 → 隔列 → 锁 30fps），只降不升；当前档位写在
  `canvas.dataset.flowTune` 上，真机取证直接读。
- 演完由 `Splash.tsx` 把覆盖层淡出（600ms），底下主页一直在，不换页、不闪白。

参数改法：改 `gen-splash-vertical-flow.py` 顶部的常量，跑一遍，会同时更新
`_splash-flow/*.png`（原型）和这里的 `vertical-flow.json`。**别手改 JSON 又手改
Python**，两边一漂就对不上了。

## 旧的那套（2026-11-06 前的剪影开屏，保留待清）

- `ascii-renderer.js`、`opening-player.js`、`segment-b-0.json`（787KB）
  取自 `dsh-herta/theme/dsh-theme-herta/lib/opening/` 与 `lib/opening-segments/`。
- 新版跑稳一版后整组删掉；删之前整份备份在 `tools/opening-backup-2026-11/`。
- 旧版为什么在手机上要裁：段落是桌面 16:9（1908×1080），整张塞进手机只有 221px
  高，字符糊成灰点，于是按 `detail` 层包围盒裁一刀（`src/opening/crop-segment.ts`）。
  B9 起不再走这条剪影路，`cropSegmentToFigure` 已无人调用。

## 为什么放在 assets/（publicDir）而不是 src/

播放器是浏览器原生 ES 模块，用 `import(url)` 动态取；放进 `src/` 会让 TS 去
检查一份上游代码，还要处理类型声明。放这里，构建时原样拷进包，改参数也方便。
