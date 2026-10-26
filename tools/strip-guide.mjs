/**
 * 把 hertaGuide 从素材里摘掉。
 *
 * 语气不再由一段固定指南注入，而是她自己长期攒出来、并且会改的东西（见 core/src/voice.ts）。
 * 这个脚本只跑一次，跑完 assets/prompt-assets.*.json 里就没有 hertaGuide 了。
 */
import { readFileSync, writeFileSync } from "node:fs";

for (const lang of ["zh", "en"]) {
  const p = "assets/prompt-assets." + lang + ".json";
  const obj = JSON.parse(readFileSync(p, "utf8"));
  if (!("hertaGuide" in obj)) {
    console.log(lang, "已经没有了");
    continue;
  }
  const before = JSON.stringify(obj).length;
  delete obj.hertaGuide;
  const out = JSON.stringify(obj, null, 2);
  writeFileSync(p, out);
  console.log(lang, "removed:", before, "->", out.length, "chars");
}
