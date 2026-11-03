
/* 方向 C · 轨道控制台
 * 深空底、青色信号、等宽读数。把手机端当成空间站的一个终端：
 * 对话是频道，记忆是核心，黑塔币是交易台，播报是传输记录。
 */
(function () {
  const HP = window.HP;
  const D = HP.data;
  const esc = HP.esc;
  const icon = HP.icon;

  const DOCK = [
    { key: "chat", label: "通信" },
    { key: "sessions", label: "矩阵" },
    { key: "memory", label: "核心" },
    { key: "coin", label: "交易" },
    { key: "broadcast", label: "传输" },
  ];

  const HEAD = {
    chat: ["通信频道", "CH-01 / 直接通信"],
    sessions: ["频道矩阵", "42 条会话 · 1,208 块"],
    memory: ["记忆核心", "NMS · 58 节点 · 67 边"],
    coin: ["交易台", "HTC/USDT · 交易中"],
    broadcast: ["传输记录", "第 017 期 · 11-03"],
    settings: ["系统配置", "本机 · 不上传"],
    caps: ["能力矩阵", "6 / 9 ONLINE"],
    import: ["数据注入", "DeepSeek 分享链接"],
    backup: ["快照", "18.4 MB"],
    tools: ["事件流", "今天 9 次"],
    onboarding: ["启动序列", "BOOT / 0.30"],
    system: ["设计系统", "C · 轨道控制台"],
  };

  function head(screen) {
    const h = HEAD[screen] || HEAD.chat;
    return `<header class="c-head">
      <div><span class="c-kicker">${h[1]}</span><h1>${h[0]}</h1></div>
      <span class="c-headLed"><i></i>LIVE</span>
    </header>`;
  }

  function dock(screen) {
    const inDock = DOCK.some(function (d) { return d.key === screen; });
    return `<nav class="c-dock">
      <button class="c-dockMark" data-screen="sessions" aria-label="会话">H</button>
      ${DOCK.map(function (d) {
        return `<button class="c-dockBtn ${screen === d.key ? "on" : ""}" data-screen="${d.key}" aria-label="${d.label}" title="${d.label}">
          ${icon(d.key, 18)}<i></i>
        </button>`;
      }).join("")}
      <div class="c-dockSpacer"></div>
      <button class="c-dockBtn ${screen === "settings" ? "on" : ""}" data-screen="settings" aria-label="设置" title="设置">${icon("settings", 18)}<i></i></button>
      <button class="c-dockBtn ${!inDock && screen !== "settings" ? "on" : ""}" data-screen="sessions" aria-label="全部" title="全部">${icon("more", 18)}<i></i></button>
    </nav>`;
  }

  function toggle(on) {
    return `<span class="c-ledToggle ${on ? "on" : ""}"><i></i></span>`;
  }

  function msg(m) {
    if (m.kind === "user") {
      return `<div class="c-msg c-msgUser">
        <div class="c-msgMeta"><span>YOU</span><em>${m.time}</em></div>
        <div class="c-userText">${esc(m.text)}</div>
      </div>`;
    }
    if (m.kind === "tool") {
      return `<div class="c-toolLine"><span>TOOL</span>${esc(m.text)}<em>${esc(m.detail)}</em></div>`;
    }
    if (m.kind === "sticker") {
      return `<div class="c-msg c-msgHer">
        <div class="c-msgMeta"><span class="c-herTag">HERTA</span><em>${m.time}</em></div>
        <div class="c-herCard c-stickerMsg">
          <div class="c-stickerTile">摸鱼中</div>
          <span>${esc(m.label)}</span>
        </div>
      </div>`;
    }
    return `<div class="c-msg c-msgHer">
      <div class="c-msgMeta"><span class="c-herTag">HERTA</span><em>${m.time}</em>${m.tokens ? `<span class="c-tokMini">${esc(m.tokens)}</span>` : ""}</div>
      <div class="c-herCard">
        ${m.thought ? `<div class="c-thought"><span>// THOUGHT</span>${esc(m.thought)}</div>` : ""}
        ${m.action ? `<div class="c-action">[ ${esc(m.action)} ]</div>` : ""}
        <div class="c-say">${esc(m.text)}</div>
        <div class="c-msgFoot"><button data-demo="念这句（原型不出声）">▶ 念</button><span>${esc(m.detail || "")}</span></div>
      </div>
    </div>`;
  }

  const screens = {
    chat: function () {
      return `<div class="c-chat">
        <div class="c-channel">
          <div class="c-chLabel">CH-01 <b>直接通信</b></div>
          <div class="c-chMeta"><span class="c-signal"><i></i><i></i><i></i><i></i></span> LINK 4/4</div>
        </div>
        <div class="c-strip">
          <span>MOOD <b>${HP.herta.mood}</b></span>
          <span>PRESENCE <b>实验舱</b></span>
          <span>MEM <b>3 篇</b></span>
          <span>REVIEW <b>ON</b></span>
        </div>
        <div class="c-transcript">
          ${D.messages.map(msg).join("")}
          <div class="c-transcriptEnd">// 她想起你的时候，会自己开口</div>
        </div>
        <div class="c-inputWrap">
          <div class="c-inputRow">
            <span class="c-prompt">›</span>
            <div class="c-input">TRANSMIT TO HERTA…</div>
            <button class="c-send" data-demo="发送（原型不写库）">SEND</button>
          </div>
          <div class="c-inputMeta"><span>ENTER 发送</span><span>AUTO-CUT 长图</span><span>${HP.herta.model}</span></div>
        </div>
      </div>`;
    },

    sessions: function () {
      const groups = ["今天", "昨天", "导入"];
      return `<div class="c-screen">
        ${head("sessions")}
        <div class="c-searchBar"><span>FILTER</span><div>搜记忆和对话…</div><em>⌘K</em></div>
        ${groups.map(function (g) {
          const list = D.sessions.filter(function (s) { return s.group === g; });
          if (!list.length) return "";
          return `<section class="c-sessGroup">
            <div class="c-groupLabel"><span>${g}</span><em>${list.length}</em></div>
            <div class="c-sessTiles">
              ${list.map(function (s) {
                return `<button class="c-sessTile ${s.active ? "on" : ""}" data-demo="打开会话：${esc(s.title)}">
                  <div class="c-sessTop"><span class="c-sessLed"></span><em>${s.when}</em></div>
                  <b>${esc(s.title)}</b>
                  <small>${s.origin === "导入" ? "IMPORT · " : ""}${s.meta}</small>
                  <span class="c-sessArrow">→</span>
                </button>`;
              }).join("")}
            </div>
          </section>`;
        }).join("")}
        <div class="c-groupLabel"><span>模块</span><em>12</em></div>
        <div class="c-modGrid">
          ${HP.modules.map(function (m) {
            return `<button class="c-modTile ${m.key === "sessions" ? "on" : ""}" data-screen="${m.key}">
              <span class="c-modIcon">${icon(m.icon, 15)}</span>
              <span class="c-modName">${m.short}</span>
              <i class="c-modLed"></i>
            </button>`;
          }).join("")}
        </div>
        <p class="c-footNote">// 检索同时命中记忆与会话；点结果跳到那一块</p>
      </div>`;
    },

    memory: function () {
      const mem = D.memories;
      return `<div class="c-screen">
        ${head("memory")}
        <div class="c-statRow">
          <div><b>34</b><span>ACTIVE</span></div>
          <div><b>0.72</b><span>AVG W</span></div>
          <div><b>67</b><span>EDGES</span></div>
          <div><b>8h</b><span>SLEEP</span></div>
        </div>
        <div class="c-netPanel">
          <div class="c-panelHead"><span>NETWORK / LOD</span><span>LIVE</span></div>
          <div class="c-netCanvas"><canvas id="cNet"></canvas>
            <div class="c-netCorner tl"></div><div class="c-netCorner tr"></div><div class="c-netCorner bl"></div><div class="c-netCorner br"></div>
          </div>
          <div class="c-netFoot">
            <span><i class="ep"></i>EP 21</span><span><i class="sem"></i>SEM 12</span><span><i class="note"></i>NOTE 1</span>
            <em>90D HALF-LIFE</em>
          </div>
        </div>
        <div class="c-actionRow">
          <button class="c-btn" data-demo="浅睡：去重 / 衰减 / 剪边">LIGHT SLEEP</button>
          <button class="c-btn c-btnPrimary" data-demo="深睡：六阶段 LLM 加工">DEEP SLEEP</button>
          <span>2 / 8 TONIGHT</span>
        </div>
        <div class="c-panel">
          <div class="c-panelHead"><span>NODES / BY WEIGHT</span><span>${mem.nodes.length}</span></div>
          ${mem.nodes.slice(0, 5).map(function (n) {
            return `<button class="c-memRow" data-demo="打开记忆：${esc(n.title)}">
              <span class="c-tierDot ${n.tier}"></span>
              <span class="c-memMain"><b>${esc(n.title)}</b><small>${esc(n.gist)}</small></span>
              <span class="c-memW">${n.weight.toFixed(2)}<i><em style="width:${Math.round(n.weight * 100)}%"></em></i></span>
            </button>`;
          }).join("")}
        </div>
        <div class="c-voicePanel">
          <div class="c-panelHead"><span>VOICE / v3</span><span>READ ONLY</span></div>
          <p>${esc(mem.voice)}</p>
        </div>
        <p class="c-footNote">// 深睡仅在 KEY + NET + FOREGROUND 时运行，cap 8 / night</p>
      </div>`;
    },

    coin: function () {
      const c = D.coin;
      const up = c.pct >= 0;
      return `<div class="c-screen">
        ${head("coin")}
        <div class="c-marketPanel">
          <div class="c-marketTop">
            <div class="c-marketSym"><span class="c-coinMark">H</span><div><b>HTC/USDT</b><small>黑塔币 · 空间站市场</small></div></div>
            <span class="c-marketBadge"><i></i>${c.status}</span>
          </div>
          <div class="c-marketPrice"><b>${HP.fmtPrice(c.price)}</b><span class="${up ? "up" : "down"}">${up ? "+" : ""}${c.change.toFixed(4)} / ${HP.fmtPct(c.pct)}</span></div>
          <div class="c-chartWrap"><canvas id="cKline"></canvas></div>
          <div class="c-marketFoot"><span>OPEN ${c.open.toFixed(3)}</span><span>HIGH ${c.high.toFixed(3)}</span><span>LOW ${c.low.toFixed(3)}</span><span>VOL ${c.volume}</span></div>
        </div>
        <div class="c-ticket">
          <div class="c-ticketSide">
            <span>BUY</span><b>1.284</b><em>可用 0 USDT</em>
          </div>
          <div class="c-ticketSide sell">
            <span>SELL</span><b>1.283</b><em>可用 1,024 HTC</em>
          </div>
          <div class="c-ticketAmount">AMOUNT <b>100</b> HTC</div>
          <button class="c-btn c-btnPrimary c-ticketBtn" data-demo="下单（v1 不开放交易）">PLACE ORDER</button>
        </div>
        <div class="c-panel">
          <div class="c-panelHead"><span>POSITION</span><span>SPOT</span></div>
          <div class="c-posGrid">
            <div><span>HOLD</span><b>1,024 <em>HTC</em></b></div>
            <div><span>COST</span><b>1.041</b></div>
            <div><span>PNL</span><b class="up">+${c.wallet.pnl.toFixed(1)}</b></div>
            <div><span>PNL %</span><b class="up">+${c.wallet.pnlPct}%</b></div>
          </div>
        </div>
        <div class="c-signin">
          <div><span>DAILY CHECK-IN</span><b>+${c.signin.reward} HTC</b><em>连签 ${c.signin.streak} 天</em></div>
          <button class="c-btn c-btnPrimary" data-demo="签到（以接口 serverTime 为准）">SIGN</button>
        </div>
        <div class="c-panel">
          <div class="c-panelHead"><span>LEADERBOARD / GLOBAL</span><span>38 ONLINE</span></div>
          ${c.leaders.map(function (p, i) {
            return `<div class="c-leader ${p.me ? "me" : ""}"><span>${String(i + 1).padStart(2, "0")}</span><b>${esc(p.name)}</b><em>${p.pnl}</em></div>`;
          }).join("")}
        </div>
        <p class="c-footNote">// 示例数据 · v1 不接她、不做交易；净买入推价</p>
      </div>`;
    },

    broadcast: function () {
      const b = D.broadcast;
      return `<div class="c-screen">
        ${head("broadcast")}
        <div class="c-txHead">
          <div class="c-txNo">TRANSMISSION <b>017</b></div>
          <div class="c-txDate">${b.date} · ${b.weekday} · 空间站转播</div>
          <div class="c-txStatus"><i></i>${b.status}</div>
        </div>
        <div class="c-txLead">
          <div class="c-txSource"><span class="c-txSourceMark">V</span><div><b>${esc(b.lead.source)}</b><small>${esc(b.lead.domain)}</small></div><em>${b.lead.read}</em></div>
          <h2>${esc(b.lead.title)}</h2>
          <p>${esc(b.lead.summary)}</p>
          <div class="c-txComment"><span>COMMENT</span>${esc(b.lead.comment)}</div>
          <div class="c-txActions"><button class="c-btn" data-demo="读原文：抓网页压成要点">READ SOURCE</button><button class="c-btn c-btnPrimary" data-demo="把这条丢回会话里聊">DISCUSS</button></div>
        </div>
        <div class="c-groupLabel"><span>其余传输</span><em>${b.items.length + 1}</em></div>
        ${b.items.map(function (it, i) {
          return `<button class="c-txItem ${it.easter ? "easter" : ""}" data-demo="打开：${esc(it.title)}">
            <span class="c-txIndex">${String(i + 2).padStart(2, "0")}</span>
            <span class="c-txBody"><em>${esc(it.source)} / ${esc(it.tag)}</em><b>${esc(it.title)}</b><small>${esc(it.summary)}</small><span class="c-txEval">评 · ${esc(it.comment)}</span></span>
          </button>`;
        }).join("")}
        <div class="c-tags"><span>TAGS</span>${b.tags.map(function (t) { return `<b>${t}</b>`; }).join("")}<button data-demo="编辑关注标签">＋</button></div>
        <div class="c-history">
          ${b.history.map(function (h) { return `<button data-demo="打开第 ${h.no} 期"><b>${String(h.no).padStart(3, "0")}</b><span>${h.title}</span></button>`; }).join("")}
        </div>
        <p class="c-footNote">// 彩蛋条目单独标注；真新闻点开可回原文</p>
      </div>`;
    },

    settings: function () {
      return `<div class="c-screen">
        ${head("settings")}
        <div class="c-profile">
          ${HP.avatar("c-profileAvatar")}
          <div><b>HERTA</b><span>herta · 单人格 · 单记忆分区</span></div>
          <em>LOCAL</em>
        </div>
        <div class="c-shortcuts">
          <button data-screen="caps"><span>CAPS</span><b>6 / 9</b></button>
          <button data-screen="tools"><span>TOOLS</span><b>9</b></button>
          <button data-screen="backup"><span>SNAP</span><b>18.4 MB</b></button>
          <button data-screen="import"><span>IMPORT</span><b>628</b></button>
        </div>
        ${D.settingsGroups.map(function (g) {
          return `<section class="c-setGroup">
            <div class="c-panelHead"><span>${g.label.toUpperCase()}</span><span>${g.items.length}</span></div>
            ${g.items.map(function (it) {
              const attr = it.type === "link" ? `data-screen="${it.screen}"` : `data-demo="${esc(it.label)}（原型不保存）"`;
              const val = it.type === "toggle" ? toggle(it.value) : `<em>${esc(it.value)}</em>`;
              return `<button class="c-setRow" ${attr}>
                <span class="c-setMain"><b>${esc(it.label)}</b>${it.hint ? `<small>${esc(it.hint)}</small>` : ""}</span>
                ${val}
              </button>`;
            }).join("")}
          </section>`;
        }).join("")}
        <div class="c-setGroup">
          <div class="c-panelHead"><span>UI</span><span>02</span></div>
          <button class="c-setRow" data-screen="onboarding"><span class="c-setMain"><b>启动序列</b><small>ASCII 半调 · 白底淡出</small></span><em>→</em></button>
          <button class="c-setRow" data-screen="system"><span class="c-setMain"><b>设计系统</b><small>颜色 / 字阶 / 组件</small></span><em>→</em></button>
        </div>
        <p class="c-footNote">// 全部本机状态；API KEY 不进快照</p>
      </div>`;
    },

    caps: function () {
      return `<div class="c-screen">
        ${head("caps")}
        <div class="c-capSummary"><b>6</b><span>/ 9 权限在线</span><em>HIGH PRIVILEGE: 2 LOCKED</em></div>
        <div class="c-capMatrix">
          ${D.caps.map(function (c) {
            return `<button class="c-capRow" data-demo="${esc(c.label)}：授权开关（原型不申请权限）">
              <span class="c-capLed ${c.state}"></span>
              <span class="c-capMain"><b>${esc(c.label)}</b><small>${esc(c.detail)}</small></span>
              <span class="c-capNote">${esc(c.note)}</span>
              <span class="c-capState ${c.state}">${c.state === "granted" ? "ON" : c.state === "ask" ? "ASK" : "OFF"}</span>
            </button>`;
          }).join("")}
        </div>
        <p class="c-footNote">// 无障碍与相册是高权限门；她只能说「我需要」</p>
      </div>`;
    },

    import: function () {
      return `<div class="c-screen">
        ${head("import")}
        <div class="c-injectPanel">
          <div class="c-panelHead"><span>INGEST / SHARE LINK</span><span>ARCHIVE ONLY</span></div>
          <div class="c-injectField"><span class="c-injectPrompt">›</span><div>https://chat.deepseek.com/share/…</div><button class="c-btn c-btnPrimary" data-demo="取链接（原型不联网）">FETCH</button></div>
          <div class="c-injectOr">OR</div>
          <button class="c-dropzone" data-demo="选 JSON 文件（原型不读文件）">${icon("import", 18)}<b>SELECT EXPORTED JSON</b><small>herta-import · 628 blocks</small></button>
        </div>
        <div class="c-groupLabel"><span>流程</span><em>3 STEP</em></div>
        <div class="c-flow">
          <div class="c-flowStep"><b>01</b><span>原文归档</span><em>IMPORTED</em></div>
          <div class="c-flowStep"><b>02</b><span>让她做梦</span><em>MANUAL</em></div>
          <div class="c-flowStep"><b>03</b><span>源文件可删</span><em>OPTIONAL</em></div>
        </div>
        <div class="c-panel">
          <div class="c-panelHead"><span>FILES / 12</span><span>2.1 MB</span></div>
          <div class="c-fileRow"><span>设计-v1.md</span><em>8.2 KB</em><small>01:58</small></div>
          <div class="c-fileRow"><span>Herta-源码通读报告.pdf</span><em>1.4 MB</em><small>昨天</small></div>
          <div class="c-fileRow"><span>播报-第16期.docx</span><em>88 KB</em><small>11-02</small></div>
        </div>
        <p class="c-footNote">// 文本单件 ≤512KB，整库 ≤2MB；文档源文件 ≤20MB</p>
      </div>`;
    },

    backup: function () {
      const b = D.backup;
      return `<div class="c-screen">
        ${head("backup")}
        <div class="c-snapPanel">
          <div class="c-snapRing"><div class="c-snapInner"><b>${b.size}</b><span>SNAPSHOT</span></div></div>
          <div class="c-snapMeta"><span>API KEY</span><b>EXCLUDED</b><span>LAST</span><b>10-31 23:12</b><span>WALLET</span><b>KEEP LOCAL</b></div>
        </div>
        <button class="c-btn c-btnPrimary c-btnWide" data-demo="封包（原型只显示，不写文件）">CREATE SNAPSHOT</button>
        <div class="c-panel">
          <div class="c-panelHead"><span>MANIFEST / 6</span><span>INCLUDED</span></div>
          ${b.items.map(function (it) {
            return `<div class="c-manifestRow"><span>${esc(it.label)}</span><b>${esc(it.count)}</b><em>${esc(it.note)}</em></div>`;
          }).join("")}
        </div>
        <div class="c-restoreRow">
          <button class="c-btn" data-demo="从文件恢复（原型不读文件）">RESTORE</button>
          <button class="c-btn" data-demo="只导出会话">EXPORT SESSIONS</button>
        </div>
        <p class="c-footNote">// 恢复时本机已有钱包则不覆盖</p>
      </div>`;
    },

    tools: function () {
      return `<div class="c-screen">
        ${head("tools")}
        <div class="c-logTop"><b>9</b><span>EVENTS TODAY</span><em>1 DENIED</em></div>
        <div class="c-logFilter"><button class="on">ALL</button><button data-demo="只看失败">FAIL 1</button><button data-demo="只看写类">WRITE 0</button></div>
        <div class="c-logStream">
          ${D.tools.map(function (t) {
            return `<div class="c-logRow ${t.tone}">
              <span class="c-logTime">${t.time}</span>
              <span class="c-logLed"></span>
              <span class="c-logMain"><b>${esc(t.tool)}</b><small>${esc(t.args)}</small></span>
              <span class="c-logResult">${esc(t.result)}</span>
              <em>${t.ms}</em>
            </div>`;
          }).join("")}
        </div>
        <p class="c-footNote">// 工具旁白不进通信频道，只写事件流</p>
      </div>`;
    },

    onboarding: function () {
      return `<div class="c-boot">
        <div class="c-bootStars"></div>
        <div class="c-bootFrame">
          <div class="c-bootTop">HERTA OS · BOOT SEQUENCE</div>
          <div class="c-bootLogo">HERTA</div>
          <div class="c-bootSub">SPACE STATION PERSONAL CONSOLE</div>
          <div class="c-bootBars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <div class="c-bootLog">
            <div><span>01</span>PERSONA <em>LOADED</em></div>
            <div><span>02</span>NMS CORE <em>58 NODES</em></div>
            <div><span>03</span>VOICE / LOCAL <em>READY</em></div>
            <div><span>04</span>MEMORY SLEEP <em>8H AGO</em></div>
          </div>
          <button class="c-bootStart" data-demo="开始（原型直接进入对话）">ENTER CONSOLE</button>
          <button class="c-bootImport" data-screen="import">IMPORT FROM DEEPSEEK</button>
          <div class="c-bootFoot">ASCII HALFTONE · LIGHT FIELD</div>
        </div>
      </div>`;
    },

    system: function () {
      return `<div class="c-screen">
        ${head("system")}
        <div class="c-dsHero">
          <div class="c-dsKicker">DESIGN TOKENS / C</div>
          <h2>轨道控制台</h2>
          <p>桌面端暗色主题的延伸：深空底、青色信号、等宽读数。模块不是页面，是空间站里的系统。</p>
        </div>
        <div class="c-dsLabel">COLOR / SIGNAL</div>
        <div class="c-swatches">
          <div style="background:#061018"><span>VOID</span><em>#061018</em></div>
          <div style="background:#0d2233"><span>DECK</span><em>#0D2233</em></div>
          <div style="background:#6ee7ff;color:#061018"><span>CYAN</span><em>#6EE7FF</em></div>
          <div style="background:#7dffc4;color:#061018"><span>MINT</span><em>#7DFFC4</em></div>
          <div style="background:#ff6b7d"><span>ALERT</span><em>#FF6B7D</em></div>
          <div style="background:#ffb86b;color:#061018"><span>WARM</span><em>#FFB86B</em></div>
        </div>
        <div class="c-dsLabel">TYPE / READOUT</div>
        <div class="c-typeRows">
          <div><span>DISPLAY</span><b class="c-tDisplay">HERTA</b></div>
          <div><span>TITLE</span><b class="c-tTitle">记忆核心</b></div>
          <div><span>BODY</span><b class="c-tBody">先拆前提，再回答问题。不哄。</b></div>
          <div><span>META</span><b class="c-tMeta">EP · 0.86 · 3D AGO</b></div>
        </div>
        <div class="c-dsLabel">PARTS</div>
        <div class="c-parts">
          <button class="c-btn c-btnPrimary">PRIMARY</button><button class="c-btn">GHOST</button>
          <span class="c-signal"><i></i><i></i><i></i><i></i></span>
          <span class="c-dsLed"><i></i>LIVE</span>
          <span class="c-dsChip">EP / 0.86</span>
        </div>
        <p class="c-footNote">// 最像「另一个系统」，也最吃电；暗色下她的肖像会显得更冷</p>
      </div>`;
    },
  };

  function render(screen) {
    const content = (screens[screen] || screens.chat)();
    return `<div class="variantRoot c-root">
      <div class="c-stars"></div>
      <div class="c-app">
        <header class="c-status">
          <div class="c-brand">HERTA<span>OS</span></div>
          <div class="c-statusTime">02:14 <em>· 11-03</em></div>
          <div class="c-statusRight"><span><i></i>LOCAL</span><span class="c-batt">84%</span></div>
        </header>
        <div class="c-body">
          ${dock(screen)}
          <main class="c-main">${content}</main>
        </div>
        <footer class="c-cmd">
          <span class="c-cmdPrompt">⌘</span>
          <div class="c-cmdText">输入指令 /chat /memory /coin…</div>
          <span class="c-cmdHint">K</span>
        </footer>
      </div>
    </div>`;
  }

  function mount(screen) {
    if (screen === "memory") {
      HP.charts.drawNetwork(document.querySelector("#cNet"), {
        grid: "rgba(110,231,255,.08)",
        axis: "#6f8ea3",
        up: "#ff6b7d",
        down: "#57e3b2",
        line: "#6ee7ff",
        ring: "rgba(110,231,255,.09)",
        edge: "#2f8fa8",
        nodeRing: "rgba(6,16,24,.9)",
        label: "#9fc7d8",
        tier: { ep: "#6ee7ff", sem: "#7dffc4", note: "#ffb86b" },
        glow: true,
      }, { labels: 4 });
    }
    if (screen === "coin") {
      HP.charts.drawCandles(document.querySelector("#cKline"), {
        grid: "rgba(110,231,255,.08)",
        axis: "#6f8ea3",
        up: "#ff6b7d",
        down: "#57e3b2",
        line: "#6ee7ff",
        badgeBg: "#6ee7ff",
        badgeInk: "#041016",
      }, { axisLabels: true, badge: true });
    }
  }

  window.VARIANTS = window.VARIANTS || {};
  window.VARIANTS.C = {
    key: "C",
    name: "轨道控制台",
    en: "ORBIT CONSOLE",
    tagline: "把她放进空间站终端：深空底、青色信号、等宽读数。对话是频道，记忆是核心，黑塔币是交易台。",
    bullets: [
      "结构：左侧常驻系统坞，所有模块都有 LED 状态",
      "对话：不是气泡，是频道转录；想是注释行",
      "记忆与行情：HUD 面板、刻度、事件流",
      "代价：暗色 + 信息密度高，白天户外可读性差",
    ],
    trade: "适合：想强调「她是一个系统，不只是聊天对象」，夜间使用最多。",
    note: "暗色主题直接对应桌面端的 dark mode；青色只用于「有信号」，不用于装饰。",
    render: render,
    mount: mount,
  };
})();
