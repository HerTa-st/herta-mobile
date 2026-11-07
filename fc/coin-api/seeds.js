/*
 * 黑塔币 v2 · 每日价格密钥（seeds）
 *
 * 口径：docs/价格密钥-设计-2026-11-07.md
 *   - 切换日 CUTOVER = 2026-11-07 起，每天一把 16 字节随机数的 hex（32 位小写）；
 *   - 存在 state/coin.json 顶层 seeds: { "YYYY-MM-DD": "<32 hex>" }，缺就生成、加锁落盘，
 *     同一日期只生成一次（随机生成一次之后永不改，价格历史才稳得住）；
 *   - 旧状态没有 seeds 字段按空对象处理，不因为升级清库；
 *   - GET /api/seeds?from=YYYY-MM-DD 返回 [max(from, CUTOVER), 今天] 里每个交易日的密钥。
 *
 * 进程内还有一层只读备忘（memo）：密钥一旦落盘就不再变，同一个 FC 实例的后续请求
 * 直接吃内存，不用为了算行情每次去 GET 一次 OSS。万一有人把状态回滚丢了 seeds，
 * 只要备忘里还有，写回账本时会顺手补上（见 applySeeds）。
 */
'use strict';

const crypto = require('crypto');
const { CUTOVER, ds, isTradingDay, parseDate, shanghaiToday } = require('./coin-core');

/** /api/seeds 的响应版本（客户端只认 >= 1 的整数）。 */
const SEED_VERSION = 1;
const SEED_BYTES = 16;
const SEED_RE = /^[0-9a-f]{32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 进程内备忘：date -> seed（只放切换日起、格式合法的）。 */
const memo = new Map();

function isDateStr(s) {
  return typeof s === 'string' && DATE_RE.test(s);
}

function isSeedStr(s) {
  return typeof s === 'string' && SEED_RE.test(s);
}

/** 新密钥：16 字节随机数 -> 32 位小写 hex。 */
function newSeed() {
  return crypto.randomBytes(SEED_BYTES).toString('hex');
}

/** 状态里现成的 seeds；旧状态没有就按空对象。 */
function stateSeeds(state) {
  const seeds = state && state.seeds;
  if (!seeds || typeof seeds !== 'object' || Array.isArray(seeds)) return {};
  return seeds;
}

/** from 归一：缺省按 CUTOVER；早于 CUTOVER 按 CUTOVER；格式不对报 400。 */
function normalizeFrom(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return CUTOVER;
  if (!isDateStr(s)) {
    const err = new Error('from 必须是 YYYY-MM-DD，收到：' + String(raw));
    err.status = 400;
    err.code = 'invalid_from';
    throw err;
  }
  return s < CUTOVER ? CUTOVER : s;
}

/** [start, end] 里的交易日（只有周末休市，没有法定节假日——和行情算法同一口径）。 */
function tradingDatesBetween(startStr, endStr) {
  const out = [];
  if (!isDateStr(startStr) || !isDateStr(endStr) || endStr < startStr) return out;
  const end = parseDate(endStr);
  for (let d = parseDate(startStr); d <= end; d = new Date(d.getTime() + DAY_MS)) {
    if (isTradingDay(d)) out.push(ds(d));
  }
  return out;
}

function payload(seeds) {
  return { version: SEED_VERSION, cutover: CUTOVER, seeds: seeds };
}

/** 从备忘/状态里拿这几个日期已有的密钥；返回 { want, missing }。 */
function pick(dates) {
  const want = {};
  const missing = [];
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const hit = memo.get(date);
    if (hit) want[date] = hit;
    else missing.push(date);
  }
  return { want: want, missing: missing };
}

/**
 * 读（必要时生成并落盘）[from, 今天] 的密钥。
 *
 * @param {{ read: Function, write: Function, withLock: Function }} store  OssStateStore 或同形内存版
 * @param {object} options
 *   options.nowMs            测试用时钟（默认 Date.now()）
 *   options.from             起始日期，默认 CUTOVER；早于 CUTOVER 按 CUTOVER
 *   options.sessionDate      需要在空状态上建账本时用的场次日期（默认今天）
 *   options.state            调用方已经读到的账本；给了就不再重复读一次 OSS
 *   options.createEmptyState (sessionDate) => 新账本；给了就按账本建，没给就只写 seeds
 * @returns {Promise<{version:number, cutover:string, seeds:Record<string,string>}>}
 */
