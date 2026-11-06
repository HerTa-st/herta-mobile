import { useCallback, useEffect, useState } from "react";
import { buildBackupBundle, formatSize, type BackupStats } from "@herta/core";
import type { Session } from "@herta/protocol";
import type { Settings } from "../settings.ts";
import { listSessions, listStickers, loadSession } from "../storage.ts";
import { IdbMemoryStore } from "../memory-idb.ts";
import { loadCoinWallet } from "../coin/coin-storage.ts";
import { listBroadcastIssues } from "../broadcast/storage.ts";
import {
  backupFilename,
  buildLocalBackup,
  readBackup,
  restoreLocalBackup,
  saveBackup,
  shareBackup,
} from "../backup.ts";
import "../styles/settings-suite.css";

const ICON = {
  back: "M15 6l-6 6 6 6",
  close: "M6 6l12 12M18 6L6 18",
} as const;

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

function stamp(at: Date): string {
  return at.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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
  const [counts, setCounts] = useState({ sessions: 0, memories: 0, stickers: 0, broadcast: 0, wallet: false });
  const [withStickers, setWithStickers] = useState(true);
  const [withSettings, setWithSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [lastStats, setLastStats] = useState<BackupStats | null>(null);
  const [lastAt, setLastAt] = useState<Date | null>(null);
  const [pending, setPending] = useState<{ text: string; stats: BackupStats; from?: string; coin: boolean } | null>(null);

  const loadCounts = useCallback(async () => {
    const [metas, memories, stickers, wallet, broadcast] = await Promise.all([
      listSessions(),
      new IdbMemoryStore().list(),
      listStickers(),
      loadCoinWallet(),
      listBroadcastIssues(),
    ]);
    setCounts({
      sessions: metas.length,
      memories: memories.length,
      stickers: stickers.length,
      broadcast: broadcast.length,
      wallet: wallet !== null,
    });
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
      setLastAt(new Date());
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

  /** 只把会话打包（记忆 / 表情 / 钱包 / 设置都不带）：给单条归档或排查用。 */
  const doSessionsOnly = async () => {
    setBusy(true);
    setNote(null);
    try {
      const metas = await listSessions();
      const loaded = await Promise.all(metas.map((m) => loadSession(m.id)));
      const sessions = loaded.filter((s): s is Session => s !== null);
      const { bundle, stats } = buildBackupBundle({
        sessions,
        memories: [],
        from: "Herta 手机端 · 仅会话",
      });
      const filename = backupFilename().replace("herta-backup-", "herta-sessions-");
      const where = await shareBackup({ json: JSON.stringify(bundle), filename, stats });
      setNote("已只导出会话：" + stats.sessions + " 个 / " + stats.blocks + " 块（" + formatSize(stats.bytes) + "）。" + where);
    } catch (e) {
      setNote("导出失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
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
      setPending({
        text,
        stats: parsed.stats,
        ...(parsed.bundle.from ? { from: parsed.bundle.from } : {}),
        coin: parsed.bundle.coin !== undefined,
      });
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
        "导入完成：会话 " + w.sessions + "、记忆 " + w.memories + "、表情 " + w.stickers +
          (w.broadcast ? "、播报 " + w.broadcast + " 期" : "") +
          (w.wallet ? "、黑塔币钱包" : "") + "。" +
          (s.sessions + s.memories + s.stickers + s.broadcast > 0
            ? "跳过已有：" + [s.sessions ? "会话 " + s.sessions : "", s.memories ? "记忆 " + s.memories : "", s.stickers ? "表情 " + s.stickers : "", s.broadcast ? "播报 " + s.broadcast : ""]
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
    <div className="ss-page" data-part="panel" role="dialog" aria-label="备份与迁移">
      <header className="ss-top">
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="返回">
          <Icon d={ICON.back} size={18} />
        </button>
        <div className="ss-title">
          <b>备份与迁移</b>
          <span>整包 · 不含 API Key</span>
        </div>
        <span className="ss-badge">
          <i />
          本机
        </span>
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="关闭">
          <Icon d={ICON.close} size={16} />
        </button>
      </header>

      <div className="ss-body">
        <section className="ss-card ss-cardPad">
          <div className="ss-kicker">SNAPSHOT · 换机带走</div>
          <div className="bk-big">
            <b>{lastStats ? formatSize(lastStats.bytes) : "—"}</b>
            <span>整包体积 · 不含 API Key</span>
          </div>
          <div className="bk-bar" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="bk-actions">
            <button type="button" className="ss-btn ss-btnInk ss-btnWide" onClick={() => void doShare()} disabled={busy}>
              {busy ? "打包中…" : "打包并分享"}
            </button>
            <button type="button" className="ss-btn ss-btnGhost ss-btnWide" onClick={() => void doSave()} disabled={busy}>
              打包并存到手机上
            </button>
          </div>
          <p className="bk-last">
            {lastAt ? "上次打包：" + stamp(lastAt) : "本次打开还没打包过；第一次打包后这里会记住体积与时间。"}
          </p>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>包内清单</span>
            <span>6 项</span>
          </div>
          <div className="bk-manifestRow">
            <span>会话</span>
            <b>{counts.sessions} 条</b>
            <small>含导入归档</small>
          </div>
          <div className="bk-manifestRow">
            <span>记忆</span>
            <b>{counts.memories} 篇</b>
            <small>NMS 快照</small>
          </div>
          <div className="bk-manifestRow">
            <span>播报</span>
            <b>{counts.broadcast} 期</b>
            <small>单机播报</small>
          </div>
          <div className="bk-manifestRow">
            <span>表情</span>
            <b>{withStickers ? counts.stickers + " 张" : "不带"}</b>
            <small>{withStickers ? "会一起打包" : "按选项跳过"}</small>
          </div>
          <div className="bk-manifestRow">
            <span>钱包</span>
            <b>{counts.wallet ? "有" : "无"}</b>
            <small>恢复时不覆盖</small>
          </div>
          <div className="bk-manifestRow">
            <span>设置</span>
            <b>{withSettings ? "1 份" : "不带"}</b>
            <small>API Key 不打包</small>
          </div>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>打包选项</span>
            <span>2 项</span>
          </div>
          <label className="ss-row">
            <span className="ss-rowMain">
              <b>带上表情包</b>
              <small>不带的话，另一台手机的历史里那些表情会显示成「（表情已删）」。</small>
            </span>
            <input
              type="checkbox"
              className="ss-switch"
              checked={withStickers}
              onChange={(e) => setWithStickers(e.target.checked)}
            />
          </label>
          <label className="ss-row">
            <span className="ss-rowMain">
              <b>带上设置</b>
              <small>模型名、预算、开关这些。API Key 不带——那是你的凭据，换机请重新填一次。</small>
            </span>
            <input
              type="checkbox"
              className="ss-switch"
              checked={withSettings}
              onChange={(e) => setWithSettings(e.target.checked)}
            />
          </label>
        </section>

        <section className="ss-card ss-cardPad">
          <div className="ss-groupHead bk-restoreHead">
            <span>从另一台手机导进来</span>
            <span>只加不覆盖</span>
          </div>
          <div className="bk-restoreRow">
            <label className="ss-btn ss-btnGhost">
              {pending ? "换一个文件" : "从备份恢复"}
              <input
                className="ss-hiddenFile"
                type="file"
                accept=".json,application/json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void pickFile(file);
                }}
              />
            </label>
            <button
              type="button"
              className="ss-btn ss-btnGhost"
              onClick={() => void doSessionsOnly()}
              disabled={busy}
            >
              只导出会话
            </button>
          </div>
        </section>

        {pending && (
          <section className="ss-card ss-cardPad bk-pending">
            <div className="ss-kicker">RESTORE · 先校验，再确认</div>
            <p>
              这份包{pending.from ? "来自" + pending.from + "，" : ""}有会话 {pending.stats.sessions}、记忆{" "}
              {pending.stats.memories}、表情 {pending.stats.stickers}
              {(pending.stats.broadcast ?? 0) > 0 ? "、播报 " + pending.stats.broadcast + " 期" : ""}
              {pending.coin ? "、黑塔币钱包" : ""}，共 {formatSize(pending.stats.bytes)}。
              导入不会覆盖已有的东西，重复的会跳过；本机已有黑塔币钱包时不覆盖钱包。
            </p>
            <button type="button" className="ss-btn ss-btnInk ss-btnWide" onClick={() => void confirmRestore()} disabled={busy}>
              {busy ? "导入中…" : "确认导入"}
            </button>
          </section>
        )}

        {note && (
          <section className="ss-card ss-cardPad">
            <p className="ss-note">{note}</p>
          </section>
        )}

        <p className="ss-hint">
          提示：包里有图片时文件会比较大。微信发文件别用「图片」，用「文件」发，否则会被压缩。
        </p>
      </div>
    </div>
  );
}
