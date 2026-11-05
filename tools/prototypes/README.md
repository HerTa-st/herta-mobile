# 原型生成脚本

这些脚本产出的图已经放进 `../docs/prototypes-2026-11/`。留在这里是因为**它们是那些图的出处**——想改密度、改字阶、改遮罩，改参数重跑即可，不用重画。

| 脚本 | 产出 | 用到哪 |
|---|---|---|
| `gen-launcher-icons.py` | 五档密度的桌面图标（legacy 方/圆标 + 自适应前景层） | `apps/phone/android/app/src/main/res/mipmap-*` |
| `gen-launcher-preview.py` | 图标三形态预览图 | 设计文档 |
| `gen-avatar-marks.py` | 六款头像标记（A 半调 H 被采用） | 预设像 |
| `gen-avatar-silhouette.py` | 从开屏 ASCII 半调素材裁的剪影头像（**已作废**，保留供比对） | — |
| `gen-splash-directions.py` | 开屏三方向（点阵显影 / 轨道窗口 / 终端开机，**已否**） | — |
| `gen-splash-vertical-flow.py` | 定稿：满屏竖流 + 交叉淡入主页 | 开屏 |
| `gen-coin-share.py` | 黑塔币持仓分享卡三态（盈利 / 空仓 / 破产） | 黑塔币 · 持仓分享卡 |

依赖：Python 3 + Pillow。字体走系统路径 `C:\Windows\Fonts`（consola / arialbd / arial）。

> 注：`gen-avatar-silhouette.py` 引用的是开屏素材 `segment-b-0.json`，那份素材已经不用了；脚本留下只作历史记录，跑不通是正常的。

> `gen-coin-share.py` 改数字改 `FIG`、改吐槽改 `QUIPS`，跑一次出三张。样本见 `docs/prototypes-2026-11/coin-share-*.png`。
