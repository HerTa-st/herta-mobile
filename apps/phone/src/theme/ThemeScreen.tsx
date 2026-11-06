import { useRef, useState } from "react";
import "../styles/settings-suite.css";
import "./theme-screen.css";
import type { InstalledThemeMeta } from "./store.ts";

/**
 * 主题包管理页：装 / 换 / 卸。
 *
 * 只做三件事。主题包本身只读，不在这一页预览 DOM；装完立刻应用，
 * 所以「装完是什么样」就是整站的样子。
 */
export function ThemeScreen({
  version,
  activeId,
  themes,
  busy,
  note,
  onInstallFile,
  onInstallUrl,
  onActivate,
  onUninstall,
  onClose,
}: {
  version: string;
  activeId: string;
  themes: InstalledThemeMeta[];
  busy: boolean;
  note: string | null;
  onInstallFile(file: File): void;
  onInstallUrl(url: string): void;
  onActivate(id: string | null): void;
  onUninstall(id: string): void;
  onClose(): void;
}) {
  const [url, setUrl] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const active = themes.find((theme) => theme.id === activeId) ?? null;

  return (
    <div className="ss-page themeScreen" data-part="panel" role="dialog" aria-label="主题包">
      <header className="ss-top">
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="返回">
          ‹
        </button>
        <div className="ss-title">
          <b>主题包</b>
          <span>装 / 换 / 卸 · 只接受 CSS</span>
        </div>
        <span className="ss-badge">
          <i />
          v{version}
        </span>
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="关闭主题包">
          ✕
        </button>
      </header>

      <div className="ss-body">
        {note && (
          <p className="themeNote" role="status">
            {note}
          </p>
        )}

        <section className="ss-card">
          <div className="themeCurrent">
            <span className="themeSwatch" aria-hidden="true" />
            <span className="ss-rowMain">
              <b>{active ? active.name : "内置主题"}</b>
              <small>
                {active
                  ? (active.author || "匿名作者") + " · v" + active.version + " · 需要 App " + active.minAppVersion + " 以上"
                  : "随 App 一起，不可卸载；切回它不会留任何主题样式"}
              </small>
            </span>
            {busy && <span className="themeBusy">处理中…</span>}
          </div>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>安装</span>
            <span>zip</span>
          </div>
          <div className="themeInstallRow">
            <input
              className="ss-input"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…/paper.zip"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="ss-btn ss-btnSmall"
              disabled={busy || !url.trim()}
              onClick={() => onInstallUrl(url)}
            >
              从链接装
            </button>
          </div>
          <div className="themeInstallRow">
            <span className="ss-note themeInstallHint">或者从这台手机选一个 zip。</span>
            <button
              type="button"
              className="ss-btn ss-btnGhost ss-btnSmall"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              选 zip 文件
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) onInstallFile(file);
              }}
            />
          </div>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>已安装</span>
            <span>{themes.length} 个</span>
          </div>

          <button type="button" className="ss-row ss-rowTap" onClick={() => onActivate(null)} disabled={busy}>
            <span className="ss-rowMain">
              <b>内置主题</b>
              <small>随包样式 · 卸掉所有主题后回到这里</small>
            </span>
            <span className="ss-rowValue">{activeId ? "切换" : "使用中"}</span>
          </button>

          {themes.map((theme) => {
            const inUse = theme.id === activeId;
            return (
              <div className="ss-row themeRow" key={theme.id}>
                <span className="ss-rowMain">
                  <b>
                    {theme.name}
                    {inUse && <em className="themeInUse">使用中</em>}
                  </b>
                  <small>
                    {(theme.author || "匿名作者") + " · v" + theme.version + " · 需要 App " + theme.minAppVersion + " 以上"}
                  </small>
                  {theme.description && <small>{theme.description}</small>}
                </span>
                <span className="themeRowActions">
                  <button
                    type="button"
                    className="ss-btn ss-btnGhost ss-btnSmall"
                    disabled={busy || inUse}
                    onClick={() => onActivate(theme.id)}
                  >
                    切换
                  </button>
                  <button
                    type="button"
                    className="ss-btn ss-btnGhost ss-btnSmall"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm("卸载「" + theme.name + "」？主题包会从本机删除。")) onUninstall(theme.id);
                    }}
                  >
                    卸载
                  </button>
                </span>
              </div>
            );
          })}

          {themes.length === 0 && <p className="ss-note">还没装过主题。</p>}
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>包格式</span>
            <span>contract 1</span>
          </div>
          <p className="ss-note">
            zip 根目录直接放 skin.json 和 theme.css；可选 assets/（.woff2 / .png / .jpg / .webp / .svg，
            合计 ≤ 2 MB）。theme.css ≤ 256 KB，亮色与暗色两套都要写，不能有 @import、外链 url()、
            .js / .wasm。主题只改样式，不改结构、不执行代码。
          </p>
          <p className="ss-hint">
            用户亲手设的头像、聊天背景、日间夜间永远排在主题之后——主题盖不掉它们。
          </p>
        </section>
      </div>
    </div>
  );
}
