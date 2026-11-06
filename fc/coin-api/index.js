/*
 * 黑塔币 v2 · 阿里云函数计算 FC 3.0 HTTP 触发器入口（行情 + 共享市场）
 *
 * 路由：
 *   GET  /api/daily?user=昵称      行情（兼容 v1；user 可选）
 *   GET  /api/state?user=昵称      共享市场状态（价格 / 我的持仓 / 排行榜）
 *   POST /api/trade                 {"user":"昵称","action":"market|limit|open_short|close_short|restart",...}
 *   POST /api/restart               {"user":"昵称"} 主动重开（等价 action=restart）
 *   GET  /api/leaderboard          排行榜
 *   GET  /api/seeds?from=YYYY-MM-DD  每日价格密钥（切换日 2026-11-07 起）
 *   其它：405 / 404；异常统一 JSON
 *
 * 响应头：Content-Type: application/json; charset=utf-8、Cache-Control: no-store、CORS *
 * 存储：OSS 单对象 state/coin.json + 互斥锁（见 oss-state.js）
 * 授权：函数执行角色（OSS 读写）→ context.credentials（STS）；兼容环境变量 OSS_AK / OSS_SK
 *
 * 部署：Node.js 20，handler 填 index.handler，HTTP 触发器（GET/POST，无需认证）。
 */
'use strict';

const { buildDailyResponse, buildPlan, getSession, makeRng, COIN } = require('./coin-core');
const { ensureSeeds, applySeeds, secretLookup } = require('./seeds');
const {
  createState,
  buildStatePayload,
  executeTrade,
  executeAction,
  normalizeName,
  effectivePrice,
  buildLeaderboard,
  signIn,
  claimLocalWallet,
  signinInfo,
  publicUser
} = require('./market-v2');
const { OssStateStore, credentialsFromContext } = require('./oss-state');

const API_PATH = '/api/daily';

const RESPONSE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept'
};

function jsonResponse(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: RESPONSE_HEADERS,
    body: JSON.stringify(payload),
    isBase64Encoded: false
  };
}

/* 兼容 FC 3.0（rawPath/requestContext）与 FC 2.0（httpMethod/path）两种 event 形态 */
/* ---------------- 快讯（B7：服务端随行情下发，复用 news-pool） ---------------- */

/** 与网页 app.js 的 EXCHANGES 同列表（只用于把 {ex} 渲染成人话）。 */
const NEWS_EXCHANGES = ['模拟宇宙交易所', '星际所', '深空所', '奇物所', '空间站 OTC'];

/**
 * 新闻文案占位符替换：逐字对齐网页 app.js 的 renderNewsText。
 * 随机数种子是 plan.key + bar，和网页一样——快讯文字与它冲击的那根 K 天然对齐。
 */
function renderNewsText(tpl, rng) {
  return String(tpl).replace(/\{name\}|\{code\}|\{ex\}|%a%|%b%|%c%|%n%/g, function (token) {
    switch (token) {
      case '{name}': return COIN.name;
      case '{code}': return COIN.code;
      case '{ex}': return rng.pick(NEWS_EXCHANGES);
      case '%a%': return String(rng.int(1, 99));
      case '%b%': return String(rng.int(1, 98) * 100);
      case '%c%': return String(rng.int(5, 300));
      case '%n%': return String(rng.int(1, 99));
      default: return token;
    }
  });
}

/** 分钟下标 -> HH:MM（与 App 图表同一口径：t<120 是上午，其余是下午）。 */
function newsTimeLabel(bar) {
  const i = Math.max(0, Math.min(239, Math.floor(bar)));
  const minutes = i < 120 ? 9 * 60 + 30 + i : 13 * 60 + (i - 120);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return hh + ':' + mm;
}

/**
 * 把当日计划里已经到点的新闻抽出来；未解锁的不下发，只给 total。
 * 交易中：revealed 是已走完的根数，当前分钟的部分 K 也算“已到点”（与网页一致）。
 */
