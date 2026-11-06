#!/usr/bin/env node
/**
 * 把 site/ 传到阿里云 OSS（最小权限：oss:PutObject；可选 PutBucketWebsite）。
 *
 * 用法：
 *   node tools/upload-site.mjs --dry-run
 *   node tools/upload-site.mjs --creds .oss-temp.json
 *   node tools/upload-site.mjs --creds .oss-temp.json --website --verify
 *
 * 凭据文件（不要提交）：
 *   { "accessKeyId": "...", "accessKeySecret": "...", "securityToken": "可选" }
 *
 * 不使用 ossutil，直接走 OSS Signature V1；上传前不会打印密钥。
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const siteDir = path.join(repo, 'site');

const argv = process.argv.slice(2);
function flag(name) { return argv.includes('--' + name); }
function arg(name, fallback) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error('--' + name + ' 缺少值');
  return v;
}

const bucket = arg('bucket', 'herta-st-gp');
const endpoint = arg('endpoint', 'oss-cn-hongkong.aliyuncs.com');
const dryRun = flag('dry-run');
const doWebsite = flag('website');
const doVerify = flag('verify');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};
const EXCLUDE = new Set(['README.md', '_genqr.py']);

function cacheControl(key) {
  if (key.endsWith('.html')) return 'no-cache';
  if (key.endsWith('.json')) return 'public, max-age=60';
  if (/\.(png|jpe?g|webp|svg|ico)$/i.test(key)) return 'public, max-age=86400';
  return 'public, max-age=3600';
}

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === '.DS_Store') continue;
    const abs = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, rel, out);
    else if (!EXCLUDE.has(name)) out.push({ abs, key: rel.replace(/\\/g, '/'), size: st.size });
  }
}

function loadCreds() {
  const p = arg('creds', '');
  let c = {};
  if (p) {
    const abs = path.resolve(process.cwd(), p);
    c = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } else {
    c = {
      accessKeyId: process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
      securityToken: process.env.OSS_SESSION_TOKEN
    };
  }
  const id = (c.accessKeyId || c.AccessKeyId || '').trim();
  const secret = (c.accessKeySecret || c.AccessKeySecret || '').trim();
  const token = (c.securityToken || c.SecurityToken || '').trim();
  if (!dryRun && (!id || !secret)) throw new Error('缺 AccessKeyId / AccessKeySecret；用 --creds 文件或环境变量');
  return { id, secret, token };
}

function sign(method, key, contentType, contentMd5, date, token) {
  const ossHeaders = {};
  if (token) ossHeaders['x-oss-security-token'] = token;
  const canonicalHeaders = Object.keys(ossHeaders).sort()
    .map(function (k) { return k + ':' + ossHeaders[k] + '\n'; }).join('');
  const resource = key === null ? '/' + bucket + '/?website' : '/' + bucket + '/' + key;
  const stringToSign = method + '\n' + (contentMd5 || '') + '\n' + (contentType || '') + '\n' + date + '\n' + canonicalHeaders + resource;
  return {
    authorization: 'OSS ' + creds.id + ':' + crypto.createHmac('sha1', creds.secret).update(stringToSign, 'utf8').digest('base64'),
    ossHeaders: ossHeaders,
    resource: resource
  };
}

let creds = { id: '', secret: '', token: '' };
function request(method, key, body, contentType, extraHeaders) {
  const date = new Date().toUTCString();
  const contentMd5 = body && body.length ? crypto.createHash('md5').update(body).digest('base64') : '';
  const s = sign(method, key, contentType, contentMd5, date, creds.token);
  const headers = Object.assign({
    'Date': date,
    'Content-Type': contentType || '',
    'Content-Length': body ? body.length : 0,
    'Authorization': s.authorization,
    'Cache-Control': key === null ? 'no-cache' : cacheControl(key)
  }, s.ossHeaders, extraHeaders || {});
  if (contentMd5) headers['Content-MD5'] = contentMd5;
  return new Promise(function (resolve, reject) {
    const req = https.request({
      hostname: bucket + '.' + endpoint,
      path: key === null ? '/?website' : '/' + encodeURI(key),
      method: method,
      headers: headers
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, function () { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function xmlWebsite() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<WebsiteConfiguration>\n' +
    '  <IndexDocument>\n' +
    '    <Suffix>index.html</Suffix>\n' +
    '    <SupportSubDir>true</SupportSubDir>\n' +
    '  </IndexDocument>\n' +
    '  <ErrorDocument>\n' +
    '    <Key>404.html</Key>\n' +
    '  </ErrorDocument>\n' +
    '</WebsiteConfiguration>\n';
}

async function verify() {
  const base = 'https://www.herta-st-gp.top/';
  const checks = [
    { p: '', want: 'HERTA' },
    { p: 'dsh/', want: 'dsh-herta' },
    { p: 'assets/config.js', want: 'HERTA_SITE' },
    { p: 'assets/og.png', want: '' },
    { p: 'assets/screens/app-chat.png', want: '' }
  ];
  for (const c of checks) {
    try {
      const r = await fetch(base + c.p, { cache: 'no-store', redirect: 'follow' });
      const text = c.want ? await r.text() : '';
      const ok = r.status === 200 && (!c.want || text.includes(c.want));
      console.log((ok ? 'VERIFY OK ' : 'VERIFY FAIL ') + '/' + c.p + ' status=' + r.status + ' type=' + (r.headers.get('content-type') || ''));
    } catch (e) {
      console.log('VERIFY FAIL /' + c.p + ' ' + String(e));
    }
  }
  try {
    const r = await fetch(base + '__b11_missing__', { cache: 'no-store', redirect: 'follow' });
    const text = await r.text();
    console.log(((r.status === 404 && text.includes('页面不在这里')) ? 'VERIFY OK ' : 'VERIFY FAIL ') + '404 status=' + r.status);
  } catch (e) {
    console.log('VERIFY FAIL 404 ' + String(e));
  }
}

async function main() {
  creds = loadCreds();
  const files = [];
  walk(siteDir, '', files);
  const total = files.reduce(function (n, f) { return n + f.size; }, 0);
  console.log('bucket=' + bucket + ' endpoint=' + endpoint + ' files=' + files.length + ' bytes=' + total + (dryRun ? ' (dry-run)' : ''));
  if (dryRun) {
    for (const f of files) console.log('  ' + f.key + '  ' + f.size + '  ' + (TYPES[path.extname(f.key).toLowerCase()] || 'application/octet-stream'));
    if (doWebsite) console.log(xmlWebsite());
    return;
  }

  let failed = 0;
  let done = 0;
  const queue = files.slice();
  async function worker() {
    while (queue.length) {
      const f = queue.shift();
      const type = TYPES[path.extname(f.key).toLowerCase()] || 'application/octet-stream';
      const body = fs.readFileSync(f.abs);
      let last = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await request('PUT', f.key, body, type);
          if (r.status >= 200 && r.status < 300) {
            done++;
            console.log('OK ' + f.key + ' ' + f.size + 'B');
            last = null;
            break;
          }
          last = 'HTTP ' + r.status + ' ' + r.body.slice(0, 240);
          if (r.status < 500) break;
        } catch (e) {
          last = String(e);
        }
        await new Promise(function (r) { setTimeout(r, 600 * (attempt + 1)); });
      }
      if (last) {
        failed++;
        console.error('FAIL ' + f.key + ' ' + last);
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  console.log('uploaded=' + done + ' failed=' + failed);

  if (doWebsite) {
    const xml = xmlWebsite();
    try {
      const r = await request('PUT', null, Buffer.from(xml, 'utf8'), 'application/xml');
      console.log(r.status >= 200 && r.status < 300 ? 'WEBSITE OK' : 'WEBSITE FAIL HTTP ' + r.status + ' ' + r.body.slice(0, 300));
    } catch (e) {
      console.log('WEBSITE FAIL ' + String(e));
    }
    await new Promise(function (r) { setTimeout(r, 1500); });
  }

  if (doVerify) await verify();
  if (failed) process.exitCode = 1;
}

main().catch(function (e) {
  console.error('ERROR ' + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
});
