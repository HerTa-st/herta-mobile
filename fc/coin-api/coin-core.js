/*
 * 黑塔币 HTC · FC 行情核心（Node.js 同构实现）
 *
 * 唯一事实来源：phantom-market\app.js（2026-10-29 版，只读）
 * 本文件是那套确定性算法的逐行同构移植：日期密钥 -> 确定性日线 -> 当日计划
 * （新闻排点 + 开盘跳空 + 240 根分钟路径 + 桥接到收盘 + 成交量）-> 按当前时间
 * 揭示已走过的分钟 -> 报价。新闻池在 news-pool.js（同样是原样副本）。
 *
 * 与网页的唯一差别是时间口径：网页跑在浏览器本地时区，这里固定模拟 UTC+8
 * （Asia/Shanghai，无夏令时），所以所有日期/星期/分钟都先用「墙上时间」
 * （epoch + 8h）再做 UTC 换算，绝不使用 new Date(y, m, d) 这类本地时区语义。
 * 确定性随机种子只吃日期字符串 / 下标 / epoch 秒，不受时区影响。
 *
 * 对外接口：
 *   buildDailyResponse(nowMs, getSecret) -> 契约 §2.2 的 { version, serverTime, market }
 *   getSession(nowMs)                    -> 当前该画哪一场 / 已揭示多少根
 *   （其余导出仅供本地测试 / 排查用）
 *
 * 每日密钥（2026-11-07 切换，见 docs/价格密钥-设计-2026-11-07.md）：
 *   切换日之前，随机种子只吃日期；切换日起，种子吃「日期 + 当日密钥」，
 *   密钥由服务端随机生成、落盘在 state/coin.json 的 seeds 里，经 /api/seeds 下发。
 */
'use strict';

const { NEWS_POOL } = require('./news-pool');

/* ============================================================
 * 常量（与网页一致）
 * ============================================================ */
const COIN = {
  name: '黑塔币',
  code: 'HTC',
  pair: 'HTC/USDT',
  genesis: '2026-01-05',
  genesisClose: 88.88,
  dailyVol: 0.030
};
const EXCHANGES = ['模拟宇宙交易所', '星际所', '深空所', '奇物所', '空间站 OTC'];
const TOTAL_BARS = 240;
const AM_START = 570;   // 09:30
const AM_END = 690;     // 11:30
const PM_START = 780;   // 13:00
const PM_END = 900;     // 15:00

const API_VERSION = 1;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEK_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

/* ============================================================
 * 每日密钥（2026-11-07 切换）
 *
 *   date <  CUTOVER：种子只吃日期（历史价格一根都不许变）
 *   date >= CUTOVER：种子 = 日期 + 当日密钥（服务端随机生成、经 /api/seeds 下发）
 *
 * 服务端拿不到密钥就是开不了盘：不拿日期派生备用密钥（那样会和手机端算出两条线）。
 * ============================================================ */
const CUTOVER = '2026-11-07';

function daySeed(dateStr, secret) {
  return dateStr < CUTOVER ? 'HTC|daily|' + dateStr : 'HTC|daily|' + dateStr + '|' + secret;
}

function planSeed(dateStr, secret) {
  return dateStr < CUTOVER ? 'HTC|intraday|' + dateStr : 'HTC|intraday|' + dateStr + '|' + secret;
}

/**
 * 取某天的密钥：切换日之前不需要（返回 null，连 getSecret 都不调），之后必须有。
 * @param {string} dateStr YYYY-MM-DD
 * @param {(date: string) => string | null} [getSecret]
 */
function requireSecret(dateStr, getSecret) {
  if (dateStr < CUTOVER) return null;
  const secret = typeof getSecret === 'function' ? getSecret(dateStr) : null;
  if (typeof secret !== 'string' || secret.length === 0) {
    const err = new Error('缺少 ' + dateStr + ' 的价格密钥，今天开不了盘（先取 /api/seeds）');
    err.status = 503;
    err.code = 'missing_secret';
    throw err;
  }
  return secret;
}

/* ============================================================
 * 确定性随机数（逐行同构）
 * ============================================================ */
function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

