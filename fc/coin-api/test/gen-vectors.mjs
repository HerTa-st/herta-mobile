/*
 * 黑塔币 v1 · 测试向量生成器（网页侧唯一事实来源）
 *
 * 做法（契约 §2.4）：
 *   1. 把 E:\deepseek工作区\phantom-market 整体拷到 fc/coin-api/test/.tmp/phantom-market；
 *   2. 给拷来的 app.js 的 __HTC_DEBUG__.getState() 补上 quote 标量与 bars 映射
 *      （网页页面本身只显示两位小数，向量要的是底层原始浮点）；
 *   3. 用拷来的 build.mjs 重新打包成单文件 HTML；
 *   4. 起无头 Edge（CDP），用 file:// + pathToFileURL 打开，逐个 setNow(iso) 取状态；
 *   5. 写 fc/coin-api/test/vectors.json。跑完一定杀掉 Edge 进程树。
 *
 * 用法：node fc/coin-api/test/gen-vectors.mjs
 *
 * 两条取数路径：
 *   A. 无头 Edge + CDP（首选，契约要求的方式）；
 *   B. 兜底：某些受限环境（如 DSH 的 Windows 沙箱）禁止创建命名管道，Edge 多进程
 *      起不来（platform_channel.cc FATAL 0x5）。此时退化为在 Node vm 里加载**同一份
 *      拷贝的 app.js**（连同 news.js），用最小 DOM 桩跑真实算法——算法、种子、日期
 *      口径与网页完全相同，只是不渲染 canvas。脚本会打印警告并在 vectors.json 的
 *      oracle 字段里记录用的是哪条路径；到普通环境重跑即可用真 Edge 复核。
 *
 * 注意：必须在 UTC+8 机器上跑（页面代码按本地时区解释 iso 的墙上时间），
 *       脚本会先断言时区是 +08:00，避免静默生成错向量。
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));          // fc/coin-api/test
const TMP_ROOT = join(HERE, '.tmp');
const TMP_PM = join(TMP_ROOT, 'phantom-market');
const EDGE_PROFILE = join(TMP_ROOT, 'edge-profile');
const VECTORS_PATH = join(HERE, 'vectors.json');

const SRC_PM = 'E:\\deepseek工作区\\phantom-market';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9200 + Math.floor(Math.random() * 300);
const PAGE_NAME = '黑塔币.html';
const EDGE_START_TIMEOUT_MS = 12000;

const TIMES = [
  '2026-10-29T10:15:30+08:00',
  '2026-10-29T13:45:00+08:00',
  '2026-10-29T12:00:00+08:00',
  '2026-10-29T09:00:00+08:00',
  '2026-10-29T16:00:00+08:00',
  '2026-10-31T12:00:00+08:00'
];

// 每个时刻的已知网页行为（visual-test.mjs 同款口径），保证向量生成没跑偏
const EXPECT = {
  '2026-10-29T10:15:30+08:00': { status: 'trading', sessionDate: '2026-10-29', sessionNumber: 214, revealed: 45, bars: 46, partial: 0.5, lastPartial: true },
  '2026-10-29T13:45:00+08:00': { status: 'trading', sessionDate: '2026-10-29', sessionNumber: 214, revealed: 165, bars: 166, partial: 0, lastPartial: true },
  '2026-10-29T12:00:00+08:00': { status: 'lunch', sessionDate: '2026-10-29', sessionNumber: 214, revealed: 120, bars: 120, partial: 0, lastPartial: false },
  '2026-10-29T09:00:00+08:00': { status: 'preopen', sessionDate: '2026-10-28', sessionNumber: 213, revealed: 240, bars: 240, partial: 0, lastPartial: false },
  '2026-10-29T16:00:00+08:00': { status: 'closed', sessionDate: '2026-10-29', sessionNumber: 214, revealed: 240, bars: 240, partial: 0, lastPartial: false },
  '2026-10-31T12:00:00+08:00': { status: 'weekend', sessionDate: '2026-10-30', sessionNumber: 215, revealed: 240, bars: 240, partial: 0, lastPartial: false }
};

let proc = null;
const cleanups = [];

function killEdge() {
  if (!proc) return;
  const pid = proc.pid;
  try { proc.kill(); } catch { /* ignore */ }
  if (pid) {
    // Windows 上 Edge 会派生一堆子进程，按进程树强杀，避免残留调试端口/配置目录锁
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  proc = null;
}

function fail(msg) {
  throw new Error(msg);
}

function edgeUnavailable(msg) {
  const err = new Error(msg);
  err.edgeUnavailable = true;
  return err;
}

function assertTimezone() {
  const off = new Date().getTimezoneOffset();
  if (off !== -480) {
    fail('本机时区不是 UTC+8（getTimezoneOffset=' + off + '），无法生成正确向量；请把系统时区设为 Asia/Shanghai 后重试');
  }
  console.log('      时区检查通过：UTC+08:00');
}

