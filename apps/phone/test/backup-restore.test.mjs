import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFile(path.join(here, "..", "src", rel), "utf8");

test("恢复前必须先自动存一份当前状态", async () => {
  const sheet = await src("components/BackupSheet.tsx");
  const safety = sheet.indexOf("makeSafetyBackup(");
  const restore = sheet.indexOf("restoreLocalBackup(");
  assert.ok(safety > 0, "BackupSheet 里要调 makeSafetyBackup");
  assert.ok(restore > 0, "BackupSheet 里要调 restoreLocalBackup");
  assert.ok(safety < restore, "顺序不能反：先备份，再恢复");
  // 备份失败就不该走到恢复：中间不能有 try/catch 把它吞掉
  const between = sheet.slice(safety, restore);
  assert.ok(!between.includes("catch"), "自动备份失败了就别恢复，不能吞掉异常");
});

test("两种恢复策略都接上了，覆盖有明确警示", async () => {
  const sheet = await src("components/BackupSheet.tsx");
  assert.ok(sheet.includes('setMode("merge")'), "要有合并");
  assert.ok(sheet.includes('setMode("overwrite")'), "要有覆盖");
  assert.ok(sheet.includes("覆盖本机"), "覆盖那个按钮要说人话");
  assert.ok(sheet.includes("herta-safety-"), "要告诉用户备份叫什么、能找回");

  const backup = await src("backup.ts");
  assert.ok(backup.includes('mode: RestoreMode = "merge"'), "默认必须是合并");
  assert.ok(backup.includes("replaceReadableFiles(plan.files)"), "覆盖模式下文件整库换");
  assert.ok(backup.includes("replaceReadableFiles") && backup.includes("saveReadableFile"), "合并模式逐份并进去");
  assert.ok(backup.includes("restoreNmsBackup(parsed.bundle.nms, mode)"), "记忆网络也要按模式走");
});

test("备份能带上她能读的文件，默认开", async () => {
  const sheet = await src("components/BackupSheet.tsx");
  assert.ok(sheet.includes("带上她能读的文件"), "要有这个开关");
  assert.ok(/useState\(true\)[^\n]*/.test(sheet), "开关默认开");
  assert.ok(sheet.includes("withFiles"), "打包要传 withFiles");

  const backup = await src("backup.ts");
  assert.ok(backup.includes("withFiles?: boolean"));
  assert.ok(backup.includes("loadReadableFiles()"), "文件从本地那份读");
  assert.ok(backup.includes("{ files }"), "打好的包要带 files");
});

test("恢复后给报告，数字来自 planRestore 不另算", async () => {
  const sheet = await src("components/BackupSheet.tsx");
  assert.ok(sheet.includes('data-part="restore-report"'), "报告卡要有");
  for (const label of ["会话", "记忆", "表情", "播报", "文件"]) {
    assert.ok(sheet.includes('"' + label + '"'), "报告要分项：" + label);
  }
  assert.ok(sheet.includes("report.wrote"), "写了几条");
  assert.ok(sheet.includes("report.overwritten"), "换了几条");
  assert.ok(sheet.includes("report.skipped"), "跳过了几条");

  const backup = await src("backup.ts");
  assert.ok(backup.includes("overwritten: plan.overwritten"), "覆盖数直接取 plan");
  assert.ok(backup.includes("skipped: plan.skipped"), "跳过数直接取 plan");
  assert.ok(backup.includes("hasFiles"), "要能分清「带了 0 个」和「没带这块」");
});

test("包格式：版本抬到 3，老字段一个不改名", async () => {
  const core = await readFile(path.join(here, "..", "..", "..", "packages", "core", "src", "backup.ts"), "utf8");
  assert.ok(core.includes("export const BACKUP_VERSION = 3"));
  for (const field of ["sessions", "memories"]) {
    assert.ok(new RegExp("\\n  " + field + ": ").test(core), "必填字段不能改名：" + field);
  }
  for (const field of ["stickers", "settings", "coin", "broadcast", "nms", "files"]) {
    assert.ok(core.includes(field + "?:"), "可选字段不能改名：" + field);
  }
  assert.ok(core.includes("version < 1 || version > BACKUP_VERSION"), "老版本仍要能读进来");
});