function sfc32(a, b, c, d) {
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const w = cyrb128(seed);
  const gen = sfc32(w[0], w[1], w[2], w[3]);
  for (let i = 0; i < 12; i++) gen();
  let spare = null;
  return {
    next: gen,
    range(a, b) { return a + (b - a) * gen(); },
    int(a, b) { return Math.floor(a + (b - a + 1) * gen()); },
    chance(p) { return gen() < p; },
    pick(arr) { return arr[Math.floor(gen() * arr.length) % arr.length]; },
    norm() {
      if (spare !== null) { const v0 = spare; spare = null; return v0; }
      let u = 0, v = 0;
      while (u === 0) u = gen();
      while (v === 0) v = gen();
      const mag = Math.sqrt(-2 * Math.log(u));
      spare = mag * Math.sin(2 * Math.PI * v);
      return mag * Math.cos(2 * Math.PI * v);
    }
  };
}

function fingerprint(str) {
  const w = cyrb128(str);
  return w.map(function (n) { return n.toString(16).padStart(8, '0'); }).join('').toUpperCase().slice(0, 8);
}

/* ============================================================
 * 日期工具（固定 UTC+8）：所有「本地」语义都换成「墙上时间的 UTC」
 * ============================================================ */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// epoch 毫秒 -> 墙上时间 Date（其 UTC 字段 == 上海本地字段）
function wallFromMs(nowMs) { return new Date(nowMs + SHANGHAI_OFFSET_MS); }

// 上海本地零点（以 UTC 零点存放的墙上日期）
function wallDate(y, m, d) { return new Date(Date.UTC(y, m, d)); }

function wallYmd(d) { return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; }

function ds(d) {
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error('日期格式不对：' + s);
  return wallDate(+m[1], +m[2] - 1, +m[3]);
}

function isTradingDay(d) {
  const w = d.getUTCDay();
  return w >= 1 && w <= 5;
}

function prevTradingDay(d) {
  const x = wallDate(...wallYmd(d));
  do { x.setUTCDate(x.getUTCDate() - 1); } while (!isTradingDay(x));
  return x;
}

function nextTradingDay(d) {
  const x = wallDate(...wallYmd(d));
  do { x.setUTCDate(x.getUTCDate() + 1); } while (!isTradingDay(x));
  return x;
}

function tradingDatesBetween(start, end) {
  const out = [];
  const x = wallDate(...wallYmd(start));
  const e = wallDate(...wallYmd(end));
  while (x <= e) {
    if (isTradingDay(x)) out.push(new Date(x.getTime()));
    x.setUTCDate(x.getUTCDate() + 1);
  }
  return out;
}

// 上海本地 hh:mm -> 墙上时间
function openAt(date, hour, minute) {
  const [y, m, d] = wallYmd(date);
  return new Date(Date.UTC(y, m, d, hour, minute, 0, 0));
}

// 上海墙上日期今天（YYYY-MM-DD），seeds.js 与 /api/seeds 用同一口径
function shanghaiToday(nowMs) {
  const ms = typeof nowMs === 'number' ? nowMs : Number(nowMs);
  return ds(wallFromMs(Number.isFinite(ms) ? ms : Date.now()));
}

// 契约要求的 serverTime 形如 2026-10-29T10:15:30+08:00
function formatServerTime(nowMs) {
  const w = wallFromMs(nowMs);
  return w.getUTCFullYear() + '-' + pad2(w.getUTCMonth() + 1) + '-' + pad2(w.getUTCDate()) +
    'T' + pad2(w.getUTCHours()) + ':' + pad2(w.getUTCMinutes()) + ':' + pad2(w.getUTCSeconds()) + '+08:00';
}

/* ============================================================
 * 新闻库（NEWS_POOL 由 news-pool.js 原样提供）
 * ============================================================ */
let POOL = null;

function getPool() {
  if (POOL) return POOL;
  const bull = [], bear = [], flat = [];
  NEWS_POOL.forEach(function (raw) {
    if (typeof raw !== 'string' || raw.length < 3) return;
    const sign = raw.charAt(0);
    const strength = Math.min(3, Math.max(1, parseInt(raw.charAt(1), 10) || 1));
    const text = raw.slice(2);
    const item = { sign: sign, strength: strength, text: text };
    if (sign === '+') bull.push(item);
    else if (sign === '-') bear.push(item);
    else if (sign === '=') flat.push(item);
  });
  let bullOut = bull, bearOut = bear, flatOut = flat;
  if (!bullOut.length || !bearOut.length) {
    bullOut = [{ sign: '+', strength: 2, text: '{name}获得大额买入' }];
    bearOut = [{ sign: '-', strength: 2, text: '{name}遭到集中抛售' }];
  }
  if (!flatOut.length) flatOut = [{ sign: '=', strength: 1, text: '{name}发布例行公告' }];
  POOL = { bull: bullOut, bear: bearOut, flat: flatOut, total: bullOut.length + bearOut.length + flatOut.length };
  return POOL;
}

