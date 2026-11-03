
/* 方向 A · 站内工作台
 * 把桌面端的「玻璃工作区」压进手机：左轨、玻璃卡、毛玻璃顶栏、海面青底。
 * 12 个模块都在同一个壳里，模块之间只换中间那层内容。
 */
(function () {
  const HP = window.HP;
  const D = HP.data;
  const esc = HP.esc;
  const icon = HP.icon;

  const RAIL = [
    { key: "chat", label: "对话" },
    { key: "memory", label: "记忆" },
    { key: "coin", label: "黑塔币" },
    { key: "broadcast", label: "播报" },
  ];

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
    system: ["设计系统", "A · 站内工作台"],
  };

  function top(screen) {
    const m = META[screen] || META.chat;
    return `<header class="a-top">
      <button class="a-iconBtn" data-screen="sessions" aria-label="打开会话">${icon("sessions", 18)}</button>
      <div class="a-title"><b>${m[0]}</b><span>${m[1]}</span></div>
      <div class="a-topRight">
        <span class="a-presence"><i></i>${HP.herta.mood}</span>
        <button class="a-avatarBtn" data-screen="settings" aria-label="设置">${HP.avatar("a-avatar")}</button>
      </div>
    </header>`;
  }

  function rail(screen) {
    const isRail = RAIL.some(function (r) { return r.key === screen; });
    return `<aside class="a-rail">
      <button class="a-mark" data-screen="sessions" aria-label="会话">H</button>
      <button class="a-new" data-demo="新建对话（原型不落库）" aria-label="新建对话">${icon("plus", 15)}</button>
      <nav class="a-nav">
        ${RAIL.map(function (r) {
          return `<button class="a-railBtn ${screen === r.key ? "on" : ""}" data-screen="${r.key}" aria-label="${r.label}" title="${r.label}">${icon(r.key, 19)}</button>`;
        }).join("")}
      </nav>
      <div class="a-railFoot">
        <button class="a-railBtn ${screen === "settings" ? "on" : ""}" data-screen="settings" aria-label="设置" title="设置">${icon("settings", 19)}</button>
        <button class="a-railBtn ${isRail || screen === "settings" ? "" : "on"}" data-screen="sessions" aria-label="全部模块" title="全部模块">${icon("more", 19)}</button>
      </div>
    </aside>`;
  }

  function toggle(on) {
    return `<span class="a-switch ${on ? "on" : ""}" role="switch" aria-checked="${on}"><i></i></span>`;
  }

  function msg(m) {
    if (m.kind === "user") {
      return `<div class="a-turn a-turnUser">
        <div class="a-bubbleUser">${esc(m.text)}<span class="a-time">${m.time}</span></div>
        <div class="a-userAvatar">你</div>
      </div>`;
    }
    if (m.kind === "tool") {
      return `<div class="a-toolNote"><span class="a-toolDot">${icon("tools", 12)}</span><span>${esc(m.text)}</span><em>${esc(m.detail)}</em></div>`;
    }
    if (m.kind === "sticker") {
      return `<div class="a-turn a-turnHerta">
        ${HP.avatar("a-msgAvatar")}
        <div class="a-hertaCol">
          <div class="a-stickerCard"><div class="a-stickerTile">摸鱼中</div><span>${esc(m.label)}</span></div>
          <span class="a-time a-timeLeft">${m.time}</span>
        </div>
      </div>`;
    }
    return `<div class="a-turn a-turnHerta">
      ${HP.avatar("a-msgAvatar")}
      <div class="a-hertaCol">
        <div class="a-card a-speech">
          ${m.thought ? `<div class="a-thought"><span>想</span>${esc(m.thought)}</div>` : ""}
          ${m.action ? `<div class="a-action">（${esc(m.action)}）</div>` : ""}
          <div class="a-say">${esc(m.text)}</div>
          <div class="a-speechFoot">
            <button class="a-play" data-demo="念这句（原型不出声）">${icon("play", 10)} 念</button>
            ${m.tokens ? `<span class="a-tokChip" data-demo="${esc(m.detail || "")}">${esc(m.tokens)}</span>` : ""}
            <span class="a-time a-timeLeft">${m.time}</span>
          </div>
        </div>
      </div>
    </div>`;
  }

  const screens = {
    chat: function () {
      return `<div class="a-chat">
        <div class="a-context">
          <span class="a-liveDot"></span>
          <span>记忆 3 篇</span><i>·</i><span>复核 开</span><i>·</i><span>省 token 关</span>
          <span class="a-contextRight">02:14</span>
        </div>
        <div class="a-thread">
          <div class="a-dayLine"><span>今天</span></div>
          ${D.messages.map(msg).join("")}
          <div class="a-threadEnd">她想起你的时候，会自己开口。</div>
        </div>
        <div class="a-composeWrap">
          <div class="a-quickRow">
            <button data-demo="撤回上一轮（原型不执行）">↩︎ 撤回上一轮</button>
            <span>Enter 发送 · 长图自动切段</span>
          </div>
          <div class="a-composer">
            <button class="a-composerBtn" data-demo="拍照 / 选文件">${icon("attach", 17)}</button>
            <div class="a-input">给黑塔发消息…<span class="a-caret"></span></div>
            <button class="a-composerBtn" data-demo="语音输入">${icon("mic", 17)}</button>
            <button class="a-send" data-demo="发送（原型不写库）">${icon("send", 17)}</button>
          </div>
          <div class="a-composeFoot">
            <span>她的手机 · 本机模型调用</span>
            <span class="a-model">${HP.herta.model}</span>
          </div>
        </div>
      </div>`;
    },

    sessions: function () {
      const groups = ["今天", "昨天", "导入"];
      return `<div class="a-page">
        <div class="a-search">${icon("search", 15)}<span>搜记忆和对话…</span><kbd>⌘K</kbd></div>
        <div class="a-segRow">
          <button class="on">全部</button><button data-demo="按时间筛选">最近</button><button data-demo="只看导入">导入</button>
          <button class="a-segRight" data-demo="新建对话">＋ 新的对话</button>
        </div>
        ${groups.map(function (g) {
          const list = D.sessions.filter(function (s) { return s.group === g; });
          if (!list.length) return "";
          return `<section class="a-sessGroup">
            <div class="a-groupHead"><span>${g}</span><span>${list.length}</span></div>
            ${list.map(function (s) {
              return `<button class="a-sessRow ${s.active ? "on" : ""}" data-demo="打开会话：${esc(s.title)}">
                <span class="a-sessDot"></span>
                <span class="a-sessMain"><b>${esc(s.title)}</b><small>${s.origin === "导入" ? "导入归档 · " : ""}${s.meta}</small></span>
                <span class="a-sessWhen">${s.when}</span>
                <span class="a-sessGo">${icon("chevron", 13)}</span>
              </button>`;
            }).join("")}
          </section>`;
        }).join("")}
        <section class="a-modIndex">
          <div class="a-groupHead"><span>全部模块</span><span>12</span></div>
          <div class="a-modGrid">
            ${HP.modules.map(function (m) {
              return `<button class="a-modTile ${m.key === "sessions" ? "on" : ""}" data-screen="${m.key}">
                <span class="a-modIcon">${icon(m.icon, 16)}</span>
                <span>${m.label}</span>
              </button>`;
            }).join("")}
          </div>
        </section>
        <p class="a-hintLine">全文检索同时搜记忆和会话；点命中直接跳到那块。</p>
      </div>`;
    },

    memory: function () {
      const mem = D.memories;
      const tiers = [
        { key: "ep", label: "情景", n: mem.counts.ep },
        { key: "sem", label: "语义", n: mem.counts.sem },
        { key: "note", label: "语气", n: mem.counts.note },
      ];
      return `<div class="a-page">
        <div class="a-card a-netCard">
          <div class="a-cardHead">
            <div><h3>记忆网络</h3><p>58 个节点 · 67 条边 · 90 天半衰</p></div>
            <span class="a-liveBadge"><i></i>活着</span>
          </div>
          <div class="a-netWrap">
            <canvas id="aNet" class="a-netCanvas"></canvas>
            <div class="a-netLegend">
              ${tiers.map(function (t) { return `<span class="a-lg ${t.key}"><i></i>${t.label} ${t.n}</span>`; }).join("")}
            </div>
          </div>
          <div class="a-netStats">
            <div><b>34</b><span>活跃</span></div>
            <div><b>8</b><span>已压缩</span></div>
            <div><b>0.72</b><span>平均权重</span></div>
            <div><b>8h</b><span>上次浅睡</span></div>
          </div>
        </div>

        <div class="a-sleepRow">
          <button class="a-btn a-btnGhost" data-demo="浅睡：去重 / 衰减 / 剪边（原型不动数据）">浅睡</button>
          <button class="a-btn a-btnInk" data-demo="深睡：六阶段 LLM 加工（原型不调模型）">深睡</button>
          <span class="a-sleepNote">今晚已 2 / 8 次</span>
        </div>

        <div class="a-card a-memListCard">
          <div class="a-cardHead"><div><h3>最近被想起</h3><p>按有效权重排</p></div><button class="a-linkBtn" data-demo="打开完整列表">列表 →</button></div>
          ${mem.nodes.slice(0, 5).map(function (n) {
            return `<button class="a-memRow" data-demo="打开记忆：${esc(n.title)}">
              <span class="a-tierTag ${n.tier}">${HP.tierName[n.tier]}</span>
              <span class="a-memMain"><b>${esc(n.title)}</b><small>${esc(n.gist)}</small></span>
              <span class="a-weight"><b>${n.weight.toFixed(2)}</b><i><em style="width:${Math.round(n.weight * 100)}%"></em></i></span>
            </button>`;
          }).join("")}
        </div>

        <div class="a-card a-voiceCard">
          <div class="a-cardHead"><div><h3>她写字的样子</h3><p>第 3 版 · 用 6 篇记忆重写</p></div><span class="a-mono">v3</span></div>
          <p>${esc(mem.voice)}</p>
        </div>
        <p class="a-hintLine">深睡只在有 key、有网、前台时 opportunistic 跑；cap 8 次/晚。</p>
      </div>`;
    },

    coin: function () {
      const c = D.coin;
      const up = c.pct >= 0;
      return `<div class="a-page">
        <div class="a-card a-coinHead">
          <div class="a-coinTop">
            <div class="a-coinSym"><span class="a-coinLogo">H</span><div><b>${c.name}</b><small>${c.symbol}</small></div></div>
            <span class="a-coinStatus">${c.status}</span>
          </div>
          <div class="a-coinPrice">
            <b>${HP.fmtPrice(c.price)}</b>
            <span class="${up ? "up" : "down"}">${up ? "+" : ""}${c.change.toFixed(4)} · ${HP.fmtPct(c.pct)}</span>
          </div>
          <div class="a-ohlc">
            <span>开 <b>${c.open.toFixed(3)}</b></span>
            <span>高 <b>${c.high.toFixed(3)}</b></span>
            <span>低 <b>${c.low.toFixed(3)}</b></span>
            <span>量 <b>${c.volume}</b></span>
          </div>
          <div class="a-chartBox"><canvas id="aKline" class="a-kline"></canvas></div>
          <div class="a-chartFoot"><span>分钟 K · 随已揭示行情铺满</span><span>MA5 · 均价</span></div>
        </div>

        <div class="a-coinGrid">
          <div class="a-card a-miniCard">
            <div class="a-miniHead">钱包<span>成本 ${c.wallet.cost.toFixed(3)}</span></div>
            <b class="a-miniBig">${c.wallet.htc.toLocaleString()} <small>HTC</small></b>
            <span class="a-miniPnl up">+${c.wallet.pnl.toFixed(1)} · +${c.wallet.pnlPct}%</span>
          </div>
          <div class="a-card a-miniCard">
            <div class="a-miniHead">签到<span>连签 ${c.signin.streak} 天</span></div>
            <b class="a-miniBig">+${c.signin.reward} <small>HTC</small></b>
            <button class="a-btn a-btnInk a-btnSmall" data-demo="签到（以接口 serverTime 为准）">签到</button>
          </div>
        </div>

        <div class="a-card a-marketCard">
          <div class="a-cardHead"><div><h3>共享市场</h3><p>38 人在线 · 你排第 6</p></div><span class="a-liveBadge"><i></i>净买入推价</span></div>
          ${c.leaders.map(function (p, i) {
            return `<div class="a-leader ${p.me ? "me" : ""}"><span class="a-rank">${i + 1}</span><span class="a-leaderName">${esc(p.name)}</span><span class="a-leaderPct">${p.pnl}</span></div>`;
          }).join("")}
        </div>
        <p class="a-hintLine">原型数据 · v1 不接她、不做交易；页面与网页行情同源。</p>
      </div>`;
    },

    broadcast: function () {
      const b = D.broadcast;
      return `<div class="a-page">
        <div class="a-bcMast">
          <div class="a-bcStamp">星际和平播报</div>
          <div class="a-bcNo">第 <b>${b.no}</b> 期</div>
          <div class="a-bcDate">${b.date} · ${b.weekday}</div>
        </div>
        <div class="a-bcMeta"><span>空间站「黑塔」转播</span><span class="a-liveBadge"><i></i>${b.status}</span></div>

        <div class="a-card a-bcLead">
          <div class="a-bcSource"><span class="a-sourceMark">V</span><div><b>${esc(b.lead.source)}</b><small>${esc(b.lead.domain)}</small></div><span class="a-bcRead">${b.lead.read}</span></div>
          <h2>${esc(b.lead.title)}</h2>
          <p>${esc(b.lead.summary)}</p>
          <div class="a-comment"><span>评</span>${esc(b.lead.comment)}</div>
          <div class="a-bcActions"><button class="a-btn a-btnGhost" data-demo="读原文：抓网页压成要点">读原文</button><button class="a-btn a-btnInk" data-demo="把这条丢回会话里聊">和她聊这条</button></div>
        </div>

        <div class="a-bcList">
          <div class="a-groupHead"><span>本期其余</span><span>${b.items.length + 1} 条</span></div>
          ${b.items.map(function (it) {
            return `<button class="a-bcItem ${it.easter ? "easter" : ""}" data-demo="打开：${esc(it.title)}">
              <span class="a-bcItemSource">${esc(it.source)}</span>
              <span class="a-bcItemMain"><b>${esc(it.title)}</b><small>${esc(it.summary)}</small><em>评 · ${esc(it.comment)}</em></span>
              <span class="a-bcItemTag">${esc(it.tag)}</span>
            </button>`;
          }).join("")}
        </div>

        <div class="a-tagRow"><span>关注标签</span>${b.tags.map(function (t) { return `<b>${t}</b>`; }).join("")}<button data-demo="编辑关注标签">＋</button></div>
        <div class="a-historyRow">${b.history.map(function (h) { return `<button data-demo="打开第 ${h.no} 期"><b>第 ${h.no} 期</b><span>${h.title}</span></button>`; }).join("")}</div>
      </div>`;
    },

    settings: function () {
      return `<div class="a-page">
        <div class="a-card a-profileCard">
          ${HP.avatar("a-profileAvatar")}
          <div class="a-profileMain"><b>黑塔</b><span>herta · 单人格 · 单记忆分区</span></div>
          <span class="a-liveBadge"><i></i>本机</span>
        </div>
        <div class="a-shortcuts">
          <button data-screen="caps"><span>${icon("caps", 16)}</span><b>她能做什么</b><small>6 项开着</small></button>
          <button data-screen="tools"><span>${icon("tools", 16)}</span><b>工具调用</b><small>今天 9 次</small></button>
          <button data-screen="backup"><span>${icon("backup", 16)}</span><b>备份迁移</b><small>18.4 MB</small></button>
        </div>
        ${D.settingsGroups.map(function (g) {
          return `<section class="a-setGroup">
            <div class="a-groupHead"><span>${g.label}</span><span>${g.items.length}</span></div>
            ${g.items.map(function (it) {
              const cls = "a-setRow" + (it.type === "link" ? " tap" : "");
              const control = it.type === "toggle"
                ? toggle(it.value)
                : it.type === "link"
                  ? `<span class="a-setValue">${esc(it.value)} ${icon("chevron", 12)}</span>`
                  : `<span class="a-setValue">${esc(it.value)}</span>`;
              const attr = it.type === "link" ? `data-screen="${it.screen}"` : `data-demo="${esc(it.label)}（原型不保存）"`;
              return `<button class="${cls}" ${attr}>
                <span class="a-setMain"><b>${esc(it.label)}</b>${it.hint ? `<small>${esc(it.hint)}</small>` : ""}</span>
                ${control}
              </button>`;
            }).join("")}
          </section>`;
        }).join("")}
        <div class="a-setGroup">
          <div class="a-groupHead"><span>界面</span><span>2</span></div>
          <button class="a-setRow tap" data-screen="onboarding"><span class="a-setMain"><b>开屏与引导</b><small>ASCII 半调 · 白底淡出</small></span><span class="a-setValue">${icon("chevron", 12)}</span></button>
          <button class="a-setRow tap" data-screen="system"><span class="a-setMain"><b>设计系统</b><small>颜色 / 字阶 / 半径 / 组件</small></span><span class="a-setValue">${icon("chevron", 12)}</span></button>
        </div>
        <p class="a-hintLine">全部本机状态，没有一处上传。API Key 不进备份包。</p>
      </div>`;
    },

    caps: function () {
      const on = D.caps.filter(function (c) { return c.state === "granted"; }).length;
      return `<div class="a-page">
        <div class="a-card a-capHead">
          <div><h3>她能碰手机到什么程度</h3><p>每一项都单独开，默认全关；高权限单独标注。</p></div>
          <span class="a-capCount">${on} / ${D.caps.length}</span>
        </div>
        <div class="a-capList">
          ${D.caps.map(function (c) {
            return `<button class="a-capRow" data-demo="${esc(c.label)}：授权开关（原型不申请权限）">
              <span class="a-capIcon">${icon(c.key === "a11y" ? "lock" : "caps", 16)}</span>
              <span class="a-capMain"><b>${esc(c.label)}</b><small>${esc(c.detail)} · ${esc(c.note)}</small></span>
              <span class="a-capState ${c.state}">${c.state === "granted" ? "已开" : c.state === "ask" ? "询问" : "关闭"}</span>
            </button>`;
          }).join("")}
        </div>
        <p class="a-hintLine">无障碍与相册是两道高权限门；她在会话里只能说「我需要」，不能自己开。</p>
      </div>`;
    },

    import: function () {
      return `<div class="a-page">
        <div class="a-card a-importHero">
          <div class="a-importKicker">IMPORT · 只归档原文</div>
          <h2>把你在 DeepSeek 里说过的话搬进来</h2>
          <p>最省事的是分享链接：打开那条对话 → 分享 → 创建链接。公开接口，不需要登录。</p>
          <div class="a-importField"><span>https://chat.deepseek.com/share/…</span><button data-demo="取链接（原型不联网）">取</button></div>
          <div class="a-importOr"><span>或</span></div>
          <button class="a-dropzone" data-demo="选 JSON 文件（原型不读文件）">${icon("import", 20)}<b>选一个导出的 JSON</b><small>油猴脚本 / 旧版导出</small></button>
        </div>
        <div class="a-card a-importNote">
          <div class="a-cardHead"><div><h3>导入之后</h3><p>${esc(D.importData.last)}</p></div><span class="a-mono">628 块</span></div>
          <div class="a-importSteps">
            <div><b>01</b><span>原文归档，不自动进记忆</span></div>
            <div><b>02</b><span>打开它，点「让她做梦」才会消化</span></div>
            <div><b>03</b><span>源文件可留在本机，也可随时删</span></div>
          </div>
        </div>
        <div class="a-card a-importNote">
          <div class="a-cardHead"><div><h3>文件库</h3><p>她读过的文件 · 12 件 · 2.1 MB</p></div><button class="a-btn a-btnSmall a-btnGhost" data-demo="添加文件">＋ 添加</button></div>
          <div class="a-fileRow"><span>设计-v1.md</span><em>8.2 KB</em><small>01:58</small></div>
          <div class="a-fileRow"><span>Herta-源码通读报告.pdf</span><em>1.4 MB</em><small>昨天</small></div>
          <div class="a-fileRow"><span>播报-第16期.docx</span><em>88 KB</em><small>11-02</small></div>
        </div>
      </div>`;
    },

    backup: function () {
      const b = D.backup;
      return `<div class="a-page">
        <div class="a-card a-backupHero">
          <div class="a-importKicker">SNAPSHOT · 换机带走</div>
          <div class="a-backupBig"><b>${b.size}</b><span>整包体积 · 不含 API Key</span></div>
          <div class="a-backupBar"><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <button class="a-btn a-btnInk a-btnWide" data-demo="打包（原型只显示，不写文件）">打包成备份</button>
          <p class="a-backupLast">${esc(b.last)}</p>
        </div>
        <div class="a-card a-manifest">
          <div class="a-cardHead"><div><h3>包内清单</h3><p>恢复时本机已有钱包则不覆盖</p></div><span class="a-mono">6 项</span></div>
          ${b.items.map(function (it) {
            return `<div class="a-manifestRow"><span>${esc(it.label)}</span><b>${esc(it.count)}</b><small>${esc(it.note)}</small></div>`;
          }).join("")}
        </div>
        <div class="a-restoreRow">
          <button class="a-btn a-btnGhost" data-demo="从文件恢复（原型不读文件）">从备份恢复</button>
          <button class="a-btn a-btnGhost" data-demo="导出单个会话">只导出会话</button>
        </div>
      </div>`;
    },

    tools: function () {
      return `<div class="a-page">
        <div class="a-card a-toolHero">
          <div class="a-importKicker">TOOL LOG · 她动过什么手</div>
          <div class="a-toolCount">今天 <b>9</b> 次调用 · 1 次被系统拒绝</div>
          <div class="a-toolFilters"><button class="on">全部</button><button data-demo="只看失败">失败 1</button><button data-demo="只看写类">写类 0</button></div>
        </div>
        <div class="a-toolList">
          ${D.tools.map(function (t) {
            return `<div class="a-toolRow ${t.tone}">
              <span class="a-toolTime">${t.time}</span>
              <span class="a-toolBody"><b>${esc(t.tool)}</b><small>${esc(t.args)}</small></span>
              <span class="a-toolResult">${esc(t.result)}</span>
              <span class="a-toolMs">${t.ms}</span>
            </div>`;
          }).join("")}
        </div>
        <p class="a-hintLine">工具旁白不刷聊天页，只记在这里；聊天里只留一行灰字。</p>
      </div>`;
    },

    onboarding: function () {
      return `<div class="a-onboard">
        <div class="a-onboardGlow"></div>
        <div class="a-onboardGlyphs" aria-hidden="true">${"HERTA".repeat(1)}</div>
        <div class="a-onboardInner">
          <div class="a-onboardMark">H</div>
          ${HP.avatar("a-onboardAvatar")}
          <h2>她在这里。</h2>
          <p>她记得你第一次说睡不着。也记得你后来每次都说「没事」。</p>
          <div class="a-onboardActions">
            <button class="a-btn a-btnInk a-btnWide" data-demo="开始（原型直接进入对话）">开始</button>
            <button class="a-btn a-btnGhost a-btnWide" data-screen="import">从 DeepSeek 导入</button>
          </div>
          <span class="a-onboardFoot">开屏是 ASCII 半调 · 她由几千个字符逐帧亮起</span>
        </div>
      </div>`;
    },

    system: function () {
      return `<div class="a-page">
        <div class="a-card a-dsHead">
          <div class="a-importKicker">DESIGN TOKENS · A</div>
          <h2>站内工作台</h2>
          <p>桌面端玻璃工作区的手机压缩版：左轨、墨色文字、青白宇宙底。信息密度最高，最像「她本来就住在这儿」。</p>
        </div>
        <section class="a-dsBlock">
          <div class="a-dsLabel">颜色 / COLOR</div>
          <div class="a-swatches">
            <div class="a-swatch" style="background:#25b7ee"><span>宇宙青</span><em>#25B7EE</em></div>
            <div class="a-swatch" style="background:#8fece7"><span>海面</span><em>#8FECE7</em></div>
            <div class="a-swatch dark" style="background:#111417"><span>墨</span><em>#111417</em></div>
            <div class="a-swatch" style="background:#2f7d92"><span>强调</span><em>#2F7D92</em></div>
            <div class="a-swatch" style="background:#d96a7a"><span>涨</span><em>#D96A7A</em></div>
            <div class="a-swatch" style="background:#4f9d8a"><span>跌</span><em>#4F9D8A</em></div>
          </div>
        </section>
        <section class="a-dsBlock">
          <div class="a-dsLabel">字阶 / TYPE</div>
          <div class="a-typeRows">
            <div><span>Display</span><b class="a-tDisplay">她在这里。</b></div>
            <div><span>Title</span><b class="a-tTitle">记忆网络</b></div>
            <div><span>Body</span><b class="a-tBody">先拆前提，再回答问题。不哄。</b></div>
            <div><span>Meta</span><b class="a-tMeta">EP · 0.86 · 3 天前</b></div>
          </div>
        </section>
        <section class="a-dsBlock">
          <div class="a-dsLabel">半径 / RADIUS</div>
          <div class="a-radiusRow"><div class="a-r18">18 卡片</div><div class="a-r12">12 控件</div><div class="a-r999">999 胶囊</div></div>
        </section>
        <section class="a-dsBlock">
          <div class="a-dsLabel">组件 / PARTS</div>
          <div class="a-parts">
            <button class="a-btn a-btnInk">主按钮</button><button class="a-btn a-btnGhost">次按钮</button>
            <span class="a-liveBadge"><i></i>活着</span><span class="a-tierTag sem">语义</span>
            <div class="a-composer a-composerMini"><div class="a-input">给黑塔发消息…</div><button class="a-send">${icon("send", 15)}</button></div>
          </div>
        </section>
        <p class="a-hintLine">「桌面像她住的地方」是这一版的判断；代价是手机上永远有一条 58px 的左轨。</p>
      </div>`;
    },
  };

  function render(screen) {
    const content = (screens[screen] || screens.chat)();
    return `<div class="variantRoot a-root">
      <div class="a-app">
        ${rail(screen)}
        <main class="a-main">
          ${top(screen)}
          <section class="a-body ${screen === "chat" ? "a-bodyChat" : ""}">${content}</section>
        </main>
      </div>
    </div>`;
  }

  function mount(screen) {
    if (screen === "memory") {
      HP.charts.drawNetwork(document.getElementById("aNet"), {
        grid: "rgba(17,20,23,.06)",
        axis: "#717984",
        up: "#d96a7a",
        down: "#4f9d8a",
        line: "#2f7d92",
        ring: "rgba(17,20,23,.07)",
        edge: "#2f7d92",
        nodeRing: "rgba(255,255,255,.9)",
        label: "#3b4350",
        tier: { ep: "#2f7d92", sem: "#2563eb", note: "#b5873f" },
      }, { labels: 3 });
    }
    if (screen === "coin") {
      const canvas = document.getElementById("aKline");
      HP.charts.drawCandles(canvas, {
        grid: "rgba(17,20,23,.06)",
        axis: "#717984",
        up: "#d96a7a",
        down: "#4f9d8a",
        line: "#2f7d92",
        badgeBg: "#2f7d92",
        badgeInk: "#fff",
      }, { axisLabels: true, badge: true });
    }
  }

  window.VARIANTS = window.VARIANTS || {};
  window.VARIANTS.A = {
    key: "A",
    name: "站内工作台",
    en: "STATION DESK",
    tagline: "桌面端玻璃工作区的手机压缩版。左轨 + 玻璃卡 + 墨色文字，信息密度最高，第一眼最像「她本来就住在这儿」。",
    bullets: [
      "结构：左轨常驻，模块是同一层工作区的切换",
      "对话：白玻璃气泡，想 / 说 / 动作 / 用量四层分明",
      "记忆：网络图置顶，权重与代谢是可见的一等公民",
      "代价：左轨吃掉 58px 宽度；小屏上永远少一列",
    ],
    trade: "适合：想保留桌面端的「工作台」感，把手机当第二现场。",
    note: "玻璃与青白宇宙底直接取自桌面主界面；手机端只做了压缩，没有换语言。",
    screens: screens,
    top: top,
    rail: rail,
    render: render,
    mount: mount,
  };
})();
