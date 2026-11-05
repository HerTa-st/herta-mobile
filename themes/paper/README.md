# 纸面（paper）

官方示范主题，也是《主题作者规范》的参考实现。

- `skin.json` —— 身份证：id / 版本 / 最低 App 版本 / 契约版本
- `theme.css` —— 样式本体：亮暗两套配色 + 两条「token 层给不了」的覆盖（气泡直角细描边、左轨透明让纸纹透出）

## 怎么装

打成 zip（根目录直接放这两个文件）：

```powershell
Compress-Archive -Path skin.json, theme.css -DestinationPath paper.zip
```

然后把 zip 放到任何能直接下载的地方，在 App 里粘贴链接安装。

## 它验证了什么

| 规范条款 | 这份主题怎么用到 |
|---|---|
| 覆盖 CSS 变量 | 全部 13 个颜色变量，亮暗各一套 |
| 按锚点写选择器 | `[data-part="message-bubble"]`、`[data-part="rail"]`、`[data-part="app"]` |
| 不用 class 当唯一依赖 | 全文没有任何 `.xxx` 选择器 |
| 不覆盖用户设置 | 没碰头像 / 背景图 / 字体 |
| 离线可用 | 没有 `@import`、没有外链 `url()` |