/* ---------- 1. 拷贝 phantom-market ---------- */
function copyPhantomMarket() {
  if (!existsSync(SRC_PM)) fail('源目录不存在：' + SRC_PM);
  mkdirSync(TMP_ROOT, { recursive: true });
  rmSync(TMP_PM, { recursive: true, force: true });
  rmSync(EDGE_PROFILE, { recursive: true, force: true });
  // 整体拷贝（只读源；publish/ 预览图等一并带过来也没关系，仅占 .tmp 空间）
  cpSync(SRC_PM, TMP_PM, { recursive: true });
  for (const name of ['index.html', 'style.css', 'news.js', 'app.js', 'build.mjs']) {
    if (!existsSync(join(TMP_PM, name))) fail('拷贝后缺少源文件：' + name);
  }
  console.log('[1/5] 已整体拷贝 phantom-market -> ' + TMP_PM);
}

/* ---------- 2. 给拷来的 app.js 补调试字段 ---------- */
function patchAppJs() {
  const file = join(TMP_PM, 'app.js');
  let src = readFileSync(file, 'utf8');
  if (src.length < 1000) fail('拷来的 app.js 内容异常');

  const patches = [
    // 向量要原始浮点，不要网页显示用的 toFixed
    ['          prevClose: state.plan ? +state.plan.prevClose.toFixed(2) : null,',
      '          prevClose: state.plan ? state.plan.prevClose : null,'],
    ['          pct: q ? +q.pct.toFixed(3) : null,',
      '          pct: q ? q.pct : null,'],
    ['          partial: +i.partial.toFixed(3),',
      '          partial: i.partial,'],
    // 在 getState 返回体末尾补：报价标量 + 全部 displayBars（短字段，t=下标）
    ['          key: ds(i.sessionDate)',
      [
        '          key: ds(i.sessionDate),',
        '          keyFingerprint: fingerprint(ds(i.sessionDate)),',
        '          open: state.plan ? state.plan.open : null,',
        '          high: q ? q.high : null,',
        '          low: q ? q.low : null,',
        '          close: q ? q.price : null,',
        '          volume: q ? q.volume : null,',
        '          turnover: q ? q.turnover : null,',
        '          bars: state.displayBars.map(function (b, idx) {',
        '            var item = { t: idx, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume };',
        '            if (b.partial) item.partial = true;',
        '            return item;',
        '          })'
      ].join('\n')]
  ];

  for (const [from, to] of patches) {
    const count = src.split(from).length - 1;
    if (count !== 1) fail('app.js 补丁锚点不唯一（出现 ' + count + ' 次）：' + from.slice(0, 60));
    src = src.replace(from, to);
  }

  const mustHave = ['keyFingerprint', 'bars: state.displayBars.map', 'turnover: q ? q.turnover : null'];
  for (const m of mustHave) if (!src.includes(m)) fail('app.js 补丁没生效：' + m);
  writeFileSync(file, src, 'utf8');
  console.log('[2/5] 已给拷贝的 app.js 补上 getState() 的 quote/bars 字段');
}

/* ---------- 3. 重新打包 ---------- */
function buildHtml() {
  // 注意：不能用默认 stdio:'pipe' 捕获子进程输出（Windows 沙箱下会 EPERM），
  // 只关心退出码，build.mjs 自己会把结果写盘。
  const r = spawnSync(process.execPath, ['build.mjs'], { cwd: TMP_PM, stdio: 'ignore' });
  if (r.error) fail('启动 build.mjs 失败：' + r.error.message);
  if (r.status !== 0) fail('build.mjs 打包失败（exit ' + r.status + '），产物目录 ' + TMP_PM);
  const html = join(TMP_PM, PAGE_NAME);
  if (!existsSync(html)) fail('打包产物不存在：' + html);
  console.log('[3/5] 已重新打包：' + html + '（' + (readFileSync(html).length / 1024).toFixed(1) + ' KB）');
  return pathToFileURL(html).href;
}

/* ============================================================
 * 路径 A：无头 Edge + CDP
 * ============================================================ */
