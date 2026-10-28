/**
 * 把 pdfjs-dist 的 Adobe CMaps 拷进 publicDir（assets/pdfjs/cmaps）。
 *
 * 为什么需要：中文 PDF 常用 CID 字体，没有 CMap 时 PDF.js 要么抽不出字、要么抽出一堆
 * 乱码。这 1.1MB 不能省；但它是依赖产物，不进 git（见 .gitignore），构建前自动拷。
 *
 * 由 apps/phone/package.json 的 prebuild / prebuild:blank / prebuild:pure / predev
 * 触发；换机器 npm install 之后这些命令会自动把它补回来。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const source = join(repo, "node_modules", "pdfjs-dist", "cmaps");
const target = join(repo, "assets", "pdfjs", "cmaps");

if (!existsSync(source)) {
  console.error("找不到 " + source + " ——先在仓库根跑 npm install（可选依赖 pdfjs-dist）。");
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

const count = readdirSync(target).length;
console.log("[pdfjs] cMaps → assets/pdfjs/cmaps（" + count + " 个文件）");
