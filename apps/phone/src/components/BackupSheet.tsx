import { useCallback, useEffect, useState } from "react";
import { buildBackupBundle, formatSize, type BackupStats, type RestoreMode } from "@herta/core";
import type { Session } from "@herta/protocol";
import type { Settings } from "../settings.ts";
import { listSessions, listStickers, loadSession } from "../storage.ts";
import { IdbMemoryStore } from "../memory-idb.ts";
import { loadCoinWallet } from "../coin/coin-storage.ts";
import { listCoinKeyNames } from "../coin/userkey.ts";
import { listBroadcastIssues } from "../broadcast/storage.ts";
import {
  backupFilename,
  buildLocalBackup,
  makeSafetyBackup,
  readBackup,
  restoreLocalBackup,
  saveBackup,
  shareBackup,
  type RestoreReport,
} from "../backup.ts";
import { loadReadableFiles } from "../readable-files.ts";
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
 * 三处刻意的取舍：
 *   - **不带 API Key**（设置里可以选带设置，Key 也会被剔掉）：那是你的凭据，不属于她；
 *   - **合并**在先：同一份包导两次不会变成两份（会话 id / 记忆文件名 / 表情 id / 文件按名）；
 *   - **覆盖**是唯一会把家弄丢的路：所以点确认之前，先把当前状态强制存一份
 *     （herta-safety-*.json），丢的那份还能找回。
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
  const [counts, setCounts] = useState({ sessions: 0, memories: 0, stickers: 0, broadcast: 0, files: 0, wallet: false, keys: 0 });
  const [withStickers, setWithStickers] = useState(true);
  const [withSettings, setWithSettings] = useState(false);
  const [withFiles, setWithFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [lastStats, setLastStats] = useState<BackupStats | null>(null);
  const [lastAt, setLastAt] = useState<Date | null>(null);
  const [pending, setPending] = useState<{
    text: string;
    stats: BackupStats;
    from?: string;
    coin: boolean;
    files: number;
    hasNms: boolean;
  } | null>(null);
  /** 恢复策略：默认合并，覆盖要用户自己点过去。 */
  const [mode, setMode] = useState<RestoreMode>("merge");
  /** 恢复完那张报告；有它才渲染报告卡。 */
  const [report, setReport] = useState<RestoreReport | null>(null);
  /** 自动存的那份当前状态的落点。 */
  const [safety, setSafety] = useState<string | null>(null);

  const loadCounts = useCallback(async () => {
    const [metas, memories, stickers, wallet, broadcast, files] = await Promise.all([
      listSessions(),
      new IdbMemoryStore().list(),
      listStickers(),
      loadCoinWallet(),
      listBroadcastIssues(),
      loadReadableFiles(),
    ]);
    setCounts({
      sessions: metas.length,
      memories: memories.length,
      stickers: stickers.length,
      broadcast: broadcast.length,
      files: files.length,
      wallet: wallet !== null,
      // 黑塔币的用户密钥：打包时默认带上，这里只是如实显示有几把
      keys: listCoinKeyNames().length,
    });
  }, []);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  const pack = async () => {
    setBusy(true);
    setNote(null);
    try {
      const backup = await buildLocalBackup(settings, { withStickers, withSettings, withFiles });
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
        files: parsed.bundle.files?.length ?? 0,
        hasNms: parsed.bundle.nms !== undefined,
      });
      setReport(null);
      setSafety(null);
    } catch (e) {
      setNote("读不了这个文件：" + (e instanceof Error ? e.message : String(e)));
    }
  };

  /**
   * 三步走：先给当前状态存一份 → 再按选定的策略写 → 最后给一张报告。
   *
   * 顺序不能反：备份失败就不恢复。这是整套流程里唯一「点错会把家弄丢」的地方。
   */
  const confirmRestore = async () => {
    if (!pending) return;
    setBusy(true);
    setNote(null);
    setReport(null);
    setSafety(null);
    try {
      setNote("先把当前状态存一份…");
      const safe = await makeSafetyBackup(settings);
      setSafety(safe.where);

      setNote("正在导入…");
      const out = await restoreLocalBackup(pending.text, mode);
      setReport(out);
      setPending(null);
      await loadCounts();
      onRestored();
    } catch (e) {
      setNote("导入失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const walletLine = !report
    ? ""
    : report.wallet === "written"
      ? "黑塔币钱包已写入。"
      : report.wallet === "kept"
        ? "本机已有钱包，没动它。"
        : "包里没有钱包。";

  const nmsLine = !report
    ? ""
    : report.nms.wrote
      ? " 记忆网络：写进 " + report.nms.nodes + " 个节点、" + report.nms.edges + " 条连接。"
      : report.nms.reason === "not_in_bundle"
        ? " 记忆网络：这个包没带快照，她的记忆网络没动。"
        : report.nms.reason === "occupied"
          ? " 记忆网络：本机已有记忆，合并时不覆盖（要换就选覆盖本机）。"
          : report.nms.reason === "not_native"
            ? " 记忆网络：不在真机上，没动。"
            : " 记忆网络：这份快照用不了，没动。";

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
            <span>7 项</span>
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
            <span>文件</span>
            <b>{withFiles ? counts.files + " 份" : "不带"}</b>
            <small>{withFiles ? "她能读的那些" : "按选项跳过"}</small>
          </div>
          <div className="bk-manifestRow">
            <span>钱包</span>
            <b>{counts.wallet ? "有" : "无"}</b>
            <small>合并时不覆盖</small>
          </div>
          <div className="bk-manifestRow">
            <span>密钥</span>
            <b>{counts.keys > 0 ? counts.keys + " 把" : "无"}</b>
            <small>{counts.keys > 0 ? "默认带上，等于账号" : "还没进过共享市场"}</small>
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
            <span>3 项</span>
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
          <label className="ss-row">
            <span className="ss-rowMain">
              <b>带上她能读的文件</b>
              <small>
                你塞给她的那些文本（{counts.files} 份）。不带的话，换台手机她会记得「放过这份文件」，却打不开它。
              </small>
            </span>
            <input
              type="checkbox"
              className="ss-switch"
              checked={withFiles}
              onChange={(e) => setWithFiles(e.target.checked)}
            />
          </label>
        </section>

        <section className="ss-card ss-cardPad">
          <div className="ss-groupHead bk-restoreHead">
            <span>从另一台手机导进来</span>
            <span>先备份，再选怎么进</span>
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
              {pending.files > 0 ? "、文件 " + pending.files + " 份" : ""}
              {pending.hasNms ? "、记忆网络快照" : ""}
              {pending.coin ? "、黑塔币钱包" : ""}，共 {formatSize(pending.stats.bytes)}。
            </p>
            <div className="bk-mode" role="radiogroup" aria-label="恢复方式">
              <button
                type="button"
                className={"bk-modeBtn" + (mode === "merge" ? " on" : "")}
                role="radio"
                aria-checked={mode === "merge"}
                onClick={() => setMode("merge")}
              >
                <b>合并进来</b>
                <small>本机已有的跳过，重复的不会变两份</small>
              </button>
              <button
                type="button"
                className={"bk-modeBtn danger" + (mode === "overwrite" ? " on" : "")}
                role="radio"
                aria-checked={mode === "overwrite"}
                onClick={() => setMode("overwrite")}
              >
                <b>覆盖本机</b>
                <small>换成包里那一份；点确认前会先自动存一份当前状态</small>
              </button>
            </div>
            <p className="ss-note" data-part="restore-mode-note">
              {mode === "overwrite"
                ? "覆盖会把本机的会话、记忆、表情、文件换成包里的那份" +
                  (pending.hasNms ? "，记忆网络也会整个换掉" : "") +
                  "。动手之前会先存一份 herta-safety-*.json，丢的那份还能从那里找回。"
                : "合并只往里加，不会删你本机任何东西；重复的会跳过。"}
            </p>
            {safety && <p className="ss-note">当前状态已存：{safety}</p>}
            <button type="button" className="ss-btn ss-btnInk ss-btnWide" onClick={() => void confirmRestore()} disabled={busy}>
              {busy ? (mode === "overwrite" ? "备份并覆盖中…" : "导入中…") : mode === "overwrite" ? "确认覆盖导入" : "确认导入"}
            </button>
          </section>
        )}

        {report && (
          <section className="ss-card ss-cardPad" data-part="restore-report">
            <div className="ss-kicker">REPORT · 这次搬过来多少</div>
            <div className="bk-report">
              {[
                ["会话", report.wrote.sessions, report.overwritten.sessions, report.skipped.sessions, "条"],
                ["记忆", report.wrote.memories, report.overwritten.memories, report.skipped.memories, "篇"],
                ["表情", report.wrote.stickers, report.overwritten.stickers, report.skipped.stickers, "张"],
                ["播报", report.wrote.broadcast, report.overwritten.broadcast, report.skipped.broadcast, "期"],
                ["文件", report.wrote.files, report.overwritten.files, report.skipped.files, "份"],
              ].map(([label, wrote, over, skip, unit]) => (
                <div className="bk-reportRow" key={String(label)}>
                  <span>{label}</span>
                  <b>
                    {wrote} {unit}
                  </b>
                  <small>
                    {Number(over) > 0 ? "覆盖 " + over : ""}
                    {Number(over) > 0 && Number(skip) > 0 ? " · " : ""}
                    {Number(skip) > 0 ? "跳过 " + skip : ""}
                    {Number(over) === 0 && Number(skip) === 0 ? "全新" : ""}
                  </small>
                </div>
              ))}
            </div>
            <p className="ss-note">
              {walletLine}
              {nmsLine}
            </p>
            <p className="ss-note">
              方式：{report.mode === "overwrite" ? "覆盖本机" : "合并进来"}。{report.from ? "来自 " + report.from + "。" : ""}
              包大小 {formatSize(report.stats.bytes)}。
            </p>
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
