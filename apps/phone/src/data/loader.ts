/**
 * 纯净版内置的那条对话。
 *
 * 单独一个模块，是因为它在普通构建里必须能被整个摇掉：
 * 887KB 的 JSON 只有 pure 模式才需要。
 */
export async function loadPureSession(): Promise<unknown> {
  const mod = await import("./pure-session.json");
  return (mod as { default: unknown }).default;
}
