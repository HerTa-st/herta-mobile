// 站点配置：换链接只改这里
window.HERTA_SITE = {
  // 飞书表单：收集反馈
  feedback: "https://mar530jpjrc.feishu.cn/share/base/form/shrcncOFTKF6oBtooLdJHb0Czhc",

  // 备用下载：按顺序显示。留空数组时首页那一行自动隐藏。
  mirrors: [
    { name: "蓝奏云", url: "https://wwamv.lanzoul.com/iHKc44et5ngh", code: "bqyf" },
    { name: "夸克网盘", url: "https://pan.quark.cn/s/c3789bbbb156?pwd=J4hR", code: "J4hR" }
  ],

  // 飞书查询页：查提交过的反馈进度
  feedbackQuery: "https://mar530jpjrc.feishu.cn/share/base/query/shrcnHzr1qR3aKMfHLkGjzUcPVe",

  // 仓库与安装包：页面上的 GitHub / 下载按钮都从这里取
  repo: "https://github.com/HerTa-st/herta-mobile",
  download: "https://github.com/HerTa-st/herta-mobile/releases/latest/download/Herta.apk",

  // 黑塔币共享市场接口（只读；首页「全服行情」用它）
  coinApi: "https://coin-api-pbnumpqkfu.cn-hangzhou.fcapp.run"
};
