/**
 * 黑塔币行情接口的地址。
 *
 * 三个来源，优先级从高到低：
 *   1. 设置里手填的 `coinApiBase`（装机后还能改，FC 没部署时不用重打 APK）；
 *   2. 构建时注入的 `VITE_COIN_API_BASE`（发布包只认这条，CI/打包脚本负责给）；
 *   3. **仅开发模式**的本地 mock。
 *
 * 为什么 mock 只认 `import.meta.env.DEV`：设计文档写死了「mock 不能带进发布包」。
 * 这样即使打包时忘了传 VITE_COIN_API_BASE，发布包也只会显示「未配置接口」，
 * 不会把 127.0.0.1 带出去。
 */

/** 本地 mock 端口，与 fc/coin-api/dev-server.mjs 对齐。 */
export const COIN_DEV_MOCK_BASE = "http://127.0.0.1:8787";

/** 构建时注入的基址；没注入就是空串。 */
export function buildCoinApiBase(): string {
  const env = import.meta.env as ImportMetaEnv & { VITE_COIN_API_BASE?: string };
  const raw = (env.VITE_COIN_API_BASE ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : "";
}

/**
 * 实际要用的基址。`` 表示没有可用接口（页面显示「行情暂不可用」）。
 *
 * `override` 是设置里那一栏——留空就按构建配置走。
 */
export function resolveCoinApiBase(override?: string): string {
  const manual = (override ?? "").trim();
  if (manual) return manual.replace(/\/+$/, "");
  const built = buildCoinApiBase();
  if (built) return built;
  if (import.meta.env.DEV) return COIN_DEV_MOCK_BASE;
  return "";
}