/* ============================================================
 * 日收盘价链（连续行情的基础）
 * ============================================================ */
const dayCache = new Map();

function seriesDates(endDate) {
  const dates = tradingDatesBetween(parseDate(COIN.genesis), endDate);
  return dates.length ? dates : [wallDate(...wallYmd(endDate))];
}

/**
 * 日线链：从 genesis 走到 endDate，每天都问一次 getSecret（切换日之后才真的要）。
 *
 * 缓存按「日期 + 这段链用到的密钥指纹」存：密钥是每天落盘一把、永不改，
 * 所以正常情况下同一个 endDate 永远命中同一条链；万一有别的密钥传进来
 * （只可能出现在测试里），也不会拿到别人的链。
 */
function dailySeries(endDate, getSecret) {
  const key = ds(endDate);
  const dates = seriesDates(endDate);

  const secrets = new Array(dates.length);
  const used = [];
  for (let i = 0; i < dates.length; i++) {
    const dstr = ds(dates[i]);
    const secret = requireSecret(dstr, getSecret);
    secrets[i] = secret;
    if (secret) used.push(dstr + ':' + secret);
  }

  const cacheKey = used.length ? key + '|' + fingerprint(used.join('|')) : key;
  if (dayCache.has(cacheKey)) return dayCache.get(cacheKey);

  let close = COIN.genesisClose;
  const list = [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const dstr = ds(d);
    if (dstr === COIN.genesis) {
      list.push({ date: d, close: close });
      continue;
    }
    const rng = makeRng(daySeed(dstr, secrets[i]));
    const dev = Math.log(close / COIN.genesisClose);
    const ret = rng.norm() * COIN.dailyVol + 0.0005 - 0.010 * dev;
    close = close * (1 + ret);
    if (close < COIN.genesisClose * 0.2) close = COIN.genesisClose * 0.2;
    if (close > COIN.genesisClose * 5) close = COIN.genesisClose * 5;
    list.push({ date: d, close: close });
  }

  dayCache.set(cacheKey, list);
  return list;
}

/* ============================================================
 * 当日计划：分钟 K + 新闻事件
 * ============================================================ */
const planCache = new Map();

