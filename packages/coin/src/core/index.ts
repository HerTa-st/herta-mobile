/*
 * 手机端行情核心的公开入口（packages/coin/src/core）。
 *
 * 应用侧只该用这几个：buildDailyResponse(nowMs, getSecret?)、getSession(nowMs)、
 * computeQuote、buildDisplay（外加 @herta/coin 里的类型与格式化）。
 * 其余导出（dailySeries / buildPlan / makeRng / daySeed / planSeed / partialBar / ds /
 * formatServerTime / fingerprint / COIN / TOTAL_BARS / API_VERSION）是给
 * test/core-parity.test.mjs 对账、给排查用的，服务端 coin-core.js 也同样是这么敞着的。
 */

export * from "./core.ts";