function ymdToUtcDate(ymd) {
  const p = String(ymd).split('-');
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
}

function buildNews(daily, getSecret) {
  // buildPlan 吃 Date（内部 ds() 用 UTC 字段）；HTTP 层拿到的是 YYYY-MM-DD 字符串
  const plan = buildPlan(ymdToUtcDate(daily.market.sessionDate), getSecret);
  const maxBar = daily.market.status === 'trading' ? daily.market.revealed : daily.market.revealed - 1;
  const items = plan.events
    .filter(function (e) { return e.bar <= maxBar; })
    .sort(function (a, b) { return b.bar - a.bar; })
    .map(function (e) {
      const rng = makeRng(plan.key + '|news|' + e.bar);
      const dir = e.dir > 0 ? 'up' : (e.dir < 0 ? 'down' : 'flat');
      const tag = e.dir > 0 ? '利好' : (e.dir < 0 ? '利空' : '中性');
      return {
        bar: e.bar,
        time: newsTimeLabel(e.bar),
        dir: dir,
        tag: tag,
        strength: e.strength,
        text: renderNewsText(e.tpl, rng)
      };
    });
  return { total: plan.events.length, items: items };
}

function normalizeEvent(event) {
  if (!event) return {};
  if (typeof event === 'string') {
    try { return JSON.parse(event); } catch (e) { return {}; }
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(event)) {
    try { return JSON.parse(event.toString('utf8')); } catch (e) { return {}; }
  }
  return event;
}

