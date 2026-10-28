/*
 * 黑塔币 v1 · FC 行情同源测试
 *
 * 用 test/vectors.json（网页侧 app.js 生成）逐项比对 fc/coin-api/coin-core.js 的
 * buildDailyResponse(now)。判定口径（契约 §2.4）：
 *   - 字符串 / int / 布尔：严格相等；
 *   - 浮点：|a-b| <= 1e-9 * max(1,|b|)；
 *   - bars 数量与每一根都要比（t/o/h/l/c/v/partial）。
 *
 * 用法：node fc/coin-api/test/fc.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildDailyResponse } = require('../coin-core.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(readFileSync(join(HERE, 'vectors.json'), 'utf8'));
const VECTORS = Array.isArray(RAW) ? RAW : RAW.vectors;
if (!Array.isArray(VECTORS) || VECTORS.length === 0) {
  console.error('vectors.json 里没有向量；先跑 node fc/coin-api/test/gen-vectors.mjs');
  process.exit(1);
}

const TOL = 1e-9;
let pass = 0;
let fail = 0;
const failures = [];

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

function floatClose(actual, expected) {
  if (!isNum(actual) || !isNum(expected)) return false;
  return Math.abs(actual - expected) <= TOL * Math.max(1, Math.abs(expected));
}

/* 一个时刻的断言收集器 */
function makeChecker(label) {
  const errors = [];
  let count = 0;
  return {
    errors,
    count() { return count; },
    eq(field, actual, expected) {
      count++;
      const ok = actual === expected;
      if (!ok) errors.push(field + '：FC=' + fmt(actual) + ' 期望=' + fmt(expected));
      return ok;
    },
    close(field, actual, expected) {
      count++;
      const ok = floatClose(actual, expected);
      if (!ok) errors.push(field + '：FC=' + fmt(actual) + ' 期望=' + fmt(expected) + '（差 ' + diff(actual, expected) + '）');
      return ok;
    },
    present(field, obj, key) {
      count++;
      const ok = obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
      if (!ok) errors.push(field + '：字段缺失');
      return ok;
    }
  };
  function fmt(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toPrecision(17);
    return JSON.stringify(v);
  }
  function diff(a, b) {
    return (isNum(a) && isNum(b)) ? Math.abs(a - b).toExponential(3) : 'n/a';
  }
}

const REQUIRED_MARKET_FIELDS = [
  'name', 'code', 'pair', 'sessionDate', 'sessionNumber', 'status', 'statusLabel',
  'prevClose', 'open', 'high', 'low', 'close', 'changePct', 'volume', 'turnover',
  'revealed', 'partial', 'keyFingerprint', 'bars'
];

function testOne(vector) {
  const label = vector.now;
  const c = makeChecker(label);
  const nowMs = Date.parse(vector.now);
  let res;
  try {
    res = buildDailyResponse(nowMs);
  } catch (err) {
    fail++;
    failures.push(label + '：buildDailyResponse 抛异常 ' + (err && err.message));
    console.log('FAIL ' + label + '  buildDailyResponse 抛异常：' + (err && err.message));
    return { label, count: 0, errors: ['抛异常'] };
  }

  const m = res && res.market;
  if (!m) {
    fail++;
    failures.push(label + '：返回体没有 market');
    console.log('FAIL ' + label + '  返回体没有 market');
    return { label, count: 0, errors: ['没有 market'] };
  }

  /* ---- 顶层 ---- */
  c.eq('version', res.version, 1);
  c.present('serverTime', res, 'serverTime');
  c.eq('serverTime', res.serverTime, vector.serverTime);

  /* ---- market 字段完整性 ---- */
  for (const key of REQUIRED_MARKET_FIELDS) c.present('market.' + key, m, key);

  /* ---- 标量 ---- */
  c.eq('market.name', m.name, '黑塔币');
  c.eq('market.code', m.code, 'HTC');
  c.eq('market.pair', m.pair, 'HTC/USDT');
  c.eq('market.sessionDate', m.sessionDate, vector.sessionDate);
  c.eq('market.sessionNumber', m.sessionNumber, vector.sessionNumber);
  c.eq('market.status', m.status, vector.status);
  c.eq('market.statusLabel', m.statusLabel, vector.statusLabel);
  c.eq('market.keyFingerprint', m.keyFingerprint, vector.keyFingerprint);
  c.eq('market.revealed', m.revealed, vector.revealed);
  c.close('market.partial', m.partial, vector.partial);
  c.close('market.prevClose', m.prevClose, vector.prevClose);
  c.close('market.open', m.open, vector.open);
  c.close('market.high', m.high, vector.high);
  c.close('market.low', m.low, vector.low);
  c.close('market.close', m.close, vector.close);
  c.close('market.changePct', m.changePct, vector.changePct);
  c.close('market.volume', m.volume, vector.volume);
  c.close('market.turnover', m.turnover, vector.turnover);

  /* ---- 时间戳格式 ---- */
  c.eq('serverTime 格式', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(res.serverTime), true);

  /* ---- bars ---- */
  const bars = Array.isArray(m.bars) ? m.bars : null;
  c.eq('market.bars 是数组', Array.isArray(bars), true);
  c.eq('bars.length', bars ? bars.length : -1, vector.bars.length);
  if (bars) {
    const n = Math.min(bars.length, vector.bars.length);
    for (let i = 0; i < n; i++) {
      const a = bars[i];
      const b = vector.bars[i];
      c.eq('bars[' + i + '].t', a.t, b.t);
      c.close('bars[' + i + '].o', a.o, b.o);
      c.close('bars[' + i + '].h', a.h, b.h);
      c.close('bars[' + i + '].l', a.l, b.l);
      c.close('bars[' + i + '].c', a.c, b.c);
      c.close('bars[' + i + '].v', a.v, b.v);
      c.eq('bars[' + i + '].partial', !!a.partial, !!b.partial);
      if (c.errors.length > 40) break; // 别刷屏
    }
  }

  if (c.errors.length === 0) {
    pass++;
    console.log('PASS ' + label + '  status=' + m.status + '  sessionDate=' + m.sessionDate +
      '  revealed=' + m.revealed + '  bars=' + (bars ? bars.length : '?') +
      '  close=' + Number(m.close).toFixed(4) + '  partial=' + m.partial +
      '  fp=' + m.keyFingerprint + '  （' + c.count() + ' 项断言）');
    return { label, count: c.count(), errors: [] };
  }
  fail++;
  failures.push(label + '：' + c.errors.slice(0, 8).join('；'));
  console.log('FAIL ' + label + '  ' + c.errors.length + ' 项不符');
  for (const e of c.errors.slice(0, 8)) console.log('     - ' + e);
  return { label, count: c.count(), errors: c.errors };
}

/* ---------------- 主流程 ---------------- */
console.log('黑塔币 v1 · FC 同源测试（coin-core vs 网页向量）');
console.log('向量来源：' + (RAW.oracle || '(未记录)'));
console.log('向量生成：' + (RAW.generatedAt || '(未记录)'));
console.log('');

let totalChecks = 0;
for (const vector of VECTORS) {
  const r = testOne(vector);
  totalChecks += r.count;
}

console.log('');
console.log('结果：' + pass + '/' + VECTORS.length + ' 个时刻通过，' + fail + ' 失败；共 ' + totalChecks + ' 项断言');
if (fail === 0) {
  console.log('全部通过 ✅  网页侧算法与 FC 实现逐项一致（含 6 个时刻的全部 bars）');
} else {
  console.log('失败项：');
  for (const f of failures) console.log('  * ' + f);
}
process.exit(fail === 0 ? 0 : 1);
