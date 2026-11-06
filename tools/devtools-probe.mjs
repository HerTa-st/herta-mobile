#!/usr/bin/env node
/**
 * 雷电 14 上的 WebView 探针（Chrome DevTools Protocol）。
 *
 * 用途：真机验收。能量 DOM（触控目标尺寸、横向溢出、对比度）与截图，
 * 不用靠人眼点，也不用无头浏览器模拟。
 *
 * 用法（在 herta-mobile 下）：
 *   node tools/devtools-probe.mjs --file tools/probe/measure.js
 *   node tools/devtools-probe.mjs --file tools/probe/shot.js --out _shot.png
 *
 * 前提：App 已在前台、debug 包里 WebView 调试是开的。
 * 脚本自己找 adb 与 webview_devtools_remote socket，再 forward 到本地端口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : argv[i + 1];
};

const adb = arg('adb', process.env.ADB || 'D:\\leidian\\LDPlayer14\\adb.exe');
const serial = arg('serial', 'emulator-5554');
const port = Number(arg('port', '9333'));
const file = arg('file', '');
const out = arg('out', '');
const timeout = Number(arg('timeout', '30000'));

function sh(args) {
  return execFileSync(adb, ['-s', serial].concat(args), { encoding: 'utf8', timeout });
}

function findPid() {
  const unix = sh(['shell', 'cat', '/proc/net/unix']);
  const m = /webview_devtools_remote_(\d+)/.exec(unix);
  if (!m) throw new Error('没找到 webview_devtools_remote —— App 在前台吗？debug 包吗？');
  return m[1];
}

async function fetchTargets() {
  for (let i = 0; i < 20; i++) {
    const r = await fetch('http://127.0.0.1:' + port + '/json/list');
    if (r.ok) {
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && /capacitor|localhost|file:/.test(t.url)) || list.find((t) => t.type === 'page');
      if (page) return page;
    }
    await new Promise((r2) => setTimeout(r2, 300));
  }
  throw new Error('拿不到 /json/list —— forward 没成？');
}

function cdp(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(method + ' → ' + JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const pid = findPid();
sh(['forward', 'tcp:' + port, 'localabstract:webview_devtools_remote_' + pid]);
const page = await fetchTargets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
await cdp(ws, 1, 'Runtime.enable', {});

if (file) {
  const expr = fs.readFileSync(path.resolve(file), 'utf8');
  const r = await cdp(ws, 2, 'Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) throw new Error('页面里抛错：' + JSON.stringify(r.exceptionDetails));
  console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2));
}

if (out) {
  await cdp(ws, 3, 'Page.enable', {});
  const shot = await cdp(ws, 4, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve(out), Buffer.from(shot.data, 'base64'));
  console.log('screenshot: ' + out + ' ' + fs.statSync(path.resolve(out)).size + 'B');
}

ws.close();
