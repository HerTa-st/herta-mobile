# 宣传站

多页静态站，无需构建：双击 index.html 就能看。

已上线：https://www.herta-st-gp.top/（2026-11-06 上传；裸域按你的要求不做）。

## 结构

    site/
      index.html          手机端 · 首屏 ASCII 竖流 + 四个模块 + 下载
      devs.html           开发人员 + 灵感与帮助
      sponsors.html       赞助名单 + 「我要赞助」弹层
      issues.html         已知问题 + 反馈入口
      404.html            站内 404（OSS 的 ErrorDocument 指向它）
      version.json        版本信息（当前页面还没读它）
      dsh/index.html      dsh-herta 插件站
      dsh/devs.html       插件站开发人员
      dsh/dsh.css         插件站专用样式
      assets/styles.css   全站共用样式
      assets/flow.js      首屏 ASCII 竖流
      assets/config.js    站点配置：反馈 / 查询 / 仓库 / 下载 / 网盘
      assets/feedback.js  把 data-* 占位链接渲染出来
      assets/stats.js     首页「全服行情」：读 coinApi（/api/daily + /api/leaderboard）
      assets/screens/     四张界面图 + 微信 / 支付宝收款码

## 部署到现有域名（2026-11-06 已执行）

域名与 bucket 已存在：www.herta-st-gp.top → 阿里云 OSS herta-st-gp（香港，公共读）。

1. 已把 site/ 的内容传到 bucket 根目录（index.html 落在 /）；README.md 和 _genqr.py 没传
2. 已开 OSS 静态网站托管：默认首页 index.html、子目录首页、ErrorDocument 404.html
3. 已确认未知路径（含 /dsh/ 下）都回落到站内 404
4. 裸域 herta-st-gp.top 按你的要求不做，只保留 www
5. HTTPS 证书已生效；续期时别忘

香港 bucket 免备案。

## 站内链接

所有外链只写在 assets/config.js：

- feedback / feedbackQuery —— 飞书表单 / 查询视图
- repo —— GitHub 仓库
- download —— GitHub Release 的 latest APK
- mirrors —— 蓝奏云 / 夸克备用下载
- coinApi —— 黑塔币共享市场接口（首页「全服行情」只读）

改完顶栏、页脚、已知问题页一起生效。没有配的链接会自动隐藏，不会出死链。

## 全服行情

首页的「全服行情」从 coinApi 读 /api/daily 与 /api/leaderboard，30 秒刷新；接口不通时整段隐藏。

现在能显示：HTC 价格 / 涨跌、今日成交量、场次、持仓榜前三（按持仓市值）。

还没有：在册总人数、按用户的净买入榜、全服播报期号。FC 的 /api/state 没暴露这些字段，要加得改 FC。

## 截图

assets/screens/app-*.png 是 780×1688 的界面图：

- app-chat.png / app-coin.png / app-broadcast.png 来自当前 Web 构建（对话 / 黑塔币 / 播报，示例数据）
- app-memory.png 来自 design/prototype-2026-11 的 D 选定稿（记忆网络）；Web 构建挂的是原生 SQLite，浏览器里 NMS 是空的，所以这一张先用设计稿渲染。等真机数据齐了再替换。

## 仍待办

- 记忆网络截图换成真机（当前是设计稿渲染）
- 赞助名单 JSON（未来远程读取）
