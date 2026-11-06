// 首页「全服行情」：只读黑塔币共享市场接口，拿不到就整段隐藏
(function () {
  var cfg = window.HERTA_SITE || {};
  var base = (cfg.coinApi || "").replace(/\/+$/, "");
  var section = document.getElementById("server-stats");
  if (!section || !base) return;

  var priceEl = document.getElementById("stat-price");
  var changeEl = document.getElementById("stat-change");
  var volumeEl = document.getElementById("stat-volume");
  var sessionEl = document.getElementById("stat-session");
  var topEl = document.getElementById("stat-top");
  var noteEl = document.getElementById("stat-note");
  var loaded = false;

  function setText(el, text) {
    if (el) el.textContent = text;
  }

  function fmtVolume(n) {
    if (!Number.isFinite(n)) return "—";
    return n >= 10000 ? (n / 10000).toFixed(2) + " 万" : String(Math.round(n));
  }

  function fetchJson(path) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 8000);
    return fetch(base + path, {
      signal: ctl.signal,
      cache: "no-store",
      headers: { Accept: "application/json" }
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).finally(function () {
      clearTimeout(timer);
    });
  }

  function renderTop(board) {
    var rows = board && board.leaderboard ? board.leaderboard.slice(0, 3) : [];
    topEl.textContent = "";
    if (!rows.length) {
      var empty = document.createElement("div");
      empty.className = "line";
      empty.textContent = "暂无持仓数据";
      topEl.appendChild(empty);
      return;
    }
    rows.forEach(function (row) {
      var line = document.createElement("div");
      line.className = "line";
      var name = document.createElement("span");
      name.textContent = row.name || "—";
      var value = document.createElement("span");
      value.className = "mono";
      value.textContent = Number(row.value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
      line.appendChild(name);
      line.appendChild(value);
      topEl.appendChild(line);
    });
  }

  function render(daily, board) {
    var m = daily && daily.market;
    if (!m) throw new Error("no market");

    var price = Number(m.price != null ? m.price : m.close);
    var pct = Number(m.changePct);
    setText(priceEl, Number.isFinite(price) ? price.toFixed(2) : "—");
    setText(changeEl, (pct >= 0 ? "+" : "") + (Number.isFinite(pct) ? pct.toFixed(2) : "—") + "% 今日");
    if (changeEl) changeEl.style.color = pct >= 0 ? "var(--accent)" : "#a94a45";
    setText(volumeEl, fmtVolume(Number(m.volume)));
    setText(sessionEl, "第 " + (m.sessionNumber || "—") + " 场 · " + (m.statusLabel || "—"));
    renderTop(board);

    var now = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    setText(noteEl, "数据来自共享市场接口 · " + now + " 更新 · 只读行情，不包含个人交易记录");
    section.hidden = false;
    loaded = true;
  }

  function tick() {
    Promise.all([
      fetchJson("/api/daily"),
      fetchJson("/api/leaderboard").catch(function () { return null; })
    ]).then(function (res) {
      render(res[0], res[1]);
    }).catch(function () {
      if (!loaded) {
        section.hidden = true;
      } else {
        setText(noteEl, "更新失败，显示上次数据。");
      }
    });
  }

  tick();
  setInterval(function () {
    if (document.visibilityState === "visible") tick();
  }, 30000);
})();