async function ensureSeeds(store, options) {
  const opts = options || {};
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const today = shanghaiToday(nowMs);
  const from = normalizeFrom(opts.from);
  const dates = tradingDatesBetween(from, today);

  const first = pick(dates);
  if (!first.missing.length) return payload(first.want);

  /*
   * 冷实例快路径（只读，不抢锁）：
   * 新实例的 memo 是空的，若直接走下面「抢锁 + 读 + 写 + 释放」那条路，
   * 每个请求都要 5~6 次串行 OSS 往返。而密钥一旦落盘就不再变，
   * 所以先用一次 GET 探测盘上有没有——有就填进 memo 直接返回。
   * 只有真的缺密钥（每天第一次 / 跨天）才会进锁。
   */
  const probed = opts.state !== undefined ? opts.state : await store.read();
  if (probed) {
    const diskSeeds = stateSeeds(probed);
    let allHit = true;
    for (let i = 0; i < first.missing.length; i++) {
      const date = first.missing[i];
      if (isSeedStr(diskSeeds[date])) memo.set(date, diskSeeds[date]);
      else allHit = false;
    }
    if (allHit) {
      const again = pick(dates);
      if (!again.missing.length) return payload(again.want);
    }
  }

  // 缺的当场生成：锁外先摇好候选值，锁里再以「别人已经写进去的」为准
  const candidates = {};
  for (let i = 0; i < first.missing.length; i++) candidates[first.missing[i]] = newSeed();

  const sessionDate = isDateStr(opts.sessionDate) ? opts.sessionDate : today;
  const persisted = await store.withLock(async function () {
    let state = await store.read();
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      state = typeof opts.createEmptyState === 'function' ? opts.createEmptyState(sessionDate) : null;
      if (!state || typeof state !== 'object' || Array.isArray(state)) state = { version: 2 };
    }
    const seeds = stateSeeds(state);
    for (let i = 0; i < first.missing.length; i++) {
      const date = first.missing[i];
      // 同一日期只生成一次：别人先写好了就用别人的
      if (!isSeedStr(seeds[date])) seeds[date] = candidates[date];
    }
    state.seeds = seeds;
    await store.write(state);
    return seeds;
  });

  // 落盘的值是唯一事实：覆盖备忘（理论上两者一致，不一致时以盘上为准）
  for (const date of Object.keys(persisted)) {
    const seed = persisted[date];
    if (isDateStr(date) && date >= CUTOVER && isSeedStr(seed)) memo.set(date, seed);
  }

  const out = {};
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const seed = persisted[date];
    if (isSeedStr(seed)) out[date] = seed;
    else if (isSeedStr(first.want[date])) out[date] = first.want[date];
  }
  return payload(out);
}

/**
 * 把已知密钥补回账本对象（写盘前调；不动任何账务字段）。
 * 防止「老代码 / 读得早的实例」把 seeds 覆盖掉——覆盖掉就要重摇一把，价格会换条线。
 */
function applySeeds(state, extra) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const seeds = stateSeeds(state);
  let changed = false;
  if (extra && typeof extra === 'object') {
    for (const date of Object.keys(extra)) {
      const seed = extra[date];
      if (!isDateStr(date) || date < CUTOVER || !isSeedStr(seed)) continue;
      if (seeds[date] !== seed) { seeds[date] = seed; changed = true; }
    }
  }
  memo.forEach(function (seed, date) {
    if (seeds[date] !== seed) { seeds[date] = seed; changed = true; }
  });
  if (changed || state.seeds !== seeds) state.seeds = seeds; // 老状态没 seeds 时才新增这个字段
  return state;
}

/** 由 seeds 表造 getSecret 闭包（coin-core 逐日问）。 */
function secretLookup(seeds) {
  const map = seeds && typeof seeds === 'object' ? seeds : {};
  return function getSecret(dateStr) {
    const seed = map[dateStr];
    return isSeedStr(seed) ? seed : null;
  };
}

/** 测试用：清掉进程内备忘（生产代码不要调）。 */
function _resetMemoForTest() {
  memo.clear();
}

module.exports = {
  SEED_VERSION: SEED_VERSION,
  CUTOVER: CUTOVER,
  newSeed: newSeed,
  stateSeeds: stateSeeds,
  normalizeFrom: normalizeFrom,
  tradingDatesBetween: tradingDatesBetween,
  ensureSeeds: ensureSeeds,
  applySeeds: applySeeds,
  secretLookup: secretLookup,
  isSeedStr: isSeedStr,
  isDateStr: isDateStr,
  _resetMemoForTest: _resetMemoForTest
};
