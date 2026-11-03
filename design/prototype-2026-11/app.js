/* 原型壳：URL 状态、方向/模块切换、键盘、只读提示。
 * 这里没有一行业务逻辑；所有屏幕都由 variant-*.js 渲染。
 */
(function () {
  const V = window.VARIANTS || {};
  const PREFERRED = ["D", "A", "B", "C"];
  const ORDER = PREFERRED.filter(function (k) { return V[k]; }).concat(
    Object.keys(V).filter(function (k) { return PREFERRED.indexOf(k) < 0; })
  );
  const params = new URLSearchParams(location.search);
  const screenEl = document.getElementById("screen");
  const tabsEl = document.getElementById("tabs");
  const notesEl = document.getElementById("notes");
  const modsEl = document.getElementById("modsList");
  const menuEl = document.getElementById("moduleMenu");
  const swKey = document.getElementById("swKey");
  const swName = document.getElementById("swName");
  const swScreen = document.getElementById("swScreen");
  const swMods = document.getElementById("swMods");
  const captionVariant = document.getElementById("captionVariant");
  const captionScreen = document.getElementById("captionScreen");
  const toastEl = document.getElementById("toast");
  const GROUPS = ["交流", "她的内部", "系统", "界面"];

  const state = {
    variant: ORDER.indexOf(params.get("variant")) >= 0 ? params.get("variant") : ORDER[0],
    screen: HP.modules.some(function (m) { return m.key === params.get("screen"); })
      ? params.get("screen")
      : "chat",
    theme: params.get("theme") === "dark" ? "dark" : "light",
  };

  let toastTimer = null;
  let paintTimer = null;

  function moduleOf(key) {
    return HP.modules.find(function (m) { return m.key === key; }) || HP.modules[0];
  }
  function screenLabel(key) {
    return moduleOf(key).label;
  }
  function screenIndex(key) {
    return HP.modules.findIndex(function (m) { return m.key === key; });
  }

  function updateURL() {
    try {
      const url = new URL(location.href);
      url.searchParams.set("variant", state.variant);
      url.searchParams.set("screen", state.screen);
      url.searchParams.set("theme", state.theme);
      history.replaceState(null, "", url.toString());
    } catch (e) {
      /* file:// 下某些浏览器会拒绝；原型不靠它工作 */
    }
  }

  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = "原型只读 · " + (message || "这个按钮");
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("show");
    }, 2000);
  }

  function paintCharts() {
    const v = V[state.variant];
    if (!v || typeof v.mount !== "function") return;
    try {
      v.mount(state.screen);
    } catch (e) {
      console.warn("prototype chart mount failed", e);
    }
  }

  function schedulePaint() {
    requestAnimationFrame(function () {
      requestAnimationFrame(paintCharts);
    });
  }

  function renderTabs() {
    tabsEl.innerHTML = ORDER.map(function (key) {
      const v = V[key];
      return '<button type="button" class="tab' + (key === state.variant ? " on" : "") +
        '" data-variant="' + key + '" role="tab" aria-selected="' + (key === state.variant) + '"><span>' +
        key + "</span>" + v.name + "</button>";
    }).join("");
  }

  function renderNotes() {
    const v = V[state.variant];
    const isMix = state.variant === "D";
    const dirs = ORDER.filter(function (k) { return k !== "D"; });
    const n = isMix ? "FINAL" : String(dirs.indexOf(state.variant) + 1).padStart(2, "0");
    const total = isMix ? "3+1" : "03";
    notesEl.innerHTML =
      '<div class="num">' + n + " / " + total + "</div>" +
      "<h2>" + v.name + "</h2>" +
      '<div class="en">' + v.en + "</div>" +
      '<p class="tagline">' + v.tagline + "</p>" +
      "<ul>" + v.bullets.map(function (b) { return "<li>" + b + "</li>"; }).join("") + "</ul>" +
      '<div class="trade">' + v.trade + "</div>" +
      '<p class="tagline" style="margin-top:12px;font-size:11px;color:var(--g-faint)">' + v.note + "</p>";
  }

  function renderMods() {
    modsEl.innerHTML = GROUPS.map(function (g) {
      const list = HP.modules.filter(function (m) { return m.group === g; });
      if (!list.length) return "";
      return '<div class="modGroup"><div class="gh">' + g + '</div><div class="modList">' +
        list.map(function (m) {
          const no = String(screenIndex(m.key) + 1).padStart(2, "0");
          return '<button type="button" class="modBtn' + (m.key === state.screen ? " on" : "") +
            '" data-screen="' + m.key + '"><i>' + no + "</i>" + m.label + "</button>";
        }).join("") + "</div></div>";
    }).join("");
  }

  function renderMenu() {
    menuEl.innerHTML = GROUPS.map(function (g) {
      const list = HP.modules.filter(function (m) { return m.group === g; });
      if (!list.length) return "";
      return '<div class="mGroup"><div class="mHead">' + g + "</div>" +
        list.map(function (m) {
          const no = String(screenIndex(m.key) + 1).padStart(2, "0");
          return '<button type="button" class="mItem' + (m.key === state.screen ? " on" : "") +
            '" data-screen="' + m.key + '"><i>' + no + "</i>" + m.label + "</button>";
        }).join("") + "</div>";
    }).join("");
  }

  function renderChrome() {
    const v = V[state.variant];
    renderTabs();
    renderNotes();
    renderMods();
    renderMenu();
    swKey.textContent = state.variant;
    swName.textContent = v.name;
    swScreen.textContent = "/ " + screenLabel(state.screen);
    captionVariant.textContent = state.variant + " · " + v.name;
    captionScreen.textContent = screenLabel(state.screen);
  }

  function applyTheme() {
    const root = screenEl.querySelector(".variantRoot");
    if (root) root.classList.toggle("is-dark", state.theme === "dark");
    document.querySelectorAll("[data-theme-label]").forEach(function (el) {
      el.textContent = state.theme === "dark" ? "日" : "夜";
    });
    document.querySelectorAll("[data-theme-state]").forEach(function (el) {
      el.textContent = state.theme === "dark" ? "开" : "关";
    });
  }

  function render() {
    const v = V[state.variant];
    if (!v) return;
    screenEl.innerHTML = v.render(state.screen);
    applyTheme();
    renderChrome();
    updateURL();
    schedulePaint();
  }

  function setVariant(key) {
    if (!V[key]) return;
    state.variant = key;
    closeMenu();
    render();
  }

  function setScreen(key) {
    if (!HP.modules.some(function (m) { return m.key === key; })) return;
    state.screen = key;
    closeMenu();
    render();
  }

  function stepVariant(dir) {
    const i = ORDER.indexOf(state.variant);
    const next = ORDER[(i + dir + ORDER.length) % ORDER.length];
    setVariant(next);
  }

  function openMenu() {
    renderMenu();
    menuEl.classList.add("open");
    swMods.classList.add("on");
    swMods.setAttribute("aria-expanded", "true");
  }
  function closeMenu() {
    menuEl.classList.remove("open");
    swMods.classList.remove("on");
    swMods.setAttribute("aria-expanded", "false");
  }
  function toggleMenu() {
    if (menuEl.classList.contains("open")) closeMenu();
    else openMenu();
  }

  document.addEventListener("click", function (e) {
    const tab = e.target.closest("[data-variant]");
    if (tab) {
      setVariant(tab.getAttribute("data-variant"));
      return;
    }
    const themeBtn = e.target.closest("[data-theme-toggle]");
    if (themeBtn) {
      e.preventDefault();
      state.theme = state.theme === "dark" ? "light" : "dark";
      applyTheme();
      updateURL();
      schedulePaint();
      return;
    }
    const target = e.target.closest("[data-screen]");
    if (target) {
      e.preventDefault();
      setScreen(target.getAttribute("data-screen"));
      return;
    }
    const demo = e.target.closest("[data-demo]");
    if (demo && screenEl.contains(demo)) {
      e.preventDefault();
      showToast(demo.getAttribute("data-demo") || "这个按钮");
      return;
    }
    if (!menuEl.contains(e.target) && !swMods.contains(e.target)) closeMenu();
  });

  document.getElementById("prevBtn").addEventListener("click", function () { stepVariant(-1); });
  document.getElementById("nextBtn").addEventListener("click", function () { stepVariant(1); });
  swMods.addEventListener("click", function (e) {
    e.stopPropagation();
    toggleMenu();
  });

  document.addEventListener("keydown", function (e) {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); stepVariant(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stepVariant(1); }
    else if (e.key === "Escape") { closeMenu(); }
    else if (e.key === "m" || e.key === "M") { e.preventDefault(); toggleMenu(); }
  });

  window.addEventListener("resize", function () {
    clearTimeout(paintTimer);
    paintTimer = setTimeout(paintCharts, 140);
  });

  render();
})();
