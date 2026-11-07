/*
 * 黑塔币 · 限流（钱包的最后一道闸）
 *
 * 为什么需要它：用户密钥只回答「你是谁」，不回答「你一分钟能来多少次」。
 * 绑完号的攻击者照样可以把函数打满，CU 是按时长计费的，烧的是真钱。
 *
 * 三层，从便宜到贵依次判定：
 *   1. 全局限流 —— 整个实例每分钟的总请求数，超了直接 429。这是唯一能兜住钱包的；
 *   2. 单 IP     —— 一台机器刷爆自己，不影响别人；
 *   3. 单用户     —— 一个昵称/一把钥匙的配额，防止单人把全局额度吃光。
 *
 * 口径说明：计数器在进程内存里，每个 FC 实例各算各的。
 * 也就是说「全局上限」实际是「每实例上限 × 实例数」。
 * 这是有意的取舍——真要做跨实例精确计数得上 Redis，为了一个每天两千次请求的
 * 小接口引入 Redis 不划算，而我们要防的是「被打爆」，不是「精确到个位」。
 */
'use strict';

const WINDOW_MS = 60 * 1000;
/** 记录超过这个数就顺手清一遍过期项，防止 Map 无限长。 */
const SWEEP_THRESHOLD = 2000;

/** key -> { count, resetAt } */
const buckets = new Map();
let globalBucket = { count: 0, resetAt: 0 };

function intEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function limits() {
  return {
    enabled: String(process.env.RATE_LIMIT || 'on').trim().toLowerCase() !== 'off',
    globalPerMin: intEnv('RATE_GLOBAL_PER_MIN', 2400),
    ipPerMin: intEnv('RATE_IP_PER_MIN', 180),
    userPerMin: intEnv('RATE_USER_PER_MIN', 120)
  };
}

function sweep(now) {
  if (buckets.size < SWEEP_THRESHOLD) return;
  buckets.forEach(function (v, k) {
    if (!v || v.resetAt <= now) buckets.delete(k);
  });
}

/** 定长窗口计数：返回 true 表示这次放行。 */
function hit(key, limit, now, windowMs) {
  const w = windowMs || WINDOW_MS;
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + w };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= limit;
}

function retryAfterSeconds(resetAt, now) {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

/**
 * 判定一次请求。
 *
 * @param {{ip?:string, user?:string}} id 请求身份线索（有什么填什么）
 * @returns {{ok:boolean, scope?:string, retryAfter?:number, limit?:number}}
 */
function check(id, nowMs) {
  const cfg = limits();
  if (!cfg.enabled) return { ok: true };

  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  sweep(now);

  // 1. 全局
  if (!globalBucket || globalBucket.resetAt <= now) globalBucket = { count: 0, resetAt: now + WINDOW_MS };
  globalBucket.count += 1;
  if (globalBucket.count > cfg.globalPerMin) {
    return { ok: false, scope: 'global', limit: cfg.globalPerMin, retryAfter: retryAfterSeconds(globalBucket.resetAt, now) };
  }

  // 2. 单 IP
  const ip = id && id.ip ? String(id.ip) : '';
  if (ip) {
    if (!hit('ip:' + ip, cfg.ipPerMin, now)) {
      const b = buckets.get('ip:' + ip);
      return { ok: false, scope: 'ip', limit: cfg.ipPerMin, retryAfter: retryAfterSeconds(b.resetAt, now) };
    }
  }

  // 3. 单用户（有名字或有钥匙都算）
  const user = id && id.user ? 'u:' + id.user : (id && id.key ? 'k:' + String(id.key).slice(0, 16) : '');
  if (user) {
    if (!hit(user, cfg.userPerMin, now)) {
      const b = buckets.get(user);
      return { ok: false, scope: 'user', limit: cfg.userPerMin, retryAfter: retryAfterSeconds(b.resetAt, now) };
    }
  }

  return { ok: true };
}

/** 客户端 IP：FC 3.0 放在 requestContext.http.sourceIp，代理链路退化时看 x-forwarded-for。 */
function clientIp(event) {
  const ctx = event && event.requestContext;
  const http = ctx && (ctx.http || ctx);
  const direct = http && (http.sourceIp || http.sourceIpAddress);
  if (typeof direct === 'string' && direct) return direct;
  const headers = (event && event.headers) || {};
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === 'x-forwarded-for') {
      const first = String(headers[keys[i]] || '').split(',')[0].trim();
      if (first) return first;
    }
  }
  return '';
}

/** 测试用：清空所有计数。 */
function _resetForTest() {
  buckets.clear();
  globalBucket = { count: 0, resetAt: 0 };
}

module.exports = {
  check: check,
  limits: limits,
  clientIp: clientIp,
  _resetForTest: _resetForTest
};
