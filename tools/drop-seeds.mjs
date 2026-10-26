/**
 * 删掉指定的一批种子记忆（按标题关键词）。
 *
 * 用法：node tools/drop-seeds.mjs 远程办公
 *
 * 它同时改两处，少改一处就会在下次安装时"复活"：
 *   assets/memory/*.txt      —— 打包进去的种子本体
 *   assets/manifest.json     —— memory 清单（apps 侧是按这份清单去取文件的）
 */
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const keyword = process.argv[2];
if (!keyword) {
  console.error("用法：node tools/drop-seeds.mjs <标题关键词>");
  process.exit(1);
}

const dir = "assets/memory";
const removed = [];

for (const name of readdirSync(dir)) {
  if (!name.endsWith(".txt")) continue;
  if (!name.includes(keyword)) continue;
  unlinkSync(join(dir, name));
  removed.push(name);
}

const manifestPath = "assets/manifest.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const before = Array.isArray(manifest.memory) ? manifest.memory.length : 0;
manifest.memory = (manifest.memory ?? []).filter((m) => !String(m.path ?? "").includes(keyword));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log("删掉文件 " + removed.length + " 个：");
for (const n of removed) console.log("  " + n);
console.log("manifest.memory: " + before + " -> " + manifest.memory.length);