async function connectCdp() {
  let wsUrl = null;
  const deadline = Date.now() + EDGE_START_TIMEOUT_MS;
  while (!wsUrl && Date.now() < deadline) {
    if (proc && proc.exitCode !== null) {
      throw edgeUnavailable('Edge 进程启动后立即退出（exit ' + proc.exitCode + '）');
    }
    try {
      const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
      const list = await res.json();
      const page = list.find(t => t.type === 'page');
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* 等 Edge 起来 */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw edgeUnavailable('连不上 Edge 调试端口 ' + CDP_PORT + '（Edge 可能起不来或端口被占）');

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(edgeUnavailable('WebSocket 连接超时')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(edgeUnavailable('WebSocket 连接失败')); }, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');
  cleanups.push(() => ws.close());
  return { send };
}

async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error('页面脚本异常：' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  }
  return r.result && r.result.value;
}

async function collectVectorsViaEdge(pageUrl) {
  if (!existsSync(EDGE)) throw edgeUnavailable('找不到 Edge：' + EDGE);
  proc = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    '--remote-allow-origins=*',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + EDGE_PROFILE,
    '--window-size=1520,980',
    'about:blank'
  ], { stdio: 'ignore' });
  proc.on('error', () => { /* 由 connectCdp 的 exitCode/超时兜底 */ });

  const { send } = await connectCdp();
  console.log('[4/5] 已启动无头 Edge（CDP 端口 ' + CDP_PORT + '）');

  const tz = await evaluate(send, 'new Date().getTimezoneOffset()');
  if (tz !== -480) throw edgeUnavailable('Edge 时区不是 UTC+8（getTimezoneOffset=' + tz + '）');
  console.log('      Edge 时区检查通过：UTC+08:00');

  await send('Page.navigate', { url: pageUrl });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(200);
    try {
      ready = await evaluate(send, 'typeof window.__HTC_DEBUG__ === "object" && typeof window.__HTC_DEBUG__.getState === "function"');
    } catch { /* 页面还没加载完 */ }
  }
  if (!ready) fail('页面里的 __HTC_DEBUG__ 没就绪，网页可能没跑起来');
  console.log('      页面已就绪：' + pageUrl);

  const readState = () => evaluate(send, 'window.__HTC_DEBUG__.getState()');
  const setNow = iso => evaluate(send, 'window.__HTC_DEBUG__.setNow(' + JSON.stringify(iso) + ')');
  return collectFromStates(setNow, readState, 250, 'headless Edge + CDP（真浏览器）');
}

/* ============================================================
 * 路径 B：Node vm 加载同一份拷贝的 app.js（受限环境兜底）
 * ============================================================ */
function createDomStub() {
  const ctxStub = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return () => ({ width: 20 });
      if (prop === 'canvas') return null;
      return () => undefined;
    },
    set(target, prop, value) { target[prop] = value; return true; }
  });

  const els = new Map();
  function makeEl(id) {
    return {
      id,
      textContent: '',
      innerHTML: '',
      className: '',
      hidden: true,
      style: {},
      width: 0,
      height: 0,
      offsetWidth: 0,
      offsetHeight: 0,
      addEventListener() {},
      removeEventListener() {},
      getContext() { return ctxStub; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 1520, bottom: 900, width: 1520, height: 900 }; },
      querySelectorAll() { return []; },
      contains() { return false; },
      toBlob() {},
      dispatchEvent() { return true; }
    };
  }

  const document = {
    readyState: 'complete',
    title: '',
    documentElement: makeEl('html'),
    body: { appendChild() {}, scrollWidth: 390 },
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {},
    querySelectorAll() { return []; }
  };
  return { document, ctxStub };
}

function collectVectorsViaNodeVm() {
  const { document } = createDomStub();
  const sandbox = {
    console,
    document,
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    // 不要真起定时器：否则进程退不出去，也会引入非确定性
    setInterval() { return 0; },
    clearInterval() {},
    setTimeout() { return 0; },
    clearTimeout() {},
    URL: { createObjectURL() { return 'blob:stub'; }, revokeObjectURL() {} }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);

  const newsSrc = readFileSync(join(TMP_PM, 'news.js'), 'utf8');
  const appSrc = readFileSync(join(TMP_PM, 'app.js'), 'utf8');
  vm.runInContext(newsSrc, context, { filename: 'phantom-market/news.js' });
  vm.runInContext(appSrc, context, { filename: 'phantom-market/app.js' });

  const dbg = sandbox.window.__HTC_DEBUG__;
  if (!dbg || typeof dbg.getState !== 'function') fail('Node vm 里的 __HTC_DEBUG__ 没就绪');
  console.log('[4/5] Edge 不可用，改用 Node vm 加载同一份 app.js（不渲染 canvas，算法完全一致）');

  const setNow = iso => dbg.setNow(iso);
  const readState = () => dbg.getState();
  return collectFromStates(setNow, readState, 0, 'Node vm 执行同一份拷贝的 app.js（算法/种子/UTC+8 与网页相同）');
}

/* ============================================================
 * 通用：逐时刻取状态 -> 校验 -> 向量
 * ============================================================ */
