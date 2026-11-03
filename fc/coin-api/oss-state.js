/*
 * 共享市场状态存储：阿里云 OSS 单对象 + 互斥锁
 *
 * state/coin.json  —— 整个共享状态（市场 + 所有用户）
 * state/coin.lock  —— 互斥锁（x-oss-forbid-overwrite 原子创建，3 秒 TTL）
 *
 * 授权：FC 函数需要读写该 Bucket 的执行角色（RAM 角色 + OSS 读写），
 * 函数里用 context.credentials（STS）；也兼容环境变量 OSS_AK / OSS_SK / OSS_STS_TOKEN。
 *
 * 环境变量：
 *   OSS_BUCKET     默认 herta-st-gp
 *   OSS_ENDPOINT   默认 oss-cn-hongkong.aliyuncs.com
 *   STATE_KEY      默认 state/coin.json
 *   LOCK_KEY       默认 state/coin.lock
 */
'use strict';

const https = require('https');
const crypto = require('crypto');

const LOCK_TTL_MS = 3000;
const LOCK_WAIT_MS = 4000;
const REQUEST_TIMEOUT_MS = 6000;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function hmacSha1(secret, str) {
  return crypto.createHmac('sha1', secret).update(str, 'utf8').digest('base64');
}

function randomId() {
  return crypto.randomBytes(8).toString('hex');
}

class OssError extends Error {
  constructor(status, code, message) {
    super(message || code || ('OSS ' + status));
    this.status = status;
    this.code = code;
  }
}

class OssStateStore {
  constructor(options) {
    options = options || {};
    this.bucket = options.bucket || process.env.OSS_BUCKET || 'herta-st-gp';
    this.endpoint = options.endpoint || process.env.OSS_ENDPOINT || 'oss-cn-hongkong.aliyuncs.com';
    this.stateKey = options.stateKey || process.env.STATE_KEY || 'state/coin.json';
    this.lockKey = options.lockKey || process.env.LOCK_KEY || 'state/coin.lock';
    this.credentialProvider = options.credentialProvider;
  }

  async _credentials() {
    let creds = null;
    try {
      creds = this.credentialProvider ? await this.credentialProvider() : null;
    } catch (e) {
      creds = null;
    }
    if (creds && creds.ak && creds.sk) return creds;
    if (process.env.OSS_AK && process.env.OSS_SK) {
      return { ak: process.env.OSS_AK, sk: process.env.OSS_SK, token: process.env.OSS_STS_TOKEN || '' };
    }
    throw new OssError(500, 'MissingCredentials',
      'FC 未配置 OSS 执行角色：请给函数配置执行角色（OSS 读写），或在环境变量里配置 OSS_AK / OSS_SK');
  }

  _request(method, key, options) {
    options = options || {};
    const self = this;
    return this._credentials().then(function (creds) {
      return new Promise(function (resolve, reject) {
        const headers = Object.assign({}, options.headers || {});
        const body = options.body == null ? null : String(options.body);
        const contentType = headers['Content-Type'] || (body != null ? 'application/json' : '');
        if (contentType) headers['Content-Type'] = contentType;
        const date = new Date().toUTCString();
        headers.Date = date;

        // 参与签名的 x-oss-* 头（含 STS token）
        const ossHeaders = {};
        Object.keys(headers).forEach(function (k) {
          if (k.toLowerCase().indexOf('x-oss-') === 0) {
            ossHeaders[k.toLowerCase()] = String(headers[k]).trim();
          }
        });
        if (creds.token) {
          headers['x-oss-security-token'] = creds.token;
          ossHeaders['x-oss-security-token'] = String(creds.token).trim();
        }
        const canonHeaders = Object.keys(ossHeaders).sort().map(function (k) {
          return k + ':' + ossHeaders[k] + '\n';
        }).join('');
        const resource = '/' + self.bucket + '/' + key;
        const stringToSign = method + '\n\n' + (contentType || '') + '\n' + date + '\n' + canonHeaders + resource;
        const signature = hmacSha1(creds.sk, stringToSign);
        headers.Authorization = 'OSS ' + creds.ak + ':' + signature;
        if (body != null) headers['Content-Length'] = Buffer.byteLength(body);

        const req = https.request({
          protocol: 'https:',
          hostname: self.bucket + '.' + self.endpoint,
          path: '/' + key,
          method: method,
          headers: headers,
          timeout: REQUEST_TIMEOUT_MS
        }, function (res) {
          const chunks = [];
          res.on('data', function (c) { chunks.push(c); });
          res.on('end', function () {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ status: res.statusCode, headers: res.headers, body: text });
              return;
            }
            let code = '';
            let message = '';
            const codeMatch = /<Code>([^<]+)<\/Code>/.exec(text);
            const msgMatch = /<Message>([^<]+)<\/Message>/.exec(text);
            if (codeMatch) code = codeMatch[1];
            if (msgMatch) message = msgMatch[1];
            reject(new OssError(res.statusCode, code, message || text.slice(0, 200)));
          });
        });
        req.on('timeout', function () {
          req.destroy(new OssError(504, 'Timeout', 'OSS 请求超时'));
        });
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
      });
    });
  }

  async read() {
    try {
      const res = await this._request('GET', this.stateKey);
      return JSON.parse(res.body);
    } catch (e) {
      if (e instanceof OssError && e.status === 404) return null;
      throw e;
    }
  }

  async write(state) {
    await this._request('PUT', this.stateKey, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(state)
    });
  }

  async _tryLock(id) {
    const body = JSON.stringify({ id: id, at: Date.now() });
    try {
      await this._request('PUT', this.lockKey, {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-oss-forbid-overwrite': 'true' },
        body: body
      });
      return true;
    } catch (e) {
      if (e instanceof OssError && (e.status === 409 || e.code === 'FileAlreadyExists')) return false;
      throw e;
    }
  }

  async _lockInfo() {
    try {
      const res = await this._request('GET', this.lockKey);
      return JSON.parse(res.body);
    } catch (e) {
      return null;
    }
  }

  async _deleteLock() {
    try {
      await this._request('DELETE', this.lockKey);
    } catch (e) {
      // 忽略：锁可能已被别人删除
    }
  }

  async acquireLock() {
    const id = randomId();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      if (await this._tryLock(id)) return id;
      const info = await this._lockInfo();
      if (!info || !info.at || Date.now() - info.at > LOCK_TTL_MS) {
        await this._deleteLock();
        continue;
      }
      await sleep(80);
    }
    throw new OssError(503, 'MarketBusy', '市场太热闹了，请稍后再试');
  }

  async releaseLock(id) {
    const info = await this._lockInfo();
    if (info && info.id === id) await this._deleteLock();
  }

  /** 抢锁执行 fn：fn 内部自己 read/write */
  async withLock(fn) {
    const id = await this.acquireLock();
    try {
      return await fn();
    } finally {
      await this.releaseLock(id);
    }
  }
}

function credentialsFromContext(context) {
  const c = context && context.credentials;
  if (!c) return null;
  const ak = c.AccessKeyId || c.accessKeyId;
  const sk = c.AccessKeySecret || c.accessKeySecret;
  const token = c.SecurityToken || c.securityToken || '';
  if (ak && sk) return { ak: ak, sk: sk, token: token };
  return null;
}

module.exports = { OssStateStore: OssStateStore, OssError: OssError, credentialsFromContext: credentialsFromContext };