function buildPlan(sessionDate, getSecret) {
  const key = ds(sessionDate);
  const secret = requireSecret(key, getSecret);
  const cacheKey = secret ? key + '|' + secret : key;
  if (planCache.has(cacheKey)) return planCache.get(cacheKey);

  const series = dailySeries(sessionDate, getSecret);
  const last = series.length - 1;
  const today = series[last];
  const prev = series[last - 1] || today;

  const rng = makeRng(planSeed(key, secret));
  const pool = getPool();

  /* --- 1. 排新闻：按分钟分布，方向和强度会在生成行情时给冲击 --- */
  const events = [];
  const usedText = {};
  let cursor = rng.int(2, 7);
  while (cursor < TOTAL_BARS - 1) {
    const dir = rng.chance(0.52) ? 1 : -1;
    const arr = dir > 0 ? pool.bull : pool.bear;
    let item = rng.pick(arr);
    let guard = 0;
    while (usedText[item.text] && guard++ < 10) item = rng.pick(arr);
    usedText[item.text] = true;
    events.push({ bar: cursor, dir: dir, strength: item.strength, tpl: item.text });
    cursor += rng.int(7, 15);
  }
  const neutralCount = 2 + rng.int(0, 1);
  for (let n = 0; n < neutralCount; n++) {
    const idx = rng.int(4, TOTAL_BARS - 2);
    const closeBy = events.some(function (e) { return Math.abs(e.bar - idx) < 3; });
    const flatItem = rng.pick(pool.flat);
    if (!closeBy) {
      events.push({ bar: idx, dir: 0, strength: flatItem.strength, tpl: flatItem.text });
    }
  }
  events.sort(function (a, b) { return a.bar - b.bar; });
  const eventAt = {};
  events.forEach(function (e) { eventAt[e.bar] = e; });

  /* --- 2. 当日开盘：承接昨日收盘 + 小幅跳空 --- */
  let gap = rng.norm() * 0.005;
  gap = Math.max(-0.018, Math.min(0.018, gap));
  const open = prev.close * (1 + gap);

  /* --- 3. 生成 240 根分钟收盘路径 --- */
  const sigma = 0.0016;
  let volState = 1;
  const drift = rng.norm() * 0.00008;
  let price = open;
  const rawCloses = [];
  const wickUp = [];
  const wickDown = [];
  const volumes = [];

  for (let i = 0; i < TOTAL_BARS; i++) {
    const ev = eventAt[i] || null;
    volState = volState * 0.94 + 0.06 * (0.8 + rng.next() * 0.6);
    let s = sigma * volState;
    let ret = drift + rng.norm() * s;
    if (ev) {
      ret += ev.dir * (0.0010 + ev.strength * 0.00045);
      s *= 1 + ev.strength * 0.25;
    }
    const next = price * (1 + ret);
    rawCloses.push(next);
    wickUp.push((0.18 + Math.abs(rng.norm()) * 0.5) * s);
    wickDown.push((0.18 + Math.abs(rng.norm()) * 0.5) * s);
    const baseVol = 1700;
    const vol = baseVol * (0.55 + Math.abs(ret) / (s + 1e-9) * 0.45) *
      Math.exp(rng.norm() * 0.25) * (ev ? 1 + ev.strength * 0.6 : 1);
    volumes.push(Math.max(60, Math.round(vol)));
    price = next;
  }

  /* --- 4. 桥接到当日目标收盘（保证日线连续） --- */
  const target = today.close;
  const correction = Math.log(target / rawCloses[TOTAL_BARS - 1]) / TOTAL_BARS;

  const bars = [];
  for (let j = 0; j < TOTAL_BARS; j++) {
    const factor = Math.exp(correction * (j + 1));
    const close = rawCloses[j] * factor;
    const barOpen = j === 0 ? open : bars[j - 1].close;
    const high = Math.max(barOpen, close) * (1 + wickUp[j]);
    const low = Math.min(barOpen, close) * (1 - wickDown[j]);
    bars.push({
      open: barOpen,
      high: high,
      low: low,
      close: close,
      volume: volumes[j]
    });
  }

  const dayVolume = bars.reduce(function (sum, b) { return sum + b.volume; }, 0);

  const plan = {
    date: sessionDate,
    key: key,
    prevClose: prev.close,
    open: open,
    targetClose: target,
    bars: bars,
    events: events,
    eventAt: eventAt,
    dayVolume: dayVolume,
    sessionNumber: series.length
  };
  planCache.set(cacheKey, plan);
  return plan;
}

/* ============================================================
 * 交易时段（固定 UTC+8）
 * ============================================================ */
