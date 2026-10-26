/**
 * 故意不 import 任何东西。
 *
 * Vite 8 在 Windows 上会为了 "安全 realpath" 去 exec `net use`；这个沙箱不允许
 * 任何子进程拿管道，一 import 外部依赖就会走到那条路上，构建直接 EPERM。
 * 配置里零依赖 → 不走 externalize → 构建能跑。
 * 代价：没有 @vitejs/plugin-react 的 Fast Refresh；JSX 由 esbuild 的 automatic 运行时处理。
 */
export default {
  publicDir: "../../assets",
  server: { fs: { allow: ["../.."] } },
  esbuild: { jsx: "automatic" },
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
};