function collectFromStates(setNow, readState, settleMs, oracleName) {
  return (async function () {
    const vectors = [];
    for (const iso of TIMES) {
      await setNow(iso);
      if (settleMs) await sleep(settleMs);
      const s = await readState();
      if (!s || typeof s !== 'object') fail(iso + ' 取状态失败');

      // 同一时刻再取一次，防非确定性污染向量
      const s2 = await readState();
      const sig = x => JSON.stringify([x.status, x.sessionDate, x.revealed, x.partial, x.close, x.bars]);
      if (sig(s) !== sig(s2)) fail(iso + ' 同一时刻两次状态不一致，向量不可信');

      const exp = EXPECT[iso];
      const bars = s.bars || [];
      const last = bars[bars.length - 1];
      const lastPartial = !!(last && last.partial);
      const problems = [];
      if (s.status !== exp.status) problems.push('status=' + s.status + ' 期望 ' + exp.status);
      if (s.sessionDate !== exp.sessionDate) problems.push('sessionDate=' + s.sessionDate + ' 期望 ' + exp.sessionDate);
      if (s.sessionNumber !== exp.sessionNumber) problems.push('sessionNumber=' + s.sessionNumber + ' 期望 ' + exp.sessionNumber);
      if (s.revealed !== exp.revealed) problems.push('revealed=' + s.revealed + ' 期望 ' + exp.revealed);
      if (bars.length !== exp.bars) problems.push('bars=' + bars.length + ' 期望 ' + exp.bars);
      if (Math.abs(s.partial - exp.partial) > 1e-12) problems.push('partial=' + s.partial + ' 期望 ' + exp.partial);
      if (lastPartial !== exp.lastPartial) problems.push('lastPartial=' + lastPartial + ' 期望 ' + exp.lastPartial);
      for (let i = 0; i < bars.length; i++) {
        if (bars[i].t !== i) { problems.push('bars[' + i + '].t=' + bars[i].t); break; }
      }
      if (problems.length) fail(iso + ' 网页行为与预期不符：' + problems.join('；'));

      vectors.push({
        now: iso,
        serverTime: iso,
        status: s.status,
        statusLabel: s.label,
        sessionDate: s.sessionDate,
        sessionNumber: s.sessionNumber,
        prevClose: s.prevClose,
        open: s.open,
        high: s.high,
        low: s.low,
        close: s.close,
        changePct: s.pct,
        volume: s.volume,
        turnover: s.turnover,
        revealed: s.revealed,
        partial: s.partial,
        keyFingerprint: s.keyFingerprint,
        bars: bars
      });
      console.log('      ' + iso + '  status=' + s.status + '  sessionDate=' + s.sessionDate +
        '  revealed=' + s.revealed + '  bars=' + bars.length + '  close=' + s.close.toFixed(4) +
        '  partial=' + s.partial + '  fp=' + s.keyFingerprint);
    }
    return { vectors, oracleName };
  })();
}

/* ============================================================
 * 4/5 入口：优先真 Edge，受限环境兜底 Node vm
 * ============================================================ */
async function collectVectors(pageUrl) {
  try {
    return await collectVectorsViaEdge(pageUrl);
  } catch (err) {
    if (!err || !err.edgeUnavailable) throw err;
    console.warn('');
    console.warn('⚠ 无头 Edge 无法启动：' + err.message);
    console.warn('  （Windows 沙箱禁止命名管道，Edge 多进程会 FATAL platform_channel 0x5 拒绝访问）');
    console.warn('  退化为 Node vm 执行同一份拷贝的 app.js 取数；到普通环境重跑本脚本会用真 Edge。');
    console.warn('');
    killEdge();
    return collectVectorsViaNodeVm();
  } finally {
    killEdge();
    for (const fn of cleanups) { try { fn(); } catch { /* ignore */ } }
  }
}

/* ---------- 5. 落盘 ---------- */
function writeVectors(vectors, oracleName) {
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'phantom-market/app.js（拷贝到 fc/coin-api/test/.tmp/phantom-market 并补 getState 调试字段后重新打包）',
    oracle: oracleName,
    note: '网页侧原始浮点；now/serverTime 都是输入 ISO 字符串（+08:00）',
    vectors
  };
  writeFileSync(VECTORS_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log('[5/5] 已写向量：' + VECTORS_PATH + '（' + vectors.length + ' 个时刻）');
}

async function main() {
  const hardTimer = setTimeout(() => {
    console.error('生成向量超时（120s），强制清理');
    killEdge();
    process.exit(1);
  }, 120000);
  hardTimer.unref();

  assertTimezone();
  copyPhantomMarket();
  patchAppJs();
  const pageUrl = buildHtml();
  const { vectors, oracleName } = await collectVectors(pageUrl);
  writeVectors(vectors, oracleName);
  console.log('完成：Edge 已清理（如曾启动过）。oracle = ' + oracleName);
  process.exit(0);
}

process.on('exit', killEdge);
process.on('SIGINT', () => { killEdge(); process.exit(130); });

main().catch(err => {
  killEdge();
  console.error('生成向量失败：', err && (err.message || err));
  process.exit(1);
});
