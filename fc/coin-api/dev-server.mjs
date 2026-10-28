/*
 * 黑塔币 v1 · 本地 mock 行情服务（开发 / 浏览器冒烟用）
 *
 * 用法：
 *   node fc/coin-api/dev-server.mjs
 *   COIN_MOCK_NOW=2026-10-29T10:15:30+08:00 node fc/coin-api/dev-server.mjs   # 钉住 mock 时间
 *
 * - 监听 127.0.0.1:8787（可用 PORT 覆盖），GET /api/daily 走和线上同一份 handler；
 * - CORS：Access-Control-Allow-Origin: *，OPTIONS 预检直接 204；
 * - 不设 COIN_MOCK_NOW 时用真实时间（和线上一样）。
 *
 * app 侧开发模式默认就指向 http://127.0.0.1:8787（见 apps/phone/src/coin/config.ts）；
 * 发布包绝不内置 mock，必须通过构建参数 VITE_COIN_API_BASE 指到已部署的 FC 地址。
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHandler } = require('./index.js');

const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';
const MOCK_NOW = (process.env.COIN_MOCK_NOW || '').trim();

let nowFn = Date.now;
let mockLabel = '真实时间';
if (MOCK_NOW) {
  const ms = Date.parse(MOCK_NOW);
  if (!Number.isFinite(ms)) {
    console.error('COIN_MOCK_NOW 不是有效 ISO 时间：' + MOCK_NOW);
    console.error('例：COIN_MOCK_NOW=2026-10-29T10:15:30+08:00');
    process.exit(1);
  }
  nowFn = () => ms;
  mockLabel = '钉住 ' + MOCK_NOW;
}

const handler = createHandler({ now: nowFn });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400'
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://' + HOST + ':' + PORT);

    /* CORS 预检 */
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    /* 组装成 FC 3.0 同形 event，交给同一份 handler */
    const event = {
      version: 'v1',
      rawPath: url.pathname,
      rawQueryString: url.searchParams.toString(),
      headers: req.headers,
      queryParameters: Object.fromEntries(url.searchParams),
      requestContext: {
        domainName: HOST,
        http: {
          method: req.method,
          path: url.pathname,
          protocol: 'HTTP/1.1',
          sourceIp: req.socket && req.socket.remoteAddress
        }
      },
      body: '',
      isBase64Encoded: false
    };

    const result = await handler(event, { requestId: 'dev-' + Date.now() });
    const headers = Object.assign({}, CORS_HEADERS, result.headers || {});
    res.writeHead(result.statusCode || 500, headers);
    res.end(result.body || '');
  } catch (err) {
    console.error('[coin-mock] 未捕获异常：', err);
    const body = JSON.stringify({
      error: 'internal_error',
      message: '本地 mock 服务内部错误：' + ((err && err.message) || '未知错误')
    });
    res.writeHead(500, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }, CORS_HEADERS));
    res.end(body);
  }
});

server.listen(PORT, HOST, () => {
  console.log('[coin-mock] 黑塔币 mock 行情服务已启动');
  console.log('[coin-mock]   GET http://' + HOST + ':' + PORT + '/api/daily');
  console.log('[coin-mock]   时间：' + mockLabel);
  console.log('[coin-mock]   CORS：*（OPTIONS 204）');
});

function shutdown(sig) {
  console.log('\n[coin-mock] 收到 ' + sig + '，关端口退出');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
