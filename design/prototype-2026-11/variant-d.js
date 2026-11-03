
/* 方向 D · 最终选择
 * A 的玻璃工作台骨架 + A 的播报 / 开屏 + C 的夜间 token。
 * 这不是第四个激进方向，是「A 的日常 + C 的夜」这一版。
 */
(function () {
  const HP = window.HP;
  const A = window.VARIANTS.A;
  const icon = HP.icon;

  const META = {
    chat: ["黑塔", "凌晨 02:14 · 实验舱"],
    sessions: ["会话", "42 条 · 1,208 块"],
    memory: ["记忆", "NMS · 58 节点 · 67 边"],
    coin: ["黑塔币", "HTC/USDT · 交易中"],
    broadcast: ["星际和平播报", "第 17 期 · 11-03"],
    settings: ["设置", "本机 · 不上传"],
    caps: ["她能做什么", "6 / 9 项开着"],
    import: ["导入", "DeepSeek 分享链接"],
    backup: ["备份与迁移", "18.4 MB"],
    tools: ["工具调用", "今天 9 次"],
    onboarding: ["开屏", "首次启动"],
    system: ["设计系统", "D · 混合推荐"],
  };

  function themeBtn() {
    return `<button class="a-themeBtn" data-theme-toggle aria-label="切换日间 / 夜间"><span data-theme-label>夜</span></button>`;
  }

  function top(screen) {
    const m = META[screen] || META.chat;
    return `<header class="a-top">
      <button class="a-iconBtn" data-screen="sessions" aria-label="打开会话">${icon("sessions", 18)}</button>
      <div class="a-title"><b>${m[0]}</b><span>${m[1]}</span></div>
      <div class="a-topRight">
        <span class="a-presence"><i></i>${HP.herta.mood}</span>
        ${themeBtn()}
        <button class="a-avatarBtn" data-screen="settings" aria-label="设置">${HP.avatar("a-avatar")}</button>
      </div>
    </header>`;
  }

  function rail(screen) {
    return `<input type="checkbox" id="dRail" class="d-railCheck" />
      ${A.rail(screen)}
      <label for="dRail" class="d-railHandle" aria-label="收起或展开左轨"></label>`;
  }

  function appearanceNote() {
    return `<div class="d-appearance">
      <span>外观</span>
      <button data-theme-toggle><span data-theme-state>关</span> 夜间模式</button>
      <button data-screen="broadcast">播报 →</button>
    </div>`;
  }

  function dSystem() {
    return `<div class="a-page">
      <div class="a-card a-dsHead">
        <div class="a-importKicker">FINAL · D</div>
        <h2>A 的日常 + C 的夜</h2>
        <p>这是你拍板的版本：播报和开屏回到 A，夜间用 C 的深空 / 青色 token。布局不换，只换外观。</p>
      </div>
      <div class="a-card">
        <div class="a-cardHead"><div><h3>组合规则</h3><p>三句话就能说清</p></div><span class="a-mono">D</span></div>
        <div class="d-rule"><b>骨架</b><span>A 的左轨、对话、记忆、黑塔币、设置</span></div>
        <div class="d-rule"><b>播报 / 开屏</b><span>A 的信息流与玻璃封面；不再用 B 的报纸 / 书封</span></div>
        <div class="d-rule"><b>夜</b><span>C 的深空底 / 青色信号，只换 token</span></div>
      </div>
      <div class="d-demoRow">
        <button class="a-btn a-btnInk" data-theme-toggle><span data-theme-label>夜</span>色预览</button>
        <button class="a-btn a-btnGhost" data-screen="broadcast">打开 A 的播报</button>
        <button class="a-btn a-btnGhost" data-screen="onboarding">打开 A 的开屏</button>
      </div>
      <div class="a-card a-voiceCard">
        <div class="a-cardHead"><div><h3>左轨可以收</h3><p>点左轨右缘的小把手；收起后剩 12px。</p></div><span class="a-mono">12px</span></div>
        <p>这是 D 唯一改结构的地方：把 58px 的左轨压成 12px 的把手，解决 390 宽下正文区只剩 332 的问题。展开后仍是 A 的左轨。</p>
      </div>
      <p class="a-hintLine">D 是最终选择；正式落地按规范文档接进 App.tsx。</p>
    </div>`;
  }

  function render(screen) {
    let body;
    if (screen === "system") body = dSystem();
    else if (screen === "settings") body = A.screens.settings() + appearanceNote();
    else body = A.screens[screen] ? A.screens[screen]() : A.screens.chat();
    return `<div class="variantRoot d-root a-root">
      <div class="a-app">
        ${rail(screen)}
        <main class="a-main">
          ${top(screen)}
          <section class="a-body ${screen === "chat" ? "a-bodyChat" : ""}">${body}</section>
        </main>
      </div>
    </div>`;
  }

  function mount(screen) {
    const root = document.querySelector(".d-root");
    const dark = !!(root && root.classList.contains("is-dark"));
    if (screen === "memory") {
      const theme = dark
        ? {
            grid: "rgba(110,231,255,.08)", axis: "#6f8ea3", up: "#ff6b7d", down: "#57e3b2",
            line: "#6ee7ff", ring: "rgba(110,231,255,.09)", edge: "#2f8fa8",
            nodeRing: "rgba(6,16,24,.9)", label: "#9fc7d8",
            tier: { ep: "#6ee7ff", sem: "#7dffc4", note: "#ffb86b" }, glow: true,
          }
        : {
            grid: "rgba(17,20,23,.06)", axis: "#717984", up: "#d96a7a", down: "#4f9d8a",
            line: "#2f7d92", ring: "rgba(17,20,23,.07)", edge: "#2f7d92",
            nodeRing: "rgba(255,255,255,.9)", label: "#3b4350",
            tier: { ep: "#2f7d92", sem: "#2563eb", note: "#b5873f" },
          };
      HP.charts.drawNetwork(document.getElementById("aNet"), theme, { labels: 3 });
    }
    if (screen === "coin") {
      const theme = dark
        ? { grid: "rgba(110,231,255,.08)", axis: "#6f8ea3", up: "#ff6b7d", down: "#57e3b2", line: "#6ee7ff", badgeBg: "#6ee7ff", badgeInk: "#041016" }
        : { grid: "rgba(17,20,23,.06)", axis: "#717984", up: "#d96a7a", down: "#4f9d8a", line: "#2f7d92", badgeBg: "#2f7d92", badgeInk: "#fff" };
      HP.charts.drawCandles(document.getElementById("aKline"), theme, { axisLabels: true, badge: true });
    }
  }

  window.VARIANTS = window.VARIANTS || {};
  window.VARIANTS.D = {
    key: "D",
    name: "选定稿",
    en: "A + C",
    tagline: "A 的日常 + C 的夜：播报和开屏保持 A，夜间只换 token。给「现在就能往下做」的那一版。",
    bullets: [
      "骨架：A 的左轨、对话、记忆、黑塔币、设置不动",
      "播报 / 开屏：A 的信息流与玻璃封面，不用 B 的报纸 / 书封",
      "夜：C 的深空底 / 青色信号，只换 token 不换布局",
      "左轨可收成 12px 把手；这是 D 唯一改结构的地方",
    ],
    trade: "适合：直接按 A 落地，再把 C 的夜间接进来。",
    note: "这是选定稿；正式落地按规范文档接进 App.tsx。",
    render: render,
    mount: mount,
  };
})();