function normalizePath(rawPath) {
  let path = rawPath;
  if (Array.isArray(path)) path = path[0];
  if (typeof path !== 'string' || !path) return '/';
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  if (path.charAt(0) !== '/') path = '/' + path;
  while (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
  return path;
}

function parseQuery(event, rawPath) {
  if (event.queryStringParameters && typeof event.queryStringParameters === 'object') {
    return event.queryStringParameters;
  }
  // FC 3.0 的 HTTP 触发器把 query 放在 queryParameters
  if (event.queryParameters && typeof event.queryParameters === 'object') {
    return event.queryParameters;
  }
  let raw = '';
  if (typeof event.rawQueryString === 'string') {
    raw = event.rawQueryString;
  } else if (typeof rawPath === 'string' && rawPath.indexOf('?') >= 0) {
    raw = rawPath.slice(rawPath.indexOf('?') + 1);
  }
  const out = {};
  if (raw) {
    raw.split('&').forEach(function (pair) {
      if (!pair) return;
      const idx = pair.indexOf('=');
      const k = idx >= 0 ? pair.slice(0, idx) : pair;
      const v = idx >= 0 ? pair.slice(idx + 1) : '';
      try { out[decodeURIComponent(k)] = decodeURIComponent(v); } catch (e) { out[k] = v; }
    });
  }
  return out;
}

function requestInfo(event) {
  const ctxHttp = (event.requestContext && (event.requestContext.http || event.requestContext)) || {};
  const method = event.httpMethod || ctxHttp.method || event.method || '';
  const path = event.path || event.rawPath || ctxHttp.path || '';
  const query = parseQuery(event, event.rawPath || event.path || '');
  return { method: String(method).toUpperCase(), path: normalizePath(path), query: query };
}

function parseBody(event) {
  let body = event.body;
  if (body == null || body === '') return {};
  if (typeof body === 'object') return body;
  if (event.isBase64Encoded) {
    try { body = Buffer.from(body, 'base64').toString('utf8'); } catch (e) { return {}; }
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    const err = new Error('请求体不是合法 JSON');
    err.status = 400;
    err.code = 'invalid_json';
    throw err;
  }
}

function defaultStoreFactory(context) {
  return new OssStateStore({
    credentialProvider: function () { return credentialsFromContext(context); }
  });
}

/**
 * @param {object} options
 *   options.now          测试用时钟
 *   options.storeFactory 测试用存储工厂（(context) => store）
 */
function createHandler(options) {
  options = options || {};
  const nowFn = typeof options.now === 'function' ? options.now : Date.now;
  const storeFactory = options.storeFactory || defaultStoreFactory;

  /**
   * 先读 seeds 再算行情（切换日之前密钥为空，一次 OSS 都不碰）。
   * 缺的密钥当场生成并落盘——同一日期只生成一次，价格历史才稳得住。
   * @returns {Promise<{daily: object, getSecret: Function, seeds: object}>}
   */
  async function loadDaily(nowMs, store) {
    const seedInfo = await ensureSeeds(store, {
      nowMs: nowMs,
      // 空账本要建就建成正常账本（和 /api/state 第一次建号同一个形状）
      sessionDate: getSession(nowMs).sessionDate,
      createEmptyState: function (sessionDate) { return createState(sessionDate); }
    });
    const getSecret = secretLookup(seedInfo.seeds);
    return {
      daily: buildDailyResponse(nowMs, getSecret),
      getSecret: getSecret,
      seeds: seedInfo.seeds
    };
  }

  return async function handler(event, context) {
    let info = { method: '', path: '' };
    try {
      const ev = normalizeEvent(event);
      info = requestInfo(ev);

      if (info.method === 'OPTIONS') {
        return { statusCode: 204, headers: RESPONSE_HEADERS, body: '' };
      }

      /* ---------- 每日价格密钥（客户端拿它本地算 K 线） ---------- */
      if (info.path === '/api/seeds') {
        if (info.method !== 'GET') {
          return jsonResponse(405, { error: 'method_not_allowed', message: '只支持 GET 请求' });
        }
        const nowMs = nowFn();
        const store = storeFactory(context);
        const seedInfo = await ensureSeeds(store, {
          nowMs: nowMs,
          from: info.query.from,
          sessionDate: getSession(nowMs).sessionDate,
          createEmptyState: function (sessionDate) { return createState(sessionDate); }
        });
        return jsonResponse(200, seedInfo);
      }

      /* ---------- 行情（v1 兼容） ---------- */
      if (info.path === API_PATH) {
        if (info.method !== 'GET') {
          return jsonResponse(405, { error: 'method_not_allowed', message: '只支持 GET 请求' });
        }
        const nowMs = nowFn();
        const store = storeFactory(context);
        const loaded = await loadDaily(nowMs, store);
        const daily = loaded.daily;
        // 快讯只加在 HTTP 外壳上：coin-core 的纯算法与测试向量保持原样
        return jsonResponse(200, Object.assign({}, daily, { news: buildNews(daily, loaded.getSecret) }));
      }

      /* ---------- 共享市场状态 ---------- */
      if (info.path === '/api/state') {
        if (info.method !== 'GET') {
          return jsonResponse(405, { error: 'method_not_allowed', message: '只支持 GET 请求' });
        }
        const nowMs = nowFn();
        const name = normalizeName(info.query.user);
        const store = storeFactory(context);
        const loaded = await loadDaily(nowMs, store);
        const daily = loaded.daily;

        // 快路径：状态已存在且不需要建号 / 换场，就不动锁
        const existing = await store.read();
        if (existing) {
          const built = buildStatePayload(daily, existing, name, nowMs);
          if (!built.dirty) return jsonResponse(200, built.payload);
        }

        const payload = await store.withLock(async function () {
          let state = await store.read();
          if (!state) state = createState(daily.market.sessionDate);
          const built = buildStatePayload(daily, state, name, nowMs);
          applySeeds(state, loaded.seeds);
          await store.write(state);
          return built.payload;
        });
        return jsonResponse(200, payload);
      }

      /* ---------- 交易 ---------- */
      if (info.path === '/api/trade' || info.path === '/api/restart') {
        if (info.method !== 'POST') {
          return jsonResponse(405, { error: 'method_not_allowed', message: '只支持 POST 请求' });
        }
        const body = parseBody(ev);
        const nowMs = nowFn();
        const name = normalizeName(body.user);
        const store = storeFactory(context);
        const loaded = await loadDaily(nowMs, store);
        const daily = loaded.daily;

        const result = await store.withLock(async function () {
          let state = await store.read();
          if (!state) state = createState(daily.market.sessionDate);
          const actionBody = info.path === '/api/restart'
            ? Object.assign({}, body, { action: 'restart' })
            : body;
          const r = executeAction(daily, state, name, actionBody, nowMs);
          applySeeds(state, loaded.seeds);
          await store.write(state);
          return r;
        });

        return jsonResponse(200, Object.assign({ ok: true, serverTime: daily.serverTime }, result));
      }

      /* ---------- 服务端签到 ---------- */
      if (info.path === '/api/signin') {
        if (info.method !== 'POST') {
          return jsonResponse(405, { error: 'method_not_allowed', message: '只支持 POST 请求' });
        }
        const body = parseBody(ev);
        const nowMs = nowFn();
        const name = normalizeName(body.user);
        const store = storeFactory(context);
        const loaded = await loadDaily(nowMs, store);
        const daily = loaded.daily;

        const result = await store.withLock(async function () {
          let state = await store.read();
          if (!state) state = createState(daily.market.sessionDate);
          const r = signIn(daily, state, name, nowMs);
          applySeeds(state, loaded.seeds);
          await store.write(state);
          const price = effectivePrice(daily, state).price;
          return {
            ok: true,
            reward: r.reward,
            streak: r.streak,
            user: publicUser(r.user, price),
            signin: signinInfo(daily, r.user),
            serverTime: daily.serverTime
          };
        });
        return jsonResponse(200, result);
      }

      /* ---------- 合并在单机钱包 ---------- */
      if (info.path === '/api/claim') {
        if (info.method !== 'POST') {
          return jsonResponse(405, { error: 'method_not_allowed', message: '只支持 POST 请求' });
        }
        const body = parseBody(ev);
        const nowMs = nowFn();
        const name = normalizeName(body.user);
        const store = storeFactory(context);
        const loaded = await loadDaily(nowMs, store);
        const daily = loaded.daily;

        const result = await store.withLock(async function () {
          let state = await store.read();
          if (!state) state = createState(daily.market.sessionDate);
          const r = claimLocalWallet(daily, state, name, body.amount, nowMs);
          applySeeds(state, loaded.seeds);
          await store.write(state);
          const price = effectivePrice(daily, state).price;
          return {
            ok: true,
            mergedHtc: r.mergedHtc,
            user: publicUser(r.user, price),
            serverTime: daily.serverTime
          };
        });
        return jsonResponse(200, result);
      }

      /* ---------- 排行榜 ---------- */
      if (info.path === '/api/leaderboard') {
        if (info.method !== 'GET') {
          return jsonResponse(405, { error: 'method_not_allowed', message: '只支持 GET 请求' });
        }
        const nowMs = nowFn();
        const store = storeFactory(context);
        const loaded = await loadDaily(nowMs, store);
        const daily = loaded.daily;
        const state = await store.read();
        const price = state ? effectivePrice(daily, state).price : daily.market.close;
        const board = state ? buildLeaderboard(state, price, 20) : [];
        return jsonResponse(200, {
          version: 2,
          serverTime: daily.serverTime,
          price: Math.round(price * 100) / 100,
          leaderboard: board
        });
      }

      return jsonResponse(404, {
        error: 'not_found',
        message: '没有这个接口；行情 /api/daily、密钥 /api/seeds、状态 /api/state、交易 /api/trade、排行 /api/leaderboard'
      });
    } catch (err) {
      const status = (err && err.status && err.status >= 400 && err.status < 600) ? err.status : 500;
      const code = (err && err.code) || 'internal_error';
      const message = (err && err.message) || '服务端异常';
      console.error('[coin-api] ' + status + ' path=' + info.path + ' method=' + info.method +
        ' requestId=' + ((context && context.requestId) || '-') + ' err=' + message);
      return jsonResponse(status, { error: code, message: message });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
exports.API_PATH = API_PATH;
