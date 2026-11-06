/**
 * 故意不 import 任何东西。
 *
 * Vite 8 在 Windows 上会为了 "安全 realpath" 去 exec `net use`；这个沙箱不允许
 * 任何子进程拿管道，一 import 外部依赖就会走到那条路上，构建直接 EPERM。
 * 配置里零依赖 → 不走 externalize → 构建能跑。
 * 代价：没有 @vitejs/plugin-react 的 Fast Refresh；JSX 由 esbuild 的 automatic 运行时处理。
 *
 * 版本号从 apps/phone/version.json 读：这是唯一进 git 的版本源。
 * 打包脚本会在 Gradle 前把同一个值同步进本机 android/app/build.gradle；
 * 前端用 __HERTA_APP_VERSION__（version.ts 里有 0.0.0 回退）。
 */

function readAppVersion() {
  try {
    if (typeof process === "undefined" || typeof process.getBuiltinModule !== "function") return "0.0.0";
    const fs = process.getBuiltinModule("node:fs");
    const url = process.getBuiltinModule("node:url");
    const versionPath = url.fileURLToPath(new URL("./version.json", import.meta.url));
    const parsed = JSON.parse(fs.readFileSync(versionPath, "utf8"));
    const value = typeof parsed.versionName === "string" ? parsed.versionName.trim() : "";
    return value || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const APP_VERSION = readAppVersion();

export default {
  define: {
    __HERTA_APP_VERSION__: JSON.stringify(APP_VERSION),
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(APP_VERSION),
  },
  publicDir: "../../assets",
  server: { fs: { allow: ["../.."] } },
  esbuild: { jsx: "automatic" },
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
};
