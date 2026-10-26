// ==UserScript==
// @name         Herta 对话导出器
// @namespace    herta-mobile
// @version      0.2.0
// @description  把 chat.deepseek.com 里的对话导出成 herta-import.v1.json，供 Herta 手机端导入
// @match        https://chat.deepseek.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/**
 * 为什么是"被动截获 + 自动翻页"，而不是直接调接口：
 *
 * DeepSeek 没有导出功能，内部接口（/api/v0/...）是非公开契约，请求体与签名随时会变。
 * 所以这里**不猜请求**，只做两件事：
 *   1) 钩住 fetch / XHR，把站点自己请求回来的 JSON 顺手抄一份；
 *   2) 需要批量时，按侧栏链接逐个点开，等站点自己去请求，我们只负责收。
 *
 * 这样即使接口改了名、加了字段，只要站点还在用 JSON 拉历史，它就还能工作。
 * 反过来，如果哪天它改成 SSR 直接吐 HTML，这个脚本会**明确告诉你没抓到**，而不是导出一份空文件。
 */

(function () {
  "use strict";

  const VERSION = "0.2.0";
  const STORE_KEY = "herta-export:v1";
  const COPY = "herta-import";

  /** sessionId → { id, title, startedAt, messages: [{role, text, at}] } */
  const sessions = new Map();
  let titleByHref = new Map();

  /* ------------------------------------------------------------- 存档 */

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      for (const s of data.sessions ?? []) sessions.set(s.id, s);
    } catch {
      /* 存档坏了就当没有，不要因此拦住脚本 */
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ version: VERSION, sessions: [...sessions.values()] }));
    } catch {
      /* 配额满了就算了，导出仍然可用 */
    }
  }

  /* --------------------------------------------------- 从任意 JSON 里认东西 */

  function isObj(v) {
    return v && typeof v === "object" && !Array.isArray(v);
  }

  function pickTime(o) {
    for (const k of ["inserted_at", "created_at", "createdAt", "startedAt", "time", "updated_at"]) {
      const v = o[k];
      if (typeof v === "string" && v) return v;
      if (typeof v === "number" && v > 1e9) return new Date(v > 1e12 ? v : v * 1000).toISOString();
    }
    return "";
  }

  /** 一段消息数组？DeepSeek 的形状是 { role, content }，但也有把内容拆成片段的情况。 */
  function asMessages(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const out = [];
    for (const m of arr) {
      if (!isObj(m)) return null;
      if (m.role !== "user" && m.role !== "assistant") return null;
      let text = "";
      if (typeof m.content === "string") text = m.content;
      else if (Array.isArray(m.content)) {
        text = m.content
          .map((c) => (typeof c === "string" ? c : isObj(c) && typeof c.text === "string" ? c.text : ""))
          .filter(Boolean)
          .join("\n");
      }
      if (text.trim()) out.push({ role: m.role, text, at: pickTime(m) });
    }
    return out.length ? out : null;
  }

  /**
   * 递归扫一遍 JSON，认出三种东西：会话列表、消息数组、单个会话。
   * 不依赖任何字段名以外的假设——认不出就安静走开。
   */
  function harvest(node, depth) {
    if (depth > 8 || node === null || typeof node !== "object") return;

    if (Array.isArray(node)) {
      // 1) 会话列表：一堆带 id + title 的兄弟
      const looksLikeList =
        node.length > 0 &&
        node.every((x) => isObj(x) && (x.id || x.session_id) && (typeof x.title === "string" || x.name)) &&
        !asMessages(node);
      if (looksLikeList) {
        for (const s of node) {
          const id = String(s.id ?? s.session_id);
          const title = String(s.title ?? s.name ?? "").trim();
          const cur = sessions.get(id) ?? { id, title: "", startedAt: "", messages: [] };
          if (title && !cur.title) cur.title = title;
          const t = pickTime(s);
          if (t && !cur.startedAt) cur.startedAt = t;
          sessions.set(id, cur);
        }
      }

      // 2) 消息数组本身没有 id，归并交给外面那层带 id 的对象处理。
      //    这里只往下走，避免把消息塞进"当前唯一那个会话"这种靠运气的做法。
      for (const child of node) harvest(child, depth + 1);
      return;
    }

    if (isObj(node)) {
      // 3) 单个会话：外面裹着 id 与 messages
      const id = node.chat_session_id ?? node.conversation_id ?? node.session_id ?? node.id;
      const msgs = asMessages(node.messages ?? node.chat_messages ?? node.history);
      if (id && msgs) mergeMessages(String(id), msgs);

      // 消息里可能还嵌着别的结构，继续挖
      for (const v of Object.values(node)) harvest(v, depth + 1);
    }
  }

  function mergeMessages(id, incoming) {
    const cur = sessions.get(id) ?? { id, title: "", startedAt: "", messages: [] };
    const byText = new Map();
    for (const m of cur.messages) byText.set(m.role + "\u0000" + m.text, m);
    for (const m of incoming) {
      const k = m.role + "\u0000" + m.text;
      if (!byText.has(k)) {
        byText.set(k, m);
        cur.messages.push(m);
      }
    }
    if (!cur.startedAt && cur.messages[0]?.at) cur.startedAt = cur.messages[0].at;
    sessions.set(id, cur);
    save();
    render();
  }

  /* --------------------------------------------------------------- 钩子 */

  function tryJson(text) {
    if (typeof text !== "string" || text.length < 2) return;
    const head = text.trimStart().slice(0, 1);
    if (head !== "{" && head !== "[") return;
    try {
      harvest(JSON.parse(text), 0);
    } catch {
      /* 不是 JSON，或者被截断了，跳过 */
    }
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = String(args[0]?.url ?? args[0] ?? "");
      if (/\/api\//.test(url)) {
        res
          .clone()
          .text()
          .then((t) => {
            tryJson(t);
            const m = url.match(/session[_/]?(?:id)?[=/]?([0-9a-f-]{8,})/i);
            if (m) window.__hertaLastSessionId = m[1];
          })
          .catch(() => {});
      }
    } catch {
      /* 钩子自己不许报错 */
    }
    return res;
  };

  const OrigXHR = window.XMLHttpRequest;
  function WrappedXHR() {
    const xhr = new OrigXHR();
    xhr.addEventListener("load", () => {
      try {
        const t = xhr.responseType === "" || xhr.responseType === "text" ? xhr.responseText : "";
        if (t) tryJson(t);
      } catch {
        /* 同上 */
      }
    });
    return xhr;
  }
  WrappedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = WrappedXHR;

  /* ------------------------------------------------------------- 自动翻页 */

  let crawling = false;
  let stopFlag = false;

  function sidebarLinks() {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/chat/s/"]')) {
      const href = a.getAttribute("href");
      const id = (href.split("/chat/s/")[1] ?? "").split(/[?#]/)[0];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      titleByHref.set(id, (a.textContent ?? "").trim());
      out.push({ id, a });
    }
    return out;
  }

  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function crawl() {
    if (crawling) return;
    const links = sidebarLinks();
    if (links.length === 0) {
      log("侧栏里没找到对话链接。先把左侧对话列表展开，或者手动点开几个，脚本会自动收集。");
      return;
    }
    crawling = true;
    stopFlag = false;
    log("开始翻 " + links.length + " 个对话…");
    for (const [i, link] of links.entries()) {
      if (stopFlag) break;
      const before = sessions.get(link.id)?.messages.length ?? 0;
      link.a.click();
      // 等站点自己把历史拉回来；拿到新消息就早点走
      for (let t = 0; t < 20; t += 1) {
        await sleep(250);
        const now = sessions.get(link.id)?.messages.length ?? 0;
        if (now > before && t > 2) break;
      }
      const s = sessions.get(link.id);
      if (s && !s.title && titleByHref.get(link.id)) s.title = titleByHref.get(link.id);
      save();
      render();
      if (i % 5 === 0) log("进度 " + (i + 1) + "/" + links.length);
      await sleep(600);
    }
    crawling = false;
    save();
    render();
    log(stopFlag ? "已停下。" : "翻完了。");
  }

  /* ------------------------------------------------------------------ UI */

  let panel;
  let statusEl;
  let logEl;

  function log(msg) {
    if (!logEl) return;
    const line = document.createElement("div");
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function render() {
    if (!statusEl) return;
    const total = [...sessions.values()].reduce((n, s) => n + s.messages.length, 0);
    const withMsg = [...sessions.values()].filter((s) => s.messages.length > 0).length;
    statusEl.textContent = "已收集 " + withMsg + " 个对话 · " + total + " 条消息";
  }

  function buildBundle() {
    const list = [...sessions.values()]
      .filter((s) => s.messages.length > 0)
      .map((s) => ({
        id: s.id,
        title: s.title || (titleByHref.get(s.id) ?? ""),
        startedAt: s.startedAt || s.messages[0]?.at || "",
        messages: s.messages.filter((m) => m.text.trim()),
      }));
    return {
      format: COPY,
      version: 1,
      source: "deepseek-web",
      exportedAt: new Date().toISOString(),
      collector: { name: "herta-export", version: VERSION },
      sessions: list,
    };
  }

  function download() {
    const bundle = buildBundle();
    if (bundle.sessions.length === 0) {
      log("还没有收集到任何消息，导不出东西。");
      return;
    }
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "herta-import-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    log("已导出 " + bundle.sessions.length + " 个对话。");
  }

  async function copyOut() {
    const bundle = buildBundle();
    if (bundle.sessions.length === 0) {
      log("还没有收集到任何消息。");
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(bundle));
      log("已复制到剪贴板（" + Math.round(JSON.stringify(bundle).length / 1024) + " KB）。");
    } catch (e) {
      log("复制失败：" + e.message);
    }
  }

  function mountUI() {
    if (panel && document.body.contains(panel)) {
      panel.style.display = "block";
      return;
    }
    panel = document.createElement("div");
    panel.id = "herta-export-panel";
    panel.innerHTML = `
      <style>
        #herta-export-panel {
          position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
          width: 268px; padding: 12px; border-radius: 12px;
          background: #12111a; color: #e9e6ee; border: 1px solid #2c2444;
          font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif;
          box-shadow: 0 8px 32px rgba(0,0,0,.45);
        }
        #herta-export-panel .hd { display: flex; align-items: center; gap: 8px; }
        #herta-export-panel h4 { margin: 0 0 6px; font-size: 13px; font-weight: 600; flex: 1; }
        #herta-export-panel .x {
          width: 22px; height: 22px; margin: 0 0 6px; padding: 0; border-radius: 6px;
          background: none; border: 1px solid #2c2444; color: #9a93a6; font-size: 14px; line-height: 1;
        }
        #herta-export-panel .st { color: #9a93a6; font-size: 12px; margin-bottom: 8px; }
        #herta-export-panel button {
          width: 100%; margin-top: 6px; padding: 7px; border-radius: 8px; cursor: pointer;
          background: #1b1730; color: #e9e6ee; border: 1px solid #2c2444; font: inherit;
        }
        #herta-export-panel button:hover { background: #241d3d; }
        #herta-export-panel .log {
          margin-top: 8px; max-height: 96px; overflow-y: auto;
          font-size: 11px; color: #9a93a6; white-space: pre-wrap;
        }
      </style>
      <div class="hd">
        <h4>Herta 对话导出器</h4>
        <button data-act="close" class="x" title="收起">×</button>
      </div>
      <div class="st"></div>
      <button data-act="crawl">自动翻一遍（慢）</button>
      <button data-act="stop">停止</button>
      <button data-act="download">导出 JSON 文件</button>
      <button data-act="copy">复制到剪贴板</button>
      <div class="log"></div>
    `;
    document.body.appendChild(panel);

    statusEl = panel.querySelector(".st");
    logEl = panel.querySelector(".log");

    panel.addEventListener("click", (e) => {
      const act = e.target?.dataset?.act;
      if (act === "close") panel.style.display = "none";
      else if (act === "crawl") void crawl();
      else if (act === "stop") {
        stopFlag = true;
        log("收到停止指令…");
      } else if (act === "download") download();
      else if (act === "copy") void copyOut();
    });

    render();
    log("被动收集中：正常翻几个对话就会自动记下。");
  }

  /* ------------------------------------------------------- 常驻入口与自愈 */

  let launcher = null;

  function mountLauncher() {
    if (launcher && document.body.contains(launcher)) return;
    launcher = document.createElement("button");
    launcher.id = "herta-export-launcher";
    launcher.textContent = "导";
    launcher.title = "Herta 对话导出器（Alt+H）";
    Object.assign(launcher.style, {
      position: "fixed",
      right: "18px",
      bottom: "96px",
      zIndex: "2147483647",
      width: "34px",
      height: "34px",
      borderRadius: "50%",
      border: "1px solid #2c2444",
      background: "#1b1730",
      color: "#e9e6ee",
      font: "13px/1 system-ui, sans-serif",
      cursor: "pointer",
      boxShadow: "0 4px 16px rgba(0,0,0,.4)",
    });
    launcher.addEventListener("click", () => {
      if (!panel || !document.body.contains(panel)) {
        mountUI();
        return;
      }
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    });
    document.body.appendChild(launcher);
  }

  /** 页面是单页应用，路由切换会把右下的东西挤走；这里盯着，掉了就补上。 */
  function keepAlive() {
    setInterval(() => {
      if (!document.body) return;
      if (!launcher || !document.body.contains(launcher)) mountLauncher();
    }, 3000);
  }

  function boot() {
    mountLauncher();
    mountUI();
    keepAlive();
    window.addEventListener("keydown", (e) => {
      if (e.altKey && (e.key === "h" || e.key === "H")) {
        if (!panel || !document.body.contains(panel)) mountUI();
        else panel.style.display = panel.style.display === "none" ? "block" : "none";
      }
    });
  }

  load();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
