import { useCallback, useEffect, useState } from "react";
import { formatSize, type BackupStats } from "@herta/core";
import type { Settings } from "../settings.ts";
import { listSessions, listStickers } from "../storage.ts";
import { IdbMemoryStore } from "../memory-idb.ts";
import { buildLocalBackup, readBackup, restoreLocalBackup, saveBackup, shareBackup } from "../backup.ts";

/**
 * 备份与迁移。
 *
 * 一句话：把这台手机上的家底打成一个文件，发到另一台手机上，在那台的这里点导入。
 *
 * 两处刻意的取舍：
 *   - **不带 API Key**（设置里可以选带设置，Key 也会被剔掉）：那是你的凭据，不属于她；
 *   - 导入先去重再写（会话 id / 记忆文件名 / 表情 id），同一份包导两次不会变成两份。
 */
export function BackupSheet({
  settings,
  onClose,
  onRestored,
}: {
  settings: Settings;
  onClose(): void;
  onRestored(): void;
}) {
  const [counts, setCounts] = useState({ sessions: 0, memories: 0, stickers: 0 });
  const [withStickers, setWithStickers] = useState(true);
  const [withSettings, setWithSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [lastStats, setLastStats] = useState<BackupStats | null>(null);
  const [pending, setPending] = useState<{ text: string; stats: BackupStats; from?: string } | null>(null);

  const loadCounts = useCallback(async () => {
    const [metas, memories, stickers] = await Promise.all([
      listSessions(),
      new IdbMemoryStore().list(),
      listStickers(),
    ]);
    setCounts({ sessions: metas.length, memories: memories.length, stickers: stickers.length });
  }, []);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  const pack = async () => {
    setBusy(true);
    setNote(null);
    try {
      const backup = await buildLocalBackup(settings, { withStickers, withSettings });
      setLastStats(backup.stats);
      return backup;
    } finally {
      setBusy(false);
    }
  };

  const doShare = async () => {
    try {
      const backup = await pack();
      if (!backup) return;
      setNote(await shareBackup(backup));
    } catch (e) {
      setNote("打包失败：" + (e instanceof Error ? e.message : String(e)));
    }
  };

  const doSave = async () => {
    try {
      const backup = await pack();
      if (!backup) return;
      setNote(await saveBackup(backup));
    } catch (e) {
      setNote("保存失败：" + (e instanceof Error ? e.message : String(e)));
    }
  };

  const pickFile = async (file: File) => {
    setNote(null);
    setPending(null);
    try {
      const text = await file.text();
      const parsed = await readBackup(text);
      if (!parsed.ok) {
        setNote("这个文件不能用：" + parsed.error);
        return;
      }
      setPending({ text, stats: parsed.stats, ...(parsed.bundle.from ? { from: parsed.bundle.from } : {}) });
    } catch (e) {
      setNote("读不了这个文件：" + (e instanceof Error ? e.message : String(e)));
    }
  };

  const confirmRestore = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const out = await restoreLocalBackup(pending.text);
      const w = out.writes;
      const s = out.skipped;
      setNote(
        "导入完成：会话 " + w.sessions + "、记忆 " + w.memories + "、表情 " + w.stickers + "。" +
          (s.sessions + s.memories + s.stickers > 0
            ? "跳过已有：" + [s.sessions ? "会话 " + s.sessions : "", s.memories ? "记忆 " + s.memories : "", s.stickers ? "表情 " + s.stickers : ""]
                .filter(Boolean)
                .join("、")
            : "")
      );
      setPending(null);
      await loadCounts();
      onRestored();
    } catch (e) {
      setNote("导入失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet">
      <div className="sheetHead">
        <span>备份与迁移</span>
        <button type="button" className="sheetClose" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>

      <p className="memNote">
        现在这台手机上有 {counts.sessions} 个会话、{counts.memories} 篇记忆、{counts.stickers} 张表情。
        打包会生成一个 .json 文件，发到新手机，在那台的这一页点「选文件」导进来。
      </p>

      <label className="check capRow">
        <input type="checkbox" checked={withStickers} onChange={(e) => setWithStickers(e.target.checked)} />
        <span>
          <b>带上表情包</b>
          <em>不带的话，另一台手机的历史里那些表情会显示成「（表情已删）」。</em>
        </span>
      </label>
      <label className="check capRow">
        <input type="checkbox" checked={withSettings} onChange={(e) => setWithSettings(e.target.checked)} />
        <span>
          <b>带上设置</b>
          <em>模型名、预算、开关这些。API Key 不带——那是你的凭据，换机请重新填一次。</em>
        </span>
      </label>

      <button type="button" className="sheetLink" onClick={() => void doShare()} disabled={busy}>
        <span>打包并分享</span>
        <span className="sheetLinkHint">发到微信 / 存文件 ›</span>
      </button>
      <button type="button" className="onboardBtn" onClick={() => void doSave()} disabled={busy}>
        {busy ? "打包中…" : "打包并存到手机上"}
      </button>

      {lastStats && (
        <p className="memNote">
          上一个包：会话 {lastStats.sessions}、{lastStats.blocks} 块、记忆 {lastStats.memories}、表情{" "}
          {lastStats.stickers}，共 {formatSize(lastStats.bytes)}。
        </p>
      )}

      <h3 className="capGroup">从另一台手机导进来</h3>
      <label className="onboardBtn" style={{ display: "block", textAlign: "center" }}>
        {pending ? "换一个文件" : "选文件"}
        <input
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void pickFile(file);
          }}
        />
      </label>

      {pending && (
        <>
          <p className="memNote">
            这份包{pending.from ? "来自" + pending.from + "，" : ""}有会话 {pending.stats.sessions}、记忆{" "}
            {pending.stats.memories}、表情 {pending.stats.stickers}，共 {formatSize(pending.stats.bytes)}。
            导入不会覆盖已有的东西，重复的会跳过。
          </p>
          <button type="button" className="sheetLink" onClick={() => void confirmRestore()} disabled={busy}>
            <span>{busy ? "导入中…" : "确认导入"}</span>
            <span className="sheetLinkHint">只加不覆盖 ›</span>
          </button>
        </>
      )}

      {note && <p className="memNote">{note}</p>}

      <p className="memNote">
        提示：包里有图片时文件会比较大。微信发文件别用「图片」，用「文件」发，否则会被压缩。
      </p>
    </div>
  );
}
