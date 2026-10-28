/*
 * 黑塔币页 · 浏览器冒烟验收（无头 Edge + CDP）
 *
 * 覆盖设计文档验收：
 *   2  有网：进入黑塔币页 5 秒内出 K 线；停留 60 秒内发生轮询（这里等 31 秒就够验一次）
 *   3  断网：显示缓存 +「离线」标记；签到按钮禁用并提示需联网
 *   7  持仓口径：初始 1000 HTC；签到后数量增加
 *   11 UI：390×844 无横向溢出、截图留档
 *
 * 前置：mock 接口 + dev server 已起（由 tools/coin-smoke.ps1 串起来），默认：
 *   接口 http://127.0.0.1:8787（COIN_MOCK_NOW 钉在 2026-10-29T10:15:30+08:00）
 *   页面 http://127.0.0.1:5199
 *
 * 用法：node tools/coin-smoke.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT = join(REPO, "..", "_coin-smoke");
mkdirSync(OUT, { recursive: true });

const PAGE_URL = process.env.COIN_SMOKE_URL ?? "http://127.0.0.1:5199/";
const EDGE = process.env.COIN_SMOKE_EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9334;
// 每次跑用一个全新 profile：IndexedDB 里上一次的钱包/签到记录不能带进来
const PROFILE = join(OUT, "edge-profile-" + Date.now());
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, extra) {
  if (ok) {
    pass += 1;
    console.log("PASS " + name + (extra ? "  " + extra : ""));
  } else {
    fail += 1;
    failures.push(name);
    console.log("FAIL " + name + (extra ? "  " + extra : ""));
  }
}

const proc = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--force-device-scale-factor=1",
    "--remote-allow-origins=*",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + PROFILE,
    "--window-size=1200,900",
    "about:blank",
  ],
  { stdio: "ignore" }
);

async function main() {
  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i += 1) {
    try {
      const res = await fetch("http://127.0.0.1:" + PORT + "/json/list");
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch {
      /* 等 Edge 起来 */
    }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error("连不上 Edge 调试端口");

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")));
  });

  let seq = 0;
  const pending = new Map();
  const pageErrors = [];
  const dailyRequests = [];
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(String(msg.params?.exceptionDetails?.text ?? "unknown"));
    }
    if (msg.method === "Network.requestWillBeSent") {
      const url = msg.params?.request?.url ?? "";
      if (url.includes("/api/daily")) dailyRequests.push(url);
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("页面脚本异常：" + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  }

  async function waitFor(expression, timeoutMs, label) {
    const started = Date.now();
    for (;;) {
      try {
        if (await evaluate(expression)) return Date.now() - started;
      } catch {
        /* 页面还没就绪 */
      }
      if (Date.now() - started > timeoutMs) throw new Error("等了 " + timeoutMs + "ms 还没好：" + label);
      await sleep(100);
    }
  }

  async function capture(name) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, name), Buffer.from(shot.data, "base64"));
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  /* ---------- 打开 app → 抽屉 → 黑塔币（在线） ---------- */
  // 新 profile = 新装：先把首次引导标记立上，否则截出来的是引导页不是抽屉
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: "try { localStorage.setItem('herta.onboarded.v1','1') } catch (e) {}",
  });
  await send("Page.navigate", { url: PAGE_URL });
  await waitFor("!!document.querySelector('.bar .link.left')", 30000, "app 首屏");
  check("app 首屏渲染", true);

  const openedAt = Date.now();
  await evaluate("document.querySelector('.bar .link.left').click()");
  await waitFor("!!document.querySelector('.coinEntry')", 5000, "抽屉里的黑塔币入口");
  check(
    "抽屉入口写着「黑塔币 HTC」",
    (await evaluate("document.querySelector('.coinEntryName')?.textContent")) === "黑塔币 HTC"
  );

  await evaluate("document.querySelector('.coinEntry').click()");
  await waitFor("!!document.querySelector('.coinView')", 5000, "黑塔币页");
  await waitFor("(document.querySelector('.coinCanvas')?.width ?? 0) > 100", 5000, "K 线画布");
  const firstPaintMs = Date.now() - openedAt;
  check("进入黑塔币页 5 秒内出 K 线", firstPaintMs <= 5000, firstPaintMs + "ms");
  await waitFor(
    "!!document.querySelector('.coinPosGrid dd') && !!document.querySelector('.coinSignMsg')",
    6000,
    "钱包与签到卡"
  );

  const canvasPainted = await evaluate(`(function () {
    var c = document.querySelector('.coinCanvas');
    if (!c) return 0;
    var ctx = c.getContext('2d');
    var d = ctx.getImageData(0, 0, c.width, c.height).data;
    var n = 0;
    for (var i = 3; i < d.length; i += 40) if (d[i] !== 0) n++;
    return n;
  })()`);
  check("K 线不是空白画布", canvasPainted > 200, "非空采样 " + canvasPainted);

  const head = await evaluate(`(function () {
    return {
      price: document.querySelector('.coinLast')?.textContent ?? null,
      change: document.querySelector('.coinChange')?.textContent ?? null,
      badge: document.querySelector('.coinBadge')?.textContent ?? null,
      offline: !!document.querySelector('.coinOffline'),
      stats: Array.from(document.querySelectorAll('.coinStats dd')).map(function (d) { return d.textContent; }),
      holdings: Array.from(document.querySelectorAll('.coinPosGrid dd')).map(function (d) { return d.textContent; }),
      signMsg: document.querySelector('.coinSignMsg')?.textContent ?? null,
      signBtn: document.querySelector('.coinBtnPrimary')?.textContent ?? null,
      tradeBtn: document.querySelector('.coinBtnTrade')?.textContent ?? null,
      tradeDisabled: document.querySelector('.coinBtnTrade')?.disabled ?? null,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewWidth: document.documentElement.clientWidth,
      chartHeight: document.querySelector('.coinChartWrap')?.getBoundingClientRect().height ?? 0,
    };
  })()`);
  console.log("页面状态：" + JSON.stringify(head));
  check("现价 89.87 与网页同源", head.price === "89.87", String(head.price));
  check("状态徽标是「交易中 · 上午」", head.badge === "交易中 · 上午", String(head.badge));
  check("今开/最高/最低/成交量四项齐全", head.stats.length === 4, JSON.stringify(head.stats));
  check("初始持仓 1000 HTC", String(head.holdings[0] ?? "").startsWith("1000"), String(head.holdings[0]));
  check("市值 = 1000 × 现价", /^8\.9\d 万 USDT$|^89,\d{3} USDT$|^8\.9\d 万/.test(String(head.holdings[1])), String(head.holdings[1]));
  check("可签到按钮带奖励", /^签到 \+\d+ HTC$/.test(String(head.signBtn)), String(head.signBtn));
  check("交易入口是占位且不可点", head.tradeBtn === "交易功能开发中" && head.tradeDisabled === true, String(head.tradeBtn));
  check("390 宽无横向溢出", head.scrollWidth <= head.viewWidth + 1, head.scrollWidth + " / " + head.viewWidth);
  check("K 线图高度合理", head.chartHeight >= 160, String(head.chartHeight));
  // 开屏的 ASCII 动画还在淡出时截图会多一层"水印"，等它彻底退场
  await waitFor("!document.querySelector('.opening')", 12000, "开屏动画退场");
  await capture("coin-portrait.png");

  /* ---------- 抽屉入口的涨跌幅小字（缓存行情） ---------- */
  await evaluate("document.querySelector('.coinBack').click()");
  await sleep(300);
  await evaluate("document.querySelector('.bar .link.left').click()");
  await waitFor("!!document.querySelector('.coinEntry')", 5000, "抽屉再次打开");
  await waitFor("!!document.querySelector('.coinEntryPct')", 3000, "抽屉里的涨跌幅小字");
  const drawerPct = await evaluate("document.querySelector('.coinEntryPct')?.textContent");
  check("抽屉入口显示涨跌幅小字", /^[+-]?\d+\.\d{2}%$/.test(String(drawerPct)), String(drawerPct));
  await capture("coin-drawer.png");

  /* ---------- 断网：缓存 + 离线标记 + 签到禁用（还没签到，正好验按钮） ---------- */
  await send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await evaluate("document.querySelector('.coinEntry').click()");
  await waitFor("!!document.querySelector('.coinOffline')", 8000, "离线标记");
  const offlineState = await evaluate(`(function () {
    return {
      offline: document.querySelector('.coinOffline')?.textContent ?? null,
      bar: document.querySelector('.coinOfflineBar span')?.textContent ?? null,
      offlineNote: document.querySelector('.coinSignOffline')?.textContent ?? null,
      signBtnDisabled:
        document.querySelector('.coinBtnPrimary') ? document.querySelector('.coinBtnPrimary').disabled : null,
      hasPrice: !!document.querySelector('.coinLast'),
      price: document.querySelector('.coinLast')?.textContent ?? null,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewWidth: document.documentElement.clientWidth,
    };
  })()`);
  console.log("离线态：" + JSON.stringify(offlineState));
  check("离线标记出现", offlineState.offline === "离线", String(offlineState.offline));
  check("有缓存仍显示行情", offlineState.hasPrice && offlineState.price === "89.87", String(offlineState.price));
  check("离线时签到按钮禁用", offlineState.signBtnDisabled === true, String(offlineState.signBtnDisabled));
  check("离线时提示「签到需要联网」", offlineState.offlineNote === "签到需要联网", String(offlineState.offlineNote));
  check("离线态没有横向溢出", offlineState.scrollWidth <= offlineState.viewWidth + 1,
    offlineState.scrollWidth + " / " + offlineState.viewWidth);
  await capture("coin-offline.png");

  /* ---------- 恢复网络 → 点重试 → 回到在线 ---------- */
  await send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await evaluate("document.querySelector('.coinOfflineBar button')?.click()");
  await waitFor("!document.querySelector('.coinOffline')", 8000, "恢复在线");
  check("恢复网络后回到在线", true);

  /* ---------- 签到 ---------- */
  await waitFor("!!document.querySelector('.coinBtnPrimary')", 5000, "可签到按钮");
  await evaluate("document.querySelector('.coinBtnPrimary').click()");
  await waitFor("!!document.querySelector('.coinSignNote')", 5000, "签到结果");
  const signed = await evaluate(`(function () {
    return {
      note: document.querySelector('.coinSignNote')?.textContent ?? null,
      msg: document.querySelector('.coinSignMsg')?.textContent ?? null,
      holdings: Array.from(document.querySelectorAll('.coinPosGrid dd')).map(function (d) { return d.textContent; }),
      next: document.querySelector('.coinSignNext')?.textContent ?? null,
    };
  })()`);
  console.log("签到后：" + JSON.stringify(signed));
  check("签到成功提示 +10 HTC", String(signed.note).includes("+10 HTC"), String(signed.note));
  check("签到后持仓 1010 HTC", String(signed.holdings[0] ?? "").startsWith("1010"), String(signed.holdings[0]));
  check("签到卡变成已签态", String(signed.msg).includes("今日已签到"), String(signed.msg));
  check("已签态显示明天奖励", String(signed.next).includes("明天签到 +20 HTC"), String(signed.next));
  await capture("coin-signed.png");

  /* ---------- 轮询：等 31 秒，至少再拉一次 ---------- */
  const before = dailyRequests.length;
  await sleep(31_000);
  const after = dailyRequests.length;
  check("30s 轮询生效", after - before >= 1, "新增 " + (after - before) + " 次 /api/daily");

  /* ---------- 十字光标：按在图上出单根 OHLC ---------- */
  const hovered = await evaluate(`(function () {
    var c = document.querySelector('.coinCanvas');
    if (!c) return false;
    var r = c.getBoundingClientRect();
    var x = r.left + 42 + (20 + 0.5) * ((r.width - 52) / 240);
    var y = r.top + r.height * 0.4;
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
    return true;
  })()`);
  await sleep(200);
  const hoverText = await evaluate("document.querySelector('.coinOhlc')?.textContent ?? null");
  check("按住 K 线出单根 OHLC 浮层", hovered && typeof hoverText === "string" && hoverText.includes("开"),
    String(hoverText).slice(0, 60));
  await capture("coin-hover.png");
  await evaluate("document.querySelector('.coinCanvas').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))");

  /* ---------- 横屏：844×390 不破版 ---------- */
  await send("Emulation.setDeviceMetricsOverride", {
    width: 844,
    height: 390,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(600);
  const landscape = await evaluate(`(function () {
    return {
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewWidth: document.documentElement.clientWidth,
      chartHeight: document.querySelector('.coinChartWrap')?.getBoundingClientRect().height ?? 0,
      hasPrice: !!document.querySelector('.coinLast'),
    };
  })()`);
  check("横屏 844 宽无横向溢出", landscape.scrollWidth <= landscape.viewWidth + 1,
    landscape.scrollWidth + " / " + landscape.viewWidth);
  check("横屏图表按矮屏压到 180", landscape.chartHeight <= 185, String(landscape.chartHeight));
  await capture("coin-landscape.png");

  check("页面没有未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

  ws.close();
  proc.kill();
  console.log("\n结果：" + pass + " 通过，" + fail + " 失败；截图在 " + OUT);
  if (failures.length) console.log("失败项：" + failures.join("、"));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("冒烟测试失败：", err && (err.message || err));
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
