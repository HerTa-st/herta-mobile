
/* 方向 B · 档案室
 * 纸、墨、编号、图版。没有玻璃、没有左轨；导航是一本卷目。
 * 同一个「她」，换成编辑排版的语言：正文衬线、元数据等宽、唯一的朱红只用于印章。
 */
(function () {
  const HP = window.HP;
  const D = HP.data;
  const esc = HP.esc;
  const icon = HP.icon;
  const SERIF = '"Songti SC","Noto Serif SC","Source Han Serif SC",SimSun,serif';

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function moduleIndex(key) {
    const i = HP.modules.findIndex(function (m) { return m.key === key; });
    return i < 0 ? 0 : i;
  }
  function pageNo(key) { return pad(moduleIndex(key) + 1); }
  function prevKey(key) { return HP.modules[(moduleIndex(key) + 11) % 12].key; }
  function nextKey(key) { return HP.modules[(moduleIndex(key) + 1) % 12].key; }

  function chapter(key) {
    const i = moduleIndex(key);
    const m = HP.modules[i];
    return `<header class="b-chapter">
      <span class="b-chapterNo">CH. ${pad(i + 1)}</span>
      <span class="b-chapterMeta">${m.group} / ${m.label}</span>
      <span class="b-chapterRule"></span>
    </header>`;
  }

  function title(key, t, lede) {
    const i = moduleIndex(key);
    return `<div class="b-title">
      <div class="b-titleKicker">HERTA · 手机端 / 2026.11</div>
      <h1>${t}</h1>
      ${lede ? `<p class="b-lede">${lede}</p>` : ""}
      <div class="b-titleRule"><span>${pad(i + 1)}</span></div>
    </div>`;
  }

  function stamp(text, cls) {
    return `<span class="b-stamp ${cls || ""}">${text}</span>`;
  }

  function chatEntries() {
    return D.messages.map(function (m) {
      if (m.kind === "user") {
        return `<div class="b-entry b-entryUser">
          <div class="b-entryMargin"><span>你</span><em>${m.time}</em></div>
          <div class="b-entryBody"><p>${esc(m.text)}</p></div>
        </div>`;
      }
      if (m.kind === "tool") {
        return `<div class="b-tool"><span>${icon("search", 11)}</span>查了：${esc(m.text)} <em>${esc(m.detail)}</em></div>`;
      }
      if (m.kind === "sticker") {
        return `<div class="b-entry b-entryHers">
          <div class="b-entryMargin"><span>她</span><em>${m.time}</em></div>
          <div class="b-entryBody">
            <div class="b-paste">
              <div class="b-pasteTile">摸鱼中</div>
              <div><b>${esc(m.label)}</b><small>她自己挑的 · 已贴入记录</small></div>
            </div>
          </div>
        </div>`;
      }
      return `<div class="b-entry b-entryHers">
        <div class="b-entryMargin"><span>她</span><em>${m.time}</em></div>
        <div class="b-entryBody">
          ${m.thought ? `<div class="b-thought"><b>想</b><span>${esc(m.thought)}</span></div>` : ""}
          <p class="b-say">${esc(m.text)}</p>
          ${m.action ? `<p class="b-action">（${esc(m.action)}）</p>` : ""}
          <div class="b-entryFoot">
            ${m.tokens ? `<span class="b-tok">${esc(m.tokens)}</span>` : ""}
            <button data-demo="念这句（原型不出声）">▷ 念</button>
          </div>
        </div>
      </div>`;
    }).join("");
  }

  const screens = {
    chat: function () {
      return `${chapter("chat")}
        ${title("chat", "通信记录", "她与你的往来原件，按时间归档。方框里是她没说出口的。")}
        <div class="b-logHead"><span>记录 No. 014</span><span>2026-11-03 · 02:11—02:16</span></div>
        <div class="b-entries">${chatEntries()}</div>
        <div class="b-composer">
          <div class="b-composeLabel">写给她</div>
          <div class="b-composeLine">
            <span>给黑塔发消息…</span>
            <button class="b-sendStamp" data-demo="寄出（原型不写库）">寄出</button>
          </div>
          <div class="b-composeFoot"><span>Enter 寄出 · 长图自动切段</span><span>${HP.herta.model}</span></div>
        </div>
      `;
    },

    sessions: function () {
      const groups = ["今天", "昨天", "导入"];
      return `${chapter("sessions")}
        ${title("sessions", "往来目录", "42 条会话，1,208 块。导入的只归档，不自动进记忆。")}
        <div class="b-searchLine"><span>检索</span><i></i><b>搜记忆和对话…</b></div>
        ${groups.map(function (g) {
          const list = D.sessions.filter(function (s) { return s.group === g; });
          if (!list.length) return "";
          return `<section class="b-sessGroup">
            <div class="b-groupHead"><span>${g}</span><span>${pad(list.length)}</span></div>
            ${list.map(function (s, k) {
              return `<button class="b-sessRow ${s.active ? "on" : ""}" data-demo="打开会话：${esc(s.title)}">
                <span class="b-sessNo">${pad(k + 1)}</span>
                <span class="b-sessTitle">${esc(s.title)}</span>
                <span class="b-sessMeta">${s.origin === "导入" ? "导入 · " : ""}${s.meta} · ${s.when}</span>
              </button>`;
            }).join("")}
          </section>`;
        }).join("")}
        <section class="b-volumes">
          <div class="b-groupHead"><span>卷目 · 全部模块</span><span>12</span></div>
          <div class="b-volGrid">
            ${HP.modules.map(function (m, i) {
              return `<button class="b-volItem ${m.key === "sessions" ? "on" : ""}" data-screen="${m.key}"><i>${pad(i + 1)}</i>${m.label}</button>`;
            }).join("")}
          </div>
        </section>
        <p class="b-footnote">全文检索同时命中记忆与会话；点命中跳到那一块。</p>
      `;
    },

    memory: function () {
      const mem = D.memories;
      return `${chapter("memory")}
        ${title("memory", "记忆目录", "58 个节点，67 条边。权重不是分数，是她还会不会想起。")}
        <div class="b-plate">
          <div class="b-plateHead"><span>图版 I · 记忆网络</span><span>按有效权重</span></div>
          <div class="b-plateCanvas"><canvas id="bNet"></canvas></div>
          <div class="b-plateFoot">
            <span><i class="ep"></i>情景 21</span><span><i class="sem"></i>语义 12</span><span><i class="note"></i>语气 1</span>
            <em>8 小时前浅睡</em>
          </div>
        </div>
        <div class="b-memMeta">
          <div><b>34</b><span>活跃</span></div>
          <div><b>8</b><span>已压缩</span></div>
          <div><b>0.72</b><span>平均权重</span></div>
          <div><b>90d</b><span>半衰期</span></div>
        </div>
        <div class="b-memActions">
          <button class="b-btn" data-demo="浅睡：去重 / 衰减 / 剪边">浅睡</button>
          <button class="b-btn b-btnInk" data-demo="深睡：六阶段 LLM 加工">深睡</button>
          <span>今晚 2 / 8</span>
        </div>
        <div class="b-groupHead"><span>目录</span><span>按权重排</span></div>
        <div class="b-memList">
          ${mem.nodes.slice(0, 6).map(function (n, i) {
            return `<button class="b-memRow" data-demo="打开记忆：${esc(n.title)}">
              <span class="b-memNo">${pad(i + 1)}</span>
              <span class="b-memTier">${HP.tierName[n.tier]}</span>
              <span class="b-memMain"><b>${esc(n.title)}</b><small>${esc(n.gist)}</small></span>
              <span class="b-memWeight">${n.weight.toFixed(2)}</span>
            </button>`;
          }).join("")}
        </div>
        <div class="b-noteCard">
          <div class="b-noteHead">她写字的样子 · v3</div>
          <p>${esc(mem.voice)}</p>
        </div>
        <p class="b-footnote">深睡只在有 key、有网、前台时 opportunistic 跑；cap 8 次/晚。</p>
      `;
    },

    coin: function () {
      const c = D.coin;
      const up = c.pct >= 0;
      return `${chapter("coin")}
        ${title("coin", "行情公报", "HTC/USDT · 工作日 09:30—15:00。红涨绿跌，和网页同源。")}
        <div class="b-marketHead">
          <div>
            <div class="b-marketName">黑塔币 <span>HTC</span></div>
            <div class="b-marketPrice">${HP.fmtPrice(c.price)} <em class="${up ? "up" : "down"}">${up ? "+" : ""}${c.change.toFixed(4)} / ${HP.fmtPct(c.pct)}</em></div>
            <div class="b-marketStatus">${c.status} · 量 ${c.volume}</div>
          </div>
          <div class="b-marketStamp">${stamp(up ? "涨" : "跌", up ? "" : "green")}</div>
        </div>
        <div class="b-plate b-plateChart">
          <div class="b-plateHead"><span>图版 II · 分钟 K</span><span>MA5</span></div>
          <div class="b-chartCanvas"><canvas id="bKline"></canvas></div>
          <div class="b-plateFoot"><span>开 ${c.open.toFixed(3)}</span><span>高 ${c.high.toFixed(3)}</span><span>低 ${c.low.toFixed(3)}</span><em>随已揭示行情铺满</em></div>
        </div>
        <div class="b-tables">
          <div class="b-tableBlock">
            <div class="b-groupHead"><span>持仓</span><span>单机钱包</span></div>
            <table class="b-table">
              <tr><td>持有</td><td class="num">${c.wallet.htc.toLocaleString()} HTC</td></tr>
              <tr><td>成本价</td><td class="num">${c.wallet.cost.toFixed(3)}</td></tr>
              <tr><td>浮动盈亏</td><td class="num up">+${c.wallet.pnl.toFixed(1)} HTC</td></tr>
              <tr><td>收益率</td><td class="num up">+${c.wallet.pnlPct}%</td></tr>
            </table>
          </div>
          <div class="b-tableBlock">
            <div class="b-groupHead"><span>签到</span><span>连签 ${c.signin.streak} 天</span></div>
            <div class="b-coupon">
              <div class="b-couponBig">+${c.signin.reward} <small>HTC</small></div>
              <p>${esc(c.signin.note)}</p>
              <button data-demo="签到（以接口 serverTime 为准）">今日签到</button>
            </div>
          </div>
        </div>
        <div class="b-groupHead"><span>共享市场</span><span>38 人在线 · 你第 6</span></div>
        <table class="b-table b-tableRanks">
          <tr><td>01</td><td>空间站常客</td><td class="num up">+18.4%</td></tr>
          <tr><td>02</td><td>螺丝咕姆</td><td class="num up">+12.7%</td></tr>
          <tr class="me"><td>03</td><td>梦源</td><td class="num up">+9.2%</td></tr>
          <tr><td>04</td><td>阮·梅的盆栽</td><td class="num up">+4.1%</td></tr>
        </table>
        <p class="b-footnote">示例数据 · v1 不接她、不做交易；净买入推价，服务端账本。</p>
      `;
    },

    broadcast: function () {
      const b = D.broadcast;
      return `${chapter("broadcast")}
        <div class="b-newspaper">
          <div class="b-paperName">星际和平播报</div>
          <div class="b-paperSub">SPACE STATION HERTA · 空间站「黑塔」转播</div>
          <div class="b-paperMeta">
            <span>第 ${b.no} 期</span><span>${b.date} · ${b.weekday}</span><span>${b.status}</span>
          </div>
          <div class="b-paperRule"></div>
          <h1 class="b-paperLead">${esc(b.lead.title)}</h1>
          <div class="b-paperByline">${esc(b.lead.source)} · ${esc(b.lead.domain)} · ${b.lead.read}</div>
          <p class="b-paperLede">${esc(b.lead.summary)}</p>
          <blockquote class="b-pullquote"><span>评</span>${esc(b.lead.comment)}</blockquote>
          <div class="b-paperActions">
            <button class="b-btn" data-demo="读原文：抓网页压成要点">读原文</button>
            <button class="b-btn b-btnInk" data-demo="把这条丢回会话里聊">和她聊这条</button>
          </div>
        </div>
        <div class="b-paperDivider"><span>本期其余 · ${b.items.length + 1} 条</span></div>
        <div class="b-briefs">
          ${b.items.map(function (it) {
            return `<button class="b-brief ${it.easter ? "easter" : ""}" data-demo="打开：${esc(it.title)}">
              <div class="b-briefTag">${esc(it.tag)} · ${esc(it.source)}</div>
              <b>${esc(it.title)}</b>
              <p>${esc(it.summary)}</p>
              <em>评 · ${esc(it.comment)}</em>
            </button>`;
          }).join("")}
        </div>
        <div class="b-paperTags"><span>关注标签</span>${b.tags.map(function (t) { return `<b>${t}</b>`; }).join("")}<button data-demo="编辑关注标签">＋</button></div>
        <div class="b-paperHistory">
          ${b.history.map(function (h) { return `<button data-demo="打开第 ${h.no} 期"><b>第 ${h.no} 期</b><span>${h.title}</span></button>`; }).join("")}
        </div>
        <p class="b-footnote">彩蛋条目一眼可辨；真新闻点开能回到原文。</p>
      `;
    },

    settings: function () {
      return `${chapter("settings")}
        ${title("settings", "登记簿", "她的一切设置都在本机。没有一处上传，API Key 不进备份。")}
        <div class="b-ledgerHead">
          <div class="b-ledgerName">黑塔 <em>herta</em></div>
          <div class="b-ledgerState">本机 · 单人格</div>
        </div>
        <div class="b-shortcuts">
          <button data-screen="caps"><span>权限</span><b>她能做什么</b><em>6 项开着</em></button>
          <button data-screen="tools"><span>附记</span><b>工具调用</b><em>今天 9 次</em></button>
          <button data-screen="backup"><span>封包</span><b>备份与迁移</b><em>18.4 MB</em></button>
        </div>
        ${D.settingsGroups.map(function (g, gi) {
          return `<section class="b-ledgerGroup">
            <div class="b-groupHead"><span>${g.label}</span><span>${pad(g.items.length)}</span></div>
            ${g.items.map(function (it) {
              const attr = it.type === "link" ? `data-screen="${it.screen}"` : `data-demo="${esc(it.label)}（原型不保存）"`;
              return `<button class="b-ledgerRow" ${attr}>
                <span class="b-ledgerLabel">${esc(it.label)}${it.hint ? `<small>${esc(it.hint)}</small>` : ""}</span>
                <span class="b-ledgerDots"></span>
                <span class="b-ledgerValue">${it.type === "toggle" ? `<i class="b-check ${it.value ? "on" : ""}">${it.value ? "☑" : "□"}</i>` : esc(it.value)}</span>
              </button>`;
            }).join("")}
          </section>`;
        }).join("")}
        <section class="b-ledgerGroup">
          <div class="b-groupHead"><span>界面</span><span>02</span></div>
          <button class="b-ledgerRow" data-screen="onboarding"><span class="b-ledgerLabel">开屏与引导</span><span class="b-ledgerDots"></span><span class="b-ledgerValue">翻 →</span></button>
          <button class="b-ledgerRow" data-screen="system"><span class="b-ledgerLabel">设计系统</span><span class="b-ledgerDots"></span><span class="b-ledgerValue">翻 →</span></button>
        </section>
        <p class="b-footnote">这一页像登记簿，不像控制面板：每一行都能被念出来。</p>
      `;
    },

    caps: function () {
      return `${chapter("caps")}
        ${title("caps", "权限登记", "她能碰手机到什么程度。每一项单独登记，默认全关。")}
        <table class="b-register">
          <thead><tr><th>项目</th><th>状态</th><th>边界</th></tr></thead>
          <tbody>
            ${D.caps.map(function (c) {
              return `<tr><td><b>${esc(c.label)}</b><span>${esc(c.detail)}</span></td>
                <td class="${c.state}">${c.state === "granted" ? "已开" : c.state === "ask" ? "询问" : "关闭"}</td>
                <td>${esc(c.note)}</td></tr>`;
            }).join("")}
          </tbody>
        </table>
        <div class="b-registerNote">
          <b>两道高权限门</b>
          <p>无障碍与相册单列。她在会话里只能说「我需要」，不能自己开；开了也会在工具记录里留痕。</p>
        </div>
        <p class="b-footnote">6 / 9 项开着。通知、定位、相机按需申请。</p>
      `;
    },

    import: function () {
      return `${chapter("import")}
        ${title("import", "移交单", "从 DeepSeek 把你说过的话移交过来。只归档原文，不自动进记忆。")}
        <div class="b-slip">
          <div class="b-slipHead"><span>移交方式</span>${stamp("仅归档", "red")}</div>
          <div class="b-slipField"><span>分享链接</span><div>https://chat.deepseek.com/share/…<button data-demo="取链接（原型不联网）">取</button></div></div>
          <div class="b-slipOr">或</div>
          <div class="b-slipDrop" data-demo="选 JSON 文件（原型不读文件）">
            ${icon("import", 18)}
            <b>选一个导出的 JSON</b>
            <small>油猴脚本 / 旧版导出</small>
          </div>
          <div class="b-slipFoot">${esc(D.importData.last)}</div>
        </div>
        <div class="b-groupHead"><span>归档之后</span><span>03 条</span></div>
        <ol class="b-steps">
          <li><b>01</b><span>原文按块归档，标「导入」。</span></li>
          <li><b>02</b><span>打开那一条，点「让她做梦」才消化。</span></li>
          <li><b>03</b><span>源文件可留可删，删除不进记忆。</span></li>
        </ol>
        <div class="b-groupHead"><span>文件库</span><span>12 件 · 2.1 MB</span></div>
        <table class="b-table b-files">
          <tr><td>设计-v1.md</td><td class="num">8.2 KB</td><td class="num">01:58</td></tr>
          <tr><td>Herta-源码通读报告.pdf</td><td class="num">1.4 MB</td><td class="num">昨天</td></tr>
          <tr><td>播报-第16期.docx</td><td class="num">88 KB</td><td class="num">11-02</td></tr>
        </table>
        <p class="b-footnote">文本单件 ≤512KB，整库 ≤2MB；文档源文件 ≤20MB。</p>
      `;
    },

    backup: function () {
      const b = D.backup;
      return `${chapter("backup")}
        ${title("backup", "封包清单", "换机时带走的东西。API Key 不在里面。")}
        <div class="b-manifestHead">
          <div><span>整包体积</span><b>${b.size}</b></div>
          <div class="b-manifestStamp">${stamp("待封", "red")}</div>
        </div>
        <table class="b-table b-manifest">
          <thead><tr><th>项</th><th>数量</th><th>备注</th></tr></thead>
          <tbody>
            ${b.items.map(function (it) {
              return `<tr><td>${esc(it.label)}</td><td>${esc(it.count)}</td><td>${esc(it.note)}</td></tr>`;
            }).join("")}
          </tbody>
        </table>
        <button class="b-btn b-btnInk b-btnWide" data-demo="封包（原型只显示，不写文件）">封包</button>
        <div class="b-restore">
          <button class="b-btn" data-demo="从文件恢复（原型不读文件）">从备份恢复</button>
          <button class="b-btn" data-demo="导出单个会话">只导出会话</button>
        </div>
        <p class="b-footnote">${esc(b.last)} · 恢复时本机已有钱包则不覆盖。</p>
      `;
    },

    tools: function () {
      return `${chapter("tools")}
        ${title("tools", "附记", "她动过什么手。工具旁白不进正文，只记在这里。")}
        <div class="b-logMeta"><span>今天</span><b>9</b><span>次调用</span><em>1 次被拒</em></div>
        <table class="b-table b-log">
          <thead><tr><th>时</th><th>工具</th><th>结果</th><th>耗</th></tr></thead>
          <tbody>
            ${D.tools.map(function (t) {
              return `<tr class="${t.tone}"><td class="num">${t.time}</td><td><b>${esc(t.tool)}</b><span>${esc(t.args)}</span></td><td>${esc(t.result)}</td><td class="num">${t.ms}</td></tr>`;
            }).join("")}
          </tbody>
        </table>
        <p class="b-footnote">被系统拒绝的那一次也留痕——比省略更诚实。</p>
      `;
    },

    onboarding: function () {
      return `<div class="b-cover">
        <div class="b-coverTop">HERTA · MOBILE EDITION</div>
        <div class="b-coverFrame">
          <div class="b-coverMark">H</div>
          <h1>HERTA</h1>
          <div class="b-coverSub">一本关于她的档案</div>
          <div class="b-coverRule"></div>
          ${HP.avatar("b-coverAvatar")}
          <p>她记得你第一次说睡不着。也记得你后来每次都说「没事」。</p>
          <button class="b-coverOpen" data-demo="翻开（原型直接进入对话）">翻开</button>
          <button class="b-coverImport" data-screen="import">或，从 DeepSeek 移交</button>
        </div>
        <div class="b-coverColophon">
          <span>初版 · 2026.11</span><span>私人物品 · 不外借</span>
        </div>
      </div>`;
    },

    system: function () {
      return `${chapter("system")}
        ${title("system", "字样", "这一版用纸和墨说话：衬线正文、等宽元数据、朱红只盖印章。")}
        <div class="b-specimen">
          <div class="b-specimenRow"><span>Display / 宋体</span><b class="b-speDisplay">她在这里。</b></div>
          <div class="b-specimenRow"><span>Title / 宋体</span><b class="b-speTitle">记忆目录</b></div>
          <div class="b-specimenRow"><span>Body / 黑体</span><b class="b-speBody">先拆前提，再回答问题。不哄。</b></div>
          <div class="b-specimenRow"><span>Meta / 等宽</span><b class="b-speMeta">EP · 0.86 · 3 天前</b></div>
        </div>
        <div class="b-groupHead"><span>颜色</span><span>4</span></div>
        <div class="b-specColors">
          <div style="background:#111417;color:#f6f3ec"><b>墨</b><em>#111417</em></div>
          <div style="background:#8a3a2e;color:#f6f3ec"><b>朱</b><em>#8A3A2E</em></div>
          <div style="background:#2f6b66;color:#f6f3ec"><b>青</b><em>#2F6B66</em></div>
          <div style="background:#f6f3ec;color:#111417;border:1px solid rgba(17,20,23,.2)"><b>纸</b><em>#F6F3EC</em></div>
        </div>
        <div class="b-groupHead"><span>部件</span><span>05</span></div>
        <div class="b-specParts">
          <button class="b-btn">次级</button>
          <button class="b-btn b-btnInk">主按钮</button>
          <span class="b-stamp">印章</span>
          <i class="b-check on">☑</i><i class="b-check">□</i>
          <div class="b-lineInput"><span>一条下划线输入</span></div>
        </div>
        <p class="b-footnote">这一版最不像 App，也最像「她留下来的东西」；代价是密度低、扫读慢。</p>
      `;
    },
  };

  function indexOverlay(screen) {
    return `<div class="b-indexOverlay">
      <label for="bIndex" class="b-indexClose">关闭索引 ×</label>
      <div class="b-indexHead">
        <div class="b-indexKicker">卷目 / CONTENTS</div>
        <h2>十二个模块</h2>
        <p>点任意一卷翻过去。</p>
      </div>
      <div class="b-indexList">
        ${HP.modules.map(function (m, i) {
          return `<button class="b-indexItem ${m.key === screen ? "on" : ""}" data-screen="${m.key}">
            <i>${pad(i + 1)}</i><span>${m.label}</span><em>${m.group}</em>
          </button>`;
        }).join("")}
      </div>
      <div class="b-indexFoot">HERTA · 手机端 / 2026.11 / 方案 B</div>
    </div>`;
  }

  function render(screen) {
    const i = moduleIndex(screen);
    const content = (screens[screen] || screens.chat)();
    return `<div class="variantRoot b-root">
      <div class="b-app">
        <input type="checkbox" id="bIndex" class="b-indexCheck" />
        <header class="b-mast">
          <div class="b-brand">HERTA<span>档案</span></div>
          <div class="b-mastMeta">2026.11 · 本机</div>
          <label for="bIndex" class="b-indexOpen">索引</label>
        </header>
        <main class="b-body">${content}</main>
        <footer class="b-folio">
          <button data-screen="${prevKey(screen)}" aria-label="上一页">←</button>
          <span>第 ${pad(i + 1)} / 12 页 <em>${HP.modules[i].short}</em></span>
          <button data-screen="${nextKey(screen)}" aria-label="下一页">→</button>
        </footer>
        ${indexOverlay(screen)}
      </div>
    </div>`;
  }

  function mount(screen) {
    if (screen === "memory") {
      HP.charts.drawNetwork(document.querySelector("#bNet"), {
        grid: "rgba(17,20,23,.07)",
        axis: "#6f675c",
        up: "#8a3a2e",
        down: "#2f6b66",
        line: "#2f6b66",
        ring: "rgba(17,20,23,.07)",
        edge: "#8a7f6d",
        nodeRing: "#f6f3ec",
        label: "#3d372e",
        tier: { ep: "#2f6b66", sem: "#8a3a2e", note: "#a07830" },
      }, { labels: 3 });
    }
    if (screen === "coin") {
      HP.charts.drawCandles(document.querySelector("#bKline"), {
        grid: "rgba(17,20,23,.08)",
        axis: "#6f675c",
        up: "#8a3a2e",
        down: "#2f6b66",
        line: "#2f6b66",
        badgeBg: "#111417",
        badgeInk: "#f6f3ec",
        hollowDown: true,
      }, { axisLabels: true, badge: true });
    }
  }

  window.VARIANTS = window.VARIANTS || {};
  window.VARIANTS.B = {
    key: "B",
    name: "档案室",
    en: "THE ARCHIVE",
    tagline: "把 App 做成一册她的档案：纸面、卷目、图版、印章。导航不是 tab，而是翻页和索引。",
    bullets: [
      "结构：没有常驻导航，底部只有页码与翻页",
      "对话：通信记录体，想是页边批注，动作在句后",
      "记忆与行情：像图版与公报，表格与印章承担层级",
      "代价：密度低、扫读慢；高频操作要多翻一页",
    ],
    trade: "适合：想让她「像一件被保存下来的东西」，私密、慢、有手感。",
    note: "朱红只用于印章与「评」，青只用于图版；两种颜色都有明确职责。",
    screens: screens,
    render: render,
    mount: mount,
  };
})();