function getSession(nowMs) {
  const now = wallFromMs(nowMs);
  const wd = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60 + now.getUTCMilliseconds() / 60000;
  const today = wallDate(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const res = {
    now: now,
    today: today,
    inSession: false,
    revealed: 0,
    partial: 0,
    target: null,
    countdownLabel: '距开盘'
  };

  if (wd === 0 || wd === 6) {
    res.sessionDate = prevTradingDay(today);
    res.status = 'weekend';
    res.label = '休市 · 周末';
    res.revealed = TOTAL_BARS;
    res.target = openAt(nextTradingDay(today), 9, 30);
    return res;
  }

  if (mins < AM_START) {
    res.sessionDate = prevTradingDay(today);
    res.status = 'preopen';
    res.label = '盘前 · 未开盘';
    res.revealed = TOTAL_BARS;
    res.target = openAt(today, 9, 30);
    return res;
  }

  res.sessionDate = today;

  if (mins < AM_END) {
    const e = mins - AM_START;
    res.status = 'trading';
    res.inSession = true;
    res.label = '交易中 · 上午';
    res.revealed = Math.min(TOTAL_BARS, Math.floor(e));
    res.partial = Math.min(1, e - Math.floor(e));
    res.target = openAt(today, 11, 30);
    res.countdownLabel = '距午休';
    return res;
  }

  if (mins < PM_START) {
    res.status = 'lunch';
    res.label = '午间休市';
    res.revealed = 120;
    res.target = openAt(today, 13, 0);
    res.countdownLabel = '距下午开盘';
    return res;
  }

  if (mins < PM_END) {
    const e2 = 120 + (mins - PM_START);
    res.status = 'trading';
    res.inSession = true;
    res.label = '交易中 · 下午';
    res.revealed = Math.min(TOTAL_BARS, Math.floor(e2));
    res.partial = Math.min(1, e2 - Math.floor(e2));
    if (res.revealed >= TOTAL_BARS) {
      res.revealed = TOTAL_BARS;
      res.partial = 0;
    }
    res.target = openAt(today, 15, 0);
    res.countdownLabel = '距收盘';
    return res;
  }

  res.status = 'closed';
  res.label = '已收盘';
  res.revealed = TOTAL_BARS;
  res.target = openAt(nextTradingDay(today), 9, 30);
  res.countdownLabel = '距下次开盘';
  return res;
}

/* ============================================================
 * 局部分钟 K（当前未走完的那根）
 * ============================================================ */
function partialBar(plan, index, frac, nowMs) {
  const bar = plan.bars[index];
  const sec = Math.floor(nowMs / 1000);
  const rng = makeRng('HTC|tick|' + plan.key + '|' + index + '|' + sec);
  const ease = frac * frac * (3 - 2 * frac);
  const jitter = (rng.next() - 0.5) * 0.0012 * Math.sin(Math.PI * frac);
  const base = bar.open;
  const price = base + (bar.close - base) * ease + base * jitter;
  const upMax = Math.max(bar.open, bar.close);
  const downMin = Math.min(bar.open, bar.close);
  const high = Math.max(base, price) + (bar.high - upMax) * frac;
  const low = Math.min(base, price) - (downMin - bar.low) * frac;
  return {
    open: base,
    high: high,
    low: low,
    close: price,
    volume: bar.volume * frac,
    partial: true
  };
}

function buildDisplay(plan, info, nowMs) {
  const out = [];
  for (let i = 0; i < Math.min(info.revealed, TOTAL_BARS); i++) out.push(plan.bars[i]);
  if (info.inSession && info.revealed < TOTAL_BARS) {
    out.push(partialBar(plan, info.revealed, info.partial, nowMs));
  }
  return out;
}

/* ============================================================
 * 报价（与网页 computeQuote 一致）
 * ============================================================ */
function computeQuote(plan, bars) {
  const lastBar = bars[bars.length - 1];
  const price = lastBar.close;
  let high = -Infinity, low = Infinity, volume = 0, turnover = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volume += b.volume;
    turnover += ((b.open + b.close) / 2) * b.volume;
  }
  const change = price - plan.prevClose;
  const pct = change / plan.prevClose * 100;
  const amplitude = (high - low) / plan.prevClose * 100;
  return {
    price: price,
    open: plan.open,
    high: high,
    low: low,
    prevClose: plan.prevClose,
    volume: volume,
    turnover: turnover,
    change: change,
    pct: pct,
    amplitude: amplitude
  };
}

/* ============================================================
 * 契约 §2.2 返回体
 * ============================================================ */
/**
 * @param {number} nowMs 毫秒时间戳
 * @param {(date: string) => string | null} [getSecret] 每日密钥查询；
 *        切换日（含）之后必须有，切换日之前不会被调用。
 */
function buildDailyResponse(nowMs, getSecret) {
  const ms = typeof nowMs === 'number' ? nowMs : Number(nowMs);
  if (!Number.isFinite(ms)) throw new TypeError('nowMs 必须是有效的毫秒时间戳，收到：' + nowMs);

  const info = getSession(ms);
  const plan = buildPlan(info.sessionDate, getSecret);
  const displayBars = buildDisplay(plan, info, ms);
  const quote = computeQuote(plan, displayBars);
  const key = ds(info.sessionDate);

  const bars = displayBars.map(function (b, i) {
    const item = { t: i, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume };
    if (b.partial) item.partial = true;
    return item;
  });

  return {
    version: API_VERSION,
    serverTime: formatServerTime(ms),
    market: {
      name: COIN.name,
      code: COIN.code,
      pair: COIN.pair,
      sessionDate: key,
      sessionNumber: plan.sessionNumber,
      status: info.status,
      statusLabel: info.label,
      prevClose: quote.prevClose,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      close: quote.price,
      changePct: quote.pct,
      volume: quote.volume,
      turnover: quote.turnover,
      revealed: info.revealed,
      partial: info.partial,
      keyFingerprint: fingerprint(key),
      bars: bars
    }
  };
}

module.exports = {
  buildDailyResponse,
  // 以下是排查 / 测试辅助，不属于契约
  buildPlan,
  getSession,
  dailySeries,
  computeQuote,
  partialBar,
  buildDisplay,
  fingerprint,
  ds,
  formatServerTime,
  makeRng,
  COIN,
  TOTAL_BARS,
  API_VERSION,
  SHANGHAI_OFFSET_MS,
  WEEK_NAMES,
  // 每日密钥（seeds.js 也吃这几个）
  CUTOVER,
  daySeed,
  planSeed,
  requireSecret,
  shanghaiToday,
  isTradingDay,
  parseDate
};
