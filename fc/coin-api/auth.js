/*
 * 黑塔币 · 用户凭证（谁在操作这个账号）
 *
 * 背景：2026-11-08 之前 /api/trade 与 /api/state 完全信任请求里的 user 字段，
 * 任何人 curl 一下就能读别人的持仓、替别人下单。这里补上「一把钥匙只开一个号」。
 *
 * 设计口径：
 *   - 每个用户一把 24 字节随机密钥（48 位 hex），只在绑定时返回一次；
 *   - 服务端**只存哈希**（sha256(salt + secret)），账本泄露也还原不出钥匙；
 *   - 绑定后校验用 timingSafeEqual，长度/格式不对一律当失败；
 *   - 钥匙可以单独吊销重发（owner 用 ADMIN_KEY 调 /api/bind/reset）。
 *
 * 三种模式（环境变量 AUTH_MODE，默认 off，不影响现网）：
 *   off      完全不校验，行为和以前一模一样；
 *   lenient  过渡期：已绑定的号必须带钥匙；没绑定的号，第一次来就自动绑定；
 *   strict   线上期：身份类接口没有钥匙一律 403，不再自动绑定。
 */
'use strict';

const crypto = require('crypto');

/** 密钥长度：24 字节 → 48 位 hex。 */
const SECRET_BYTES = 24;
const SECRET_RE = /^[0-9a-f]{48}$/;

const MODES = ['off', 'lenient', 'strict'];

/** 当前鉴权模式；写错了按 off 处理（宁可不拦，也别把人全挡外面）。 */
function authMode() {
  const raw = String(process.env.AUTH_MODE || '').trim().toLowerCase();
  return MODES.indexOf(raw) >= 0 ? raw : 'off';
}

function newSecret() {
  return crypto.randomBytes(SECRET_BYTES).toString('hex');
}

function isSecret(value) {
  return typeof value === 'string' && SECRET_RE.test(value);
}

function hashSecret(secret, saltHex) {
  return crypto.createHash('sha256')
    .update(Buffer.from(saltHex, 'hex'))
    .update(String(secret))
    .digest('hex');
}

/** 账本里这个号有没有绑过钥匙。 */
function binding(user) {
  const a = user && user.auth;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  if (typeof a.hash !== 'string' || typeof a.salt !== 'string') return null;
  return a;
}

/**
 * 给用户绑一把新钥匙（覆盖旧的）。调用方负责落盘。
 * @returns {string} 明文密钥——只在这一刻存在于内存里，之后只有哈希。
 */
function bind(user, secret) {
  const plain = isSecret(secret) ? secret : newSecret();
  const salt = crypto.randomBytes(16).toString('hex');
  user.auth = { salt: salt, hash: hashSecret(plain, salt), boundAt: Date.now(), lastSeenAt: 0 };
  return plain;
}

/** 吊销：删掉绑定，下次会重新走绑定流程。 */
function unbind(user) {
  if (user && user.auth) delete user.auth;
}

function verify(user, secret) {
  const a = binding(user);
  if (!a) return false;
  if (!isSecret(secret)) return false;
  const mine = Buffer.from(hashSecret(secret, a.salt), 'hex');
  const stored = Buffer.from(a.hash, 'hex');
  if (mine.length !== stored.length) return false;
  try {
    return crypto.timingSafeEqual(mine, stored);
  } catch (e) {
    return false;
  }
}

/** 钥匙从哪来：请求头优先（不进日志），其次 ?key=（给改不了原生层的客户端兜底）。 */
function readKey(event, query) {
  const q = query || {};
  if (typeof q.key === 'string' && q.key) return q.key;
  const headers = (event && event.headers) || null;
  if (!headers || typeof headers !== 'object') return '';
  const want = { 'x-herta-key': 1, authorization: 1 };
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    const name = String(keys[i]).toLowerCase();
    if (!want[name]) continue;
    let value = String(headers[keys[i]] == null ? '' : headers[keys[i]]).trim();
    if (name === 'authorization') {
      const m = /^Bearer\s+(.+)$/i.exec(value);
      if (!m) continue;
      value = m[1].trim();
    }
    if (value) return value;
  }
  return '';
}

/**
 * 判定一次身份类请求能不能放行。
 *
 * @returns {{ok:boolean, status?:number, code?:string, message?:string, bind?:boolean}}
 *   bind=true 表示「这个号还没绑定，lenient 模式下允许本次请求顺带绑定」。
 */
function checkIdentity(user, key, mode) {
  const m = mode || authMode();
  if (m === 'off') return { ok: true };
  const a = binding(user);
  if (!a) {
    if (m === 'lenient') return { ok: true, bind: true };
    return { ok: false, status: 403, code: 'not_bound', message: '这个昵称还没绑定密钥，请先绑定' };
  }
  if (verify(user, key)) return { ok: true };
  return { ok: false, status: 401, code: 'bad_key', message: '密钥不对或已失效' };
}

module.exports = {
  SECRET_BYTES: SECRET_BYTES,
  MODES: MODES,
  authMode: authMode,
  newSecret: newSecret,
  isSecret: isSecret,
  hashSecret: hashSecret,
  binding: binding,
  bind: bind,
  unbind: unbind,
  verify: verify,
  readKey: readKey,
  checkIdentity: checkIdentity,
};
