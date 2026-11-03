/**
 * 原型静态服务器（零依赖）。
 *
 *   npm run prototype:ui
 *
 * 只服务 design/ 目录，默认 127.0.0.1:5199。
 * 这是一次性原型的入口，不参与构建、不打进 APK。
 */
import http from "node:http";
import { statSync, createReadStream } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../design", import.meta.url)));
const port = Number(process.env.PORT || 5199);
const host = process.env.HOST || "127.0.0.1";
const entry = "/prototype-2026-11/index.html";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  if (pathname === "/") {
    res.writeHead(302, { Location: entry }).end();
    return;
  }

  const file = resolve(join(root, normalize(pathname)));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const info = statSync(file);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
  }
});

server.listen(port, host, () => {
  console.log("Herta UI prototype: http://" + host + ":" + port + entry);
  console.log("variant=A|B|C   screen=chat|memory|coin|...");
  console.log("Ctrl+C 停止。");
});
