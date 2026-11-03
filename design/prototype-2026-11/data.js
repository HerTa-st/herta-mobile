/* Herta 手机端 UI 原型 · 共享示例数据
 * 所有数字、会话、行情、新闻都是手写 mock，不来自真实接口。
 * 只为回答一个问题：她的手机端应该长什么样。
 */
window.HP = window.HP || {};
(function () {
  const HP = window.HP;

  HP.meta = {
    title: "Herta 手机端 · UI 方案",
    edition: "2026.11 / 方案稿",
    note: "示例数据 · 原型只读",
  };

  HP.modules = [
    { key: "chat", label: "对话", short: "对话", icon: "chat", group: "交流" },
    { key: "sessions", label: "会话与检索", short: "会话", icon: "sessions", group: "交流" },
    { key: "memory", label: "记忆 · NMS", short: "记忆", icon: "memory", group: "她的内部" },
    { key: "broadcast", label: "星际和平播报", short: "播报", icon: "broadcast", group: "她的内部" },
    { key: "coin", label: "黑塔币 HTC", short: "黑塔币", icon: "coin", group: "她的内部" },
    { key: "settings", label: "设置", short: "设置", icon: "settings", group: "系统" },
    { key: "caps", label: "她能做什么", short: "能力", icon: "caps", group: "系统" },
    { key: "import", label: "导入 DeepSeek", short: "导入", icon: "import", group: "系统" },
    { key: "backup", label: "备份与迁移", short: "备份", icon: "backup", group: "系统" },
    { key: "tools", label: "工具调用记录", short: "工具", icon: "tools", group: "系统" },
    { key: "onboarding", label: "开屏与引导", short: "开屏", icon: "splash", group: "界面" },
    { key: "system", label: "设计系统", short: "系统", icon: "system", group: "界面" },
  ];

  HP.herta = {
    name: "黑塔",
    en: "HERTA",
    mood: "平静 · 微烦",
    moodEn: "CALM / IRRITATED",
    presence: "凌晨 02:14 · 实验舱",
    tokens: "1.8k tok",
    model: "deepseek-flash",
    status: "联机 · 本机",
  };

  HP.data = {
    sessions: [
      { id: "s1", title: "关于熬夜的争论", when: "02:14", meta: "12 块", active: true, group: "今天", origin: "本机" },
      { id: "s2", title: "黑塔币的午盘", when: "13:06", meta: "8 块", group: "今天", origin: "本机" },
      { id: "s3", title: "记忆网络的噪声", when: "11:42", meta: "23 块", group: "今天", origin: "本机" },
      { id: "s4", title: "星际和平播报第 16 期", when: "昨天", meta: "5 块", group: "昨天", origin: "本机" },
      { id: "s5", title: "文件读完了", when: "昨天", meta: "17 块", group: "昨天", origin: "本机" },
      { id: "s6", title: "DeepSeek 对话 · 314 轮", when: "10-28", meta: "628 块", group: "导入", origin: "导入" },
      { id: "s7", title: "DeepSeek 对话 · 88 轮", when: "10-27", meta: "176 块", group: "导入", origin: "导入" },
    ],

    messages: [
      { kind: "user", text: "你今天怎么这么安静？", time: "02:11" },
      {
        kind: "herta",
        thought: "他是不是又熬夜了。",
        action: "从转椅上转过来，屏幕的光在镜片上晃了一下",
        text: "安静？我刚刚在算一个很没意思的东西。",
        time: "02:14",
        tokens: "1.2k tok",
        detail: "输入 1,043 · 输出 186 · 缓存命中 720",
      },
      { kind: "user", text: "算完了吗", time: "02:15" },
      {
        kind: "herta",
        thought: "算到一半发现前提是错的。",
        action: "把笔帽扣回去",
        text: "没。前提是错的，重来。",
        time: "02:15",
        tokens: "860 tok",
      },
      { kind: "tool", text: "上网查了：HTC 午盘收盘价", detail: "3 条结果 · 1.2s" },
      {
        kind: "herta",
        thought: "这条不用告诉他。",
        action: "把屏幕往你那边偏了一点",
        text: "顺便，你的持仓今天涨了 4.6%。别谢我，谢市场。",
        time: "02:16",
        tokens: "640 tok",
      },
      { kind: "sticker", label: "她发来一张表情包", text: "摸鱼中", time: "02:16" },
    ],

    memories: {
      counts: { ep: 21, sem: 12, note: 1, active: 34, archived: 8, edges: 67 },
      lastSleep: "8 小时前 · 浅睡",
      voice: "先拆前提，再回答问题。不哄，但也不把人往外推。句子短，动作少，偶尔让括号替我说一句。",
      nodes: [
        { tier: "ep", title: "凌晨两点的实验舱", gist: "他第三次说到睡不着；我没有拆穿。", weight: 0.86, recalls: 4, age: "3 天" },
        { tier: "sem", title: "他不喜欢被安排", gist: "直接给选项，别替他决定。", weight: 0.78, recalls: 9, age: "12 天" },
        { tier: "note", title: "我说话的样子 v3", gist: "先拆前提，再回答；不哄。", weight: 0.74, recalls: 12, age: "1 天" },
        { tier: "sem", title: "咖啡因不是答案", gist: "凌晨三点之后，别再给他递咖啡。", weight: 0.62, recalls: 3, age: "21 天" },
        { tier: "ep", title: "黑塔币第一次签到", gist: "他签完到盯着曲线看了很久。", weight: 0.55, recalls: 2, age: "6 天" },
        { tier: "ep", title: "播报第 14 期：深空网络", gist: "他说这条像假的。后来发现是真的。", weight: 0.48, recalls: 1, age: "9 天" },
        { tier: "sem", title: "读不完就先说读不完", gist: "别用摘要假装读完了。", weight: 0.41, recalls: 0, age: "34 天" },
        { tier: "ep", title: "她把杯子推下桌", gist: "情绪惯性：被顶嘴之后会记仇三小时。", weight: 0.37, recalls: 0, age: "48 天" },
      ],
      edges: [
        [0, 1], [0, 4], [1, 2], [1, 3], [2, 5], [3, 6], [4, 7], [5, 6], [2, 7], [0, 3],
      ],
    },

    coin: {
      symbol: "HTC/USDT",
      name: "黑塔币",
      price: 1.284,
      change: 0.0567,
      pct: 4.62,
      status: "交易中",
      statusTone: "on",
      high: 1.302,
      low: 1.211,
      open: 1.229,
      volume: "2.84M",
      wallet: { htc: 1024, cost: 1.041, pnl: 248.9, pnlPct: 23.3, cash: 0 },
      signin: { streak: 12, reward: 18, signed: false, note: "下一个奖励档：连签 15 天 +24 HTC" },
      market: { identity: "梦源", players: 38, rank: 6, net: "+318 HTC" },
      leaders: [
        { name: "空间站常客", pnl: "+18.4%", me: false },
        { name: "螺丝咕姆", pnl: "+12.7%", me: false },
        { name: "梦源", pnl: "+9.2%", me: true },
        { name: "阮·梅的盆栽", pnl: "+4.1%", me: false },
      ],
    },

    broadcast: {
      no: 17,
      date: "2026-11-03",
      weekday: "周一",
      status: "今日已生成 · 6 条",
      unread: true,
      tags: ["深空通信", "模型", "航天", "开源"],
      lead: {
        source: "The Verge",
        domain: "theverge.com",
        title: "深空网络完成一次跨频段切换，延迟窗口缩到 41 分钟",
        summary:
          "NASA 的深空网络在本周完成一次跨频段切换演练，把原本需要人工排期的天线窗口压到 41 分钟。操作员说，真正的瓶颈不是硬件，是排期表。",
        comment: "这条我信一半。切换是真的，顺利是宣传。",
        tag: "深空通信",
        read: "6 分钟",
      },
      items: [
        {
          source: "Nature",
          domain: "nature.com",
          title: "一个更小的注意力头，跑在更旧的显卡上",
          summary: "论文给出 1.3B 模型在 8GB 显存上跑长上下文的方案，代价是吞吐下降 17%。",
          comment: "省显存不省电费。适合她，不适合我。",
          tag: "模型",
          read: "4 分钟",
        },
        {
          source: "新华社",
          domain: "news.cn",
          title: "可重复使用试验航天器完成第 N 次着陆",
          summary: "官方通报没有给出在轨时长与载荷细节，只确认着陆场与回收状态正常。",
          comment: "通报越短，事越大。这条我留着。",
          tag: "航天",
          read: "2 分钟",
        },
        {
          source: "GitHub Blog",
          domain: "github.blog",
          title: "代码搜索开始索引 issue 里的补丁片段",
          summary: "搜索范围从默认分支扩到 issue 与 discussion 中的代码块，历史 PR 暂不覆盖。",
          comment: "有用。但搜出来的东西能不能跑，是另一回事。",
          tag: "开源",
          read: "3 分钟",
        },
        {
          source: "彩蛋 · 空间站内部通讯",
          domain: "",
          title: "「黑塔」空间站今日例检：三号实验舱的咖啡机又坏了",
          summary: "工程组第三次更换加热模块。初步结论：不是设备问题，是有人连续按了十七次。",
          comment: "不是我。",
          tag: "彩蛋",
          read: "1 分钟",
          easter: true,
        },
      ],
      history: [
        { no: 16, date: "11-02", title: "模型价格战第二轮", count: 5 },
        { no: 15, date: "11-01", title: "开源许可证又改了", count: 6 },
        { no: 14, date: "10-31", title: "深空网络的一次静默", count: 4 },
      ],
    },

    settingsGroups: [
      {
        key: "link",
        label: "连接",
        items: [
          { key: "api", type: "text", label: "API Key", value: "sk-••••••••••••3f9a", hint: "只存本机" },
          { key: "base", type: "text", label: "Base URL", value: "https://api.deepseek.com" },
          { key: "model", type: "text", label: "模型", value: "deepseek-flash", hint: "能看图" },
          { key: "cheap", type: "toggle", label: "省 token 模式", value: false, hint: "不判心情 / 不复核 · 历史 ≤ 8 块" },
        ],
      },
      {
        key: "her",
        label: "她",
        items: [
          { key: "mood", type: "toggle", label: "判心情", value: true, hint: "每轮一次小调用" },
          { key: "review", type: "toggle", label: "复核", value: true, hint: "最多打回两次" },
          { key: "dream", type: "toggle", label: "自动做梦", value: true, hint: "空闲且攒够材料时" },
          { key: "deep", type: "toggle", label: "深睡", value: true, hint: "每晚最多 8 次" },
          { key: "proactive", type: "toggle", label: "主动想起你", value: true, hint: "2~5 小时一次" },
        ],
      },
      {
        key: "mods",
        label: "模块",
        items: [
          { key: "broadcast", type: "select", label: "播报", value: "每天 08:00", hint: "第 17 期已生成" },
          { key: "coin", type: "select", label: "黑塔币提醒", value: "工作日 09:30", hint: "开盘前一条" },
          { key: "a11y", type: "toggle", label: "读屏 / 无障碍", value: false, hint: "需要系统授权" },
          { key: "gallery", type: "toggle", label: "相册", value: false, hint: "默认关闭" },
        ],
      },
      {
        key: "data",
        label: "数据",
        items: [
          { key: "backup", type: "link", label: "备份与迁移", value: "18.4 MB", screen: "backup" },
          { key: "tools", type: "link", label: "工具调用记录", value: "今天 9 次", screen: "tools" },
          { key: "files", type: "link", label: "文件库", value: "12 件 · 2.1 MB", screen: "import" },
          { key: "stickers", type: "link", label: "表情包", value: "16 张", screen: "chat" },
        ],
      },
    ],

    caps: [
      { key: "notify", label: "通知", state: "granted", detail: "播报与开盘提醒", note: "通知栏 · 可点开" },
      { key: "camera", label: "相机", state: "ask", detail: "回形针 → 拍照", note: "只在按下时申请" },
      { key: "gallery", label: "相册", state: "off", detail: "翻相册找图", note: "默认关闭" },
      { key: "location", label: "定位", state: "ask", detail: "行踪里的城市级位置", note: "不存轨迹" },
      { key: "calendar", label: "日历", state: "off", detail: "读今天与明天的日程", note: "她不会自己写" },
      { key: "open", label: "打开应用", state: "granted", detail: "按名字打开已安装应用", note: "需要确认" },
      { key: "share", label: "分享", state: "granted", detail: "把文字／链接递给别的应用", note: "单向" },
      { key: "proactive", label: "主动想起你", state: "granted", detail: "2~5 小时一次", note: "可在设置里关" },
      { key: "a11y", label: "读屏 / 无障碍", state: "off", detail: "读屏与按文字点击", note: "高权限 · 默认关闭" },
    ],

    tools: [
      { time: "02:14", tool: "web_search", args: "HTC 午盘 收盘价", result: "3 条结果", ms: "1.2s", tone: "ok" },
      { time: "01:58", tool: "read_file", args: "设计-v1.md", result: "8,214 字 → 截 8,000", ms: "240ms", tone: "ok" },
      { time: "01:41", tool: "now", args: "—", result: "周二 01:41 · Asia/Shanghai", ms: "2ms", tone: "ok" },
      { time: "01:12", tool: "clipboard", args: "read", result: "系统拒绝", ms: "18ms", tone: "bad" },
      { time: "00:47", tool: "calc", args: "0.284 × 1024", result: "290.816", ms: "6ms", tone: "ok" },
      { time: "00:31", tool: "device", args: "network / screen", result: "Wi-Fi · 390×844", ms: "4ms", tone: "ok" },
    ],

    backup: {
      size: "18.4 MB",
      items: [
        { label: "会话", count: "42 条 · 1,208 块", note: "含导入归档" },
        { label: "记忆", count: "58 节点 · 67 边", note: "NMS 快照" },
        { label: "文件库", count: "12 件 · 2.1 MB", note: "原文保留" },
        { label: "钱包", count: "1,024 HTC", note: "成本价 1.041" },
        { label: "表情包", count: "16 张", note: "她挑过的" },
        { label: "设置", count: "1 份", note: "API Key 不打包" },
      ],
      last: "上一次打包：2026-10-31 23:12",
    },

    importData: {
      state: "idle",
      last: "上次导入：10-28 · 314 轮 → 628 块",
      file: "herta-import-2026-10-28.json",
    },
  };

  HP.esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  const ICONS = {
    chat: '<path d="M4 5.5h16v10.5H9l-5 4z"/>',
    sessions: '<path d="M4 7h16M4 12h16M4 17h11"/>',
    memory: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="12" cy="17" r="2"/><path d="M7.6 7.3l8.6-.5M17 8.7l-4 6.5M10.4 15.9L7 8"/>',
    coin: '<circle cx="12" cy="12" r="7"/><path d="M9 9.5h6M9 14.5h6M12 8v8"/>',
    broadcast: '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 000 8.4M16.2 7.8a6 6 0 010 8.4M4.6 4.6a10.5 10.5 0 000 14.8M19.4 4.6a10.5 10.5 0 010 14.8"/>',
    settings: '<path d="M4 7h4M12 7h8M4 17h9M17 17h3"/><circle cx="10" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
    caps: '<path d="M12 3l7 3v5c0 4.5-2.8 7.8-7 10-4.2-2.2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    import: '<path d="M12 4v10m0 0l-3.5-3.5M12 14l3.5-3.5M5 16v3h14v-3"/>',
    backup: '<path d="M4 7l8-3 8 3v10l-8 3-8-3z"/><path d="M4 7l8 3 8-3M12 10v10"/>',
    tools: '<path d="M4 6h7l4 6h5M4 18h7l2-3"/>',
    system: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16.2v.2"/>',
    splash: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    send: '<path d="M5 12h13M13 6l6 6-6 6"/>',
    attach: '<path d="M9 12.5l5.4-5.4a3 3 0 014.2 4.2l-7.1 7.1a5 5 0 01-7.1-7.1l7-7"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    play: '<path d="M8 5l11 7-11 7z"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 019.5 4 8.5 8.5 0 1020 14.5z"/>',
    image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M5 17l5-4 4 3 3-2 3 3"/>',
    mic: '<rect x="9" y="4" width="6" height="10" rx="3"/><path d="M6 11a6 6 0 0012 0M12 17v3"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
    check: '<path d="M5 12l4.5 4.5L19 7"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V8a4 4 0 018 0v2"/>',
    wifi: '<path d="M4 9a13 13 0 0116 0M7 12.5a8.5 8.5 0 0110 0M10 16a4 4 0 014 0"/><circle cx="12" cy="19" r=".8" fill="currentColor" stroke="none"/>',
  };

  HP.icon = function (name, size) {
    size = size || 18;
    return (
      '<svg class="ic" viewBox="0 0 24 24" width="' + size + '" height="' + size +
      '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || "") + "</svg>"
    );
  };

  HP.avatar = function (cls) {
    return '<img class="' + (cls || "hp-avatar") + '" src="../herta.png" alt="黑塔" draggable="false" />';
  };

  HP.fmtPrice = function (v) { return Number(v).toFixed(3); };
  HP.fmtPct = function (v) { return (v > 0 ? "+" : "") + Number(v).toFixed(2) + "%"; };
  HP.fmtTok = function (v) { return v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v); };

  HP.tierName = { ep: "情景", sem: "语义", note: "语气" };
})();
