/*
 * 黑塔币 v1 · 阿里云函数计算 FC 3.0 HTTP 触发器入口
 *
 * 路由：GET /api/daily  ->  { version, serverTime, market }（契约 §2.2）
 * 其它：非 GET -> 405；非 /api/daily -> 404；异常 -> 500（JSON 里带一句人话）。
 * 响应头：Content-Type: application/json; charset=utf-8、Cache-Control: no-store、
 *         Access-Control-Allow-Origin: *。
 *
 * 部署：Node.js 20，handler 填 index.handler，HTTP 触发器路径 /api/daily（GET）。
 * 时间：固定按 UTC+8 计算，不依赖服务器时区；serverTime 形如 2026-10-29T10:15:30+08:00。
 */
'use strict';

const { buildDailyResponse } = require('./coin-core');

const API_PATH = '/api/daily';

const RESPONSE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

/* 兼容 FC 3.0（v1: rawPath/requestContext）与 FC 2.0（httpMethod/path）两种 event 形态；
 * 有些触发方式会把 event 序列化成 JSON 字符串/Buffer 传进来，也一并兜住。 */
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

function requestInfo(event) {
  const ctxHttp = (event.requestContext && (event.requestContext.http || event.requestContext)) || {};
  const method = event.httpMethod || ctxHttp.method || event.method || '';
  const path = event.path || event.rawPath || ctxHttp.path || '';
  return { method: String(method).toUpperCase(), path: normalizePath(path) };
}

/**
 * 生成 handler；options.now 仅供本地 dev-server 钉住时间用，线上不传（默认 Date.now）。
 * 纯函数核心在 coin-core.buildDailyResponse(nowMs)，handler 只做 HTTP 外壳。
 */
function createHandler(options) {
  const nowFn = (options && typeof options.now === 'function') ? options.now : Date.now;

  return async function handler(event, context) {
    let info = { method: '', path: '' };
    try {
      const ev = normalizeEvent(event);
      info = requestInfo(ev);

      if (info.path !== API_PATH) {
        return jsonResponse(404, {
          error: 'not_found',
          message: '没有这个接口；行情接口是 GET /api/daily'
        });
      }
      if (info.method !== 'GET') {
        return jsonResponse(405, {
          error: 'method_not_allowed',
          message: '只支持 GET 请求'
        });
      }

      const nowMs = nowFn();
      return jsonResponse(200, buildDailyResponse(nowMs));
    } catch (err) {
      const detail = (err && err.message) ? err.message : String(err);
      console.error('[coin-api] 500 path=' + info.path + ' method=' + info.method +
        ' requestId=' + ((context && context.requestId) || '-') + ' err=' + detail);
      return jsonResponse(500, {
        error: 'internal_error',
        message: '行情计算失败，请稍后再试（' + detail + '）'
      });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
exports.API_PATH = API_PATH;
