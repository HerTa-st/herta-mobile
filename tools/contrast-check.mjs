#!/usr/bin/env node
/**
 * 正文对比度检查（WCAG 2.1，AA 正文 4.5:1）。
 *
 * 量的是 token 级：从 apps/phone/src/styles.css 读出 :root 与
 * :root[data-theme="dark"] 的 --ink / --ink-soft / --muted / --accent 等，
 * 和正文最常落的那几个底（app 底、卡片底、输入区底）算对比度。
 *
 * 为什么不是像素取样：像素取样要真机或整页渲染，且随滚动位置变化。
 * 这个脚本回答的是「设计 token 本身够不够」；像素级的「实际那一屏」仍要真机看。
 * 两者不冲突：token 不达标，像素一定不达标。
 *
 * 用法：node tools/contrast-check.mjs [--json]
 * 退出码：有任意一对 <4.5 时为 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const cssPath = path.join(repo, 'apps/phone/src/styles.css');
const css = fs.readFileSync(cssPath, 'utf8');

function block(selector) {
  const i = css.indexOf(selector);
  if (i === -1) throw new Error('找不到选择器 ' + selector);
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function tokens(selector) {
  const out = {};
  for (const m of block(selector).matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out['--' + m[1].trim()] = m[2].trim();
  }
  return out;
}

function parseColor(v) {
  const s = v.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  throw new Error('无法解析颜色 ' + v);
}

function over(fg, bg) {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function lum(c) {
  const f = (x) => {
    const s = x / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function ratio(a, b) {
  const la = lum(a);
  const lb = lum(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const light = tokens(':root');
const dark = Object.assign({}, light, tokens(':root[data-theme="dark"]'));

// 底：正文落的地方。app 底是 .app 的 rgba(248,251,253,0.84) 压在 body 渐变上；
// 取两个极端：最亮（压在白处）与最暗（青底透上来），后者才是真正要过的线。
const lightSurfaces = {
  'app 底 · 最亮': { r: 248, g: 251, b: 253, a: 1 },
  'app 底 · 青底透上来': { r: 212, g: 240, b: 251, a: 1 },
  '卡片底 (--card 压 app)': over(parseColor(light['--card']), { r: 248, g: 251, b: 253, a: 1 }),
};
const darkSurfaces = {
  '夜间 app 底': { r: 10, g: 26, b: 38, a: 1 },
  '夜间卡片底 (--card)': over(parseColor(dark['--card']), { r: 10, g: 26, b: 38, a: 1 }),
};

const roles = ['--ink', '--ink-soft', '--muted', '--accent', '--mine-ink'];

function run(name, tk, surfaces) {
  const rows = [];
  for (const [sname, s] of Object.entries(surfaces)) {
    for (const role of roles) {
      if (!tk[role]) continue;
      const fg = parseColor(tk[role]);
      const r = ratio(fg, s);
      rows.push({ theme: name, surface: sname, role, color: tk[role], ratio: Math.round(r * 100) / 100, pass: r >= 4.5 });
    }
  }
  return rows;
}

const rows = [...run('日间', light, lightSurfaces), ...run('夜间', dark, darkSurfaces)];
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('主题', 6) + pad('角色', 12) + pad('底', 26) + pad('颜色', 26) + pad('对比度', 10) + '结果');
  for (const r of rows) {
    console.log(pad(r.theme, 6) + pad(r.role, 12) + pad(r.surface, 26) + pad(r.color, 26) + pad(r.ratio, 10) + (r.pass ? 'PASS' : 'FAIL <4.5'));
  }
  const fail = rows.filter((r) => !r.pass);
  console.log('\n共 ' + rows.length + ' 对，失败 ' + fail.length + ' 对');
  if (fail.length) {
    console.log('最低：' + fail.reduce((a, b) => (a.ratio < b.ratio ? a : b)).role + ' ' + fail.reduce((a, b) => (a.ratio < b.ratio ? a : b)).ratio);
  }
  process.exitCode = fail.length ? 1 : 0;
}
