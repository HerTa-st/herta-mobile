/**
 * 从素材里删掉一个字段。
 *
 * 用法：node tools/strip-field.mjs envSet
 *
 * 语气指南（hertaGuide）与办公室设定（envSet）都是"写死的场景"。
 * 前者换成了会变的语气笔记，后者换成了按钟点走的行踪（core/src/presence.ts），
 * 所以它们不该再跟着包发出去。
 */
import { readFileSync, writeFileSync } from "node:fs";

const field = process.argv[2];
if (!field) {
  console.error("用法：node tools/strip-field.mjs <字段名>");
  process.exit(1);
}

for (const lang of ["zh", "en"]) {
  const p = "assets/prompt-assets." + lang + ".json";
  const obj = JSON.parse(readFileSync(p, "utf8"));
  if (!(field in obj)) {
    console.log(lang, "没有 " + field);
    continue;
  }
  const before = JSON.stringify(obj).length;
  delete obj[field];
  const out = JSON.stringify(obj, null, 2);
  writeFileSync(p, out);
  console.log(lang, "删掉 " + field + "：" + before + " → " + out.length + " 字符");
}
