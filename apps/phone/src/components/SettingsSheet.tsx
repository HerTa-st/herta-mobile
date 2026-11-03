import { CHEAP_LIMITS, DOC_FILE_EXTENSIONS, TEXT_FILE_EXTENSIONS } from "@herta/core";
import type { Settings } from "../settings.ts";
import type { StickerRecord } from "../storage.ts";
import "../styles/settings-suite.css";

/** 她能做什么 / 工具 / 备份 三个入口都算「开着」的几项；只用于快捷入口上的计数。 */
const CAP_KEYS = [
  "statusEnabled",
  "notifyEnabled",
  "mediaEnabled",
  "locationEnabled",
  "remindersEnabled",
  "calendarEnabled",
  "openEnabled",
  "shareEnabled",
  "cameraEnabled",
  "a11yEnabled",
  "proactiveEnabled",
] as const;

const ICON = {
  back: "M15 6l-6 6 6 6",
  close: "M6 6l12 12M18 6L6 18",
  chevron: "M9 6l6 6-6 6",
  caps: "M12 3l7 3v5c0 4.5-2.8 7.8-7 10-4.2-2.2-7-5.5-7-10V6zM9 12l2 2 4-4",
  tools: "M4 6h7l4 6h5M4 18h7l2-3",
  backup: "M4 7l8-3 8 3v10l-8 3-8-3zM4 7l8 3 8-3M12 10v10",
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

/** 设置面板：prototype A 的整页分组卡面。全部是本机状态，没有一处上传。 */
export function SettingsSheet({
  settings,
  onChange,
  onClose,
  mood,
  fileNames,
  onFile,
  stickers,
  onAddStickers,
  onRemoveSticker,
  onOpenCapabilities,
  onOpenToolLog,
  onOpenBackup,
}: {
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
  onClose(): void;
  mood: string;
  fileNames: string[];
  onFile(file: File): void;
  stickers: StickerRecord[];
  onAddStickers(files: File[]): void;
  onRemoveSticker(id: string): void;
  onOpenCapabilities(): void;
  onOpenToolLog(): void;
  onOpenBackup(): void;
}) {
  const capCount = CAP_KEYS.filter((key) => settings[key]).length;
  const capHint = capCount > 0 ? capCount + " 项开着" : "全关着";

  return (
    <div className="ss-page" role="dialog" aria-label="设置">
      <header className="ss-top">
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="返回">
          <Icon d={ICON.back} size={18} />
        </button>
        <div className="ss-title">
          <b>设置</b>
          <span>本机 · 不上传</span>
        </div>
        <span className="ss-badge">
          <i />
          {mood || "平静"}
        </span>
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="关闭设置">
          <Icon d={ICON.close} size={16} />
        </button>
      </header>

      <div className="ss-body">
        <section className="ss-card ss-profileCard">
          <img className="ss-avatar" src="/herta.png" alt="黑塔" />
          <div className="ss-profileMain">
            <b>黑塔</b>
            <span>herta · 单人格 · 单记忆分区</span>
          </div>
          <span className="ss-badge">
            <i />
            本机
          </span>
        </section>

        <div className="ss-shortcuts">
          <button type="button" className="ss-shortcut" onClick={onOpenCapabilities}>
            <Icon d={ICON.caps} size={16} />
            <b>她能做什么</b>
            <small>{capHint}</small>
          </button>
          <button type="button" className="ss-shortcut" onClick={onOpenToolLog}>
            <Icon d={ICON.tools} size={16} />
            <b>工具调用</b>
            <small>她动过什么手</small>
          </button>
          <button type="button" className="ss-shortcut" onClick={onOpenBackup}>
            <Icon d={ICON.backup} size={16} />
            <b>备份迁移</b>
            <small>打包换机</small>
          </button>
        </div>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>外观</span>
            <span>theme</span>
          </div>
          <div className="ss-appearance">
            <div className="ss-rowMain">
              <b>主题</b>
              <small>
                夜间 = 轨道控制台（C）的深空底 / 青色信号；只换 token，不换布局。开屏的 ASCII
                白底保持不动。
              </small>
            </div>
            <div className="ss-seg" role="group" aria-label="外观">
              {(["system", "light", "dark"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={settings.theme === t ? "on" : ""}
                  aria-pressed={settings.theme === t}
                  onClick={() => onChange({ theme: t })}
                >
                  {t === "system" ? "跟随系统" : t === "light" ? "日间" : "夜间"}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>连接</span>
            <span>6 项</span>
          </div>
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>API Key</b>
              <small>只存本机；备份包不带</small>
            </span>
            <input
              className="ss-input"
              type="password"
              value={settings.apiKey}
              onChange={(e) => onChange({ apiKey: e.target.value.trim() })}
              placeholder="sk-..."
              autoComplete="off"
            />
          </label>
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>Base URL</b>
              <small>模型请求发往哪里</small>
            </span>
            <input
              className="ss-input"
              value={settings.baseUrl}
              onChange={(e) => onChange({ baseUrl: e.target.value.trim() })}
            />
          </label>
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>模型</b>
              <small>deepseek-flash 能看图；deepseek-v4-pro 只能读字</small>
            </span>
            <input
              className="ss-input"
              value={settings.model}
              onChange={(e) => onChange({ model: e.target.value.trim() })}
            />
          </label>
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>视觉模型（可选）</b>
              <small>主模型不收图时用来描述；翻相册也靠它</small>
            </span>
            <input
              className="ss-input"
              value={settings.visionModel}
              onChange={(e) => onChange({ visionModel: e.target.value.trim() })}
              placeholder="例如 deepseek-vl 或你服务商的多模态模型名"
            />
          </label>
          <label className="ss-row">
            <span className="ss-rowMain">
              <b>省 token 模式</b>
              <small>
                不判心情、不复核；历史 ≤ {CHEAP_LIMITS.contextBlocks} 块、记忆 ≤{" "}
                {CHEAP_LIMITS.memorySeeds} 篇、长图 ≤ {CHEAP_LIMITS.imagePieces} 段、工具 ≤{" "}
                {CHEAP_LIMITS.toolRounds} 轮
              </small>
            </span>
            <input
              type="checkbox"
              className="ss-switch"
              checked={settings.cheapMode}
              onChange={(e) => onChange({ cheapMode: e.target.checked })}
            />
          </label>
          {settings.cheapMode && (
            <p className="ss-note">
              每轮少两次请求（判心情、复核），上下文与长图也压小了。代价：她更容易跑题、记性更短，复核也拦不住她吹牛。
            </p>
          )}
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>带多少块历史</b>
              <small>{settings.cheapMode ? "省 token 下按 " + CHEAP_LIMITS.contextBlocks + " 算" : "每轮带进上下文的历史块数"}</small>
            </span>
            <input
              className="ss-input"
              type="number"
              disabled={settings.cheapMode}
              value={settings.contextBlocks}
              onChange={(e) => onChange({ contextBlocks: Number(e.target.value) || 24 })}
            />
          </label>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>她</span>
            <span>6 项</span>
          </div>
          <label className="ss-row">
            <span className="ss-rowMain">
              <b>判心情</b>
              <small>
                每轮先判一次（现在是：{mood}）{settings.cheapMode ? "——省 token 下不判" : ""}
              </small>
            </span>
            <input
              type="checkbox"
              className="ss-switch"
              disabled={settings.cheapMode}
              checked={settings.moodEnabled}
              onChange={(e) => onChange({ moodEnabled: e.target.checked })}
            />
          </label>
          <label className="ss-row">
            <span className="ss-rowMain">
              <b>说完先让她自己复核</b>
              <small>
                关掉每轮省一次调用{settings.cheapMode ? "——省 token 下不复核" : ""}
              </small>
            </span>
            <input
              type="checkbox"
              className="ss-switch"
              disabled={settings.cheapMode}
              checked={settings.reviewEnabled}
              onChange={(e) => onChange({ reviewEnabled: e.target.checked })}
            />
          </label>
          <label className="ss-row">
            <span className="ss-rowMain">
              <b>她会看时机回话</b>
              <small>有时不接、有时慢半拍；聊得越久回得越快</small>
            </span>
            <input
              type="checkbox"
              className="ss-switch"
              checked={settings.replyPacing}
              onChange={(e) => onChange({ replyPacing: e.target.checked })}
            />
          </label>
          <label className="ss-row">
            <span className="ss-rowMain">
              <b>我走开之后她自己做梦</b>
              <small>关掉就只有手动按钮</small>
            </span>
            <input
              type="checkbox"
              className="ss-switch"
              checked={settings.autoDream}
              onChange={(e) => onChange({ autoDream: e.target.checked })}
            />
          </label>
          <label className="ss-row">
            <span className="ss-rowMain">
              <b>NMS 深睡</b>
              <small>有网 + API Key 时，空闲后整理情景为语义；每晚会调模型</small>
            </span>
            <input
              type="checkbox"
              className="ss-switch"
              checked={settings.nmsDeepSleepEnabled}
              onChange={(e) => onChange({ nmsDeepSleepEnabled: e.target.checked })}
            />
          </label>
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>深睡每晚调用上限</b>
              <small>0 = 关，默认 8</small>
            </span>
            <input
              className="ss-input"
              type="number"
              disabled={!settings.nmsDeepSleepEnabled}
              min={0}
              max={40}
              value={settings.nmsNightCap}
              onChange={(e) => onChange({ nmsNightCap: Math.max(0, Math.min(40, Number(e.target.value) || 0)) })}
            />
          </label>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>模块</span>
            <span>5 项</span>
          </div>
          <label className="ss-row">
            <span className="ss-rowMain">
              <b>允许她翻我的相册</b>
              <small>要配视觉模型才会真看</small>
            </span>
            <input
              type="checkbox"
              className="ss-switch"
              checked={settings.albumEnabled}
              onChange={(e) => onChange({ albumEnabled: e.target.checked })}
            />
          </label>
          <label className="ss-row">
            <span className="ss-rowMain">
              <b>用云端语音念出来</b>
              <small>不然只能播那 41 条录音</small>
            </span>
            <input
              type="checkbox"
              className="ss-switch"
              checked={settings.ttsEnabled}
              onChange={(e) => onChange({ ttsEnabled: e.target.checked })}
            />
          </label>
          {settings.ttsEnabled && (
            <div className="ss-sub">
              <label className="ss-subField">
                语音接口
                <select
                  className="ss-select"
                  value={settings.ttsProvider}
                  onChange={(e) => onChange({ ttsProvider: e.target.value as Settings["ttsProvider"] })}
                >
                  <option value="openai">OpenAI 兼容（/audio/speech）</option>
                  <option value="minimax">MiniMax（/t2a_v2）</option>
                </select>
              </label>
              <label className="ss-subField">
                语音 Key
                <input
                  className="ss-input"
                  type="password"
                  value={settings.ttsApiKey}
                  onChange={(e) => onChange({ ttsApiKey: e.target.value.trim() })}
                  placeholder="sk-..."
                  autoComplete="off"
                />
              </label>
              <label className="ss-subField">
                语音 Base URL
                <input
                  className="ss-input"
                  value={settings.ttsBaseUrl}
                  onChange={(e) => onChange({ ttsBaseUrl: e.target.value.trim() })}
                />
              </label>
              <label className="ss-subField">
                语音模型
                <input
                  className="ss-input"
                  value={settings.ttsModel}
                  onChange={(e) => onChange({ ttsModel: e.target.value.trim() })}
                />
              </label>
              <label className="ss-subField">
                音色 ID
                <input
                  className="ss-input"
                  value={settings.ttsVoice}
                  onChange={(e) => onChange({ ttsVoice: e.target.value.trim() })}
                />
              </label>
              {settings.ttsProvider === "minimax" && (
                <label className="ss-subField">
                  GroupId
                  <input
                    className="ss-input"
                    value={settings.ttsGroupId}
                    onChange={(e) => onChange({ ttsGroupId: e.target.value.trim() })}
                  />
                </label>
              )}
            </div>
          )}
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>给她读的文件</b>
              <small>文本 / PDF / Word / Excel / PPT</small>
            </span>
            <input
              className="ss-file"
              type="file"
              accept={
                TEXT_FILE_EXTENSIONS.map((ext) => "." + ext)
                  .concat(DOC_FILE_EXTENSIONS.map((ext) => "." + ext))
                  .join(",") + ",text/*"
              }
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onFile(file);
              }}
            />
          </label>
          <p className="ss-note">
            {fileNames.length > 0
              ? "她能读：" + fileNames.join("、")
              : "还没给她文件。回形针的「选文件」也可以加；她只能读你选的，不能自己翻手机。"}
          </p>
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>她的表情包（{stickers.length} 张）</b>
              <small>加几张，她就会在合适的时候自己挑一张发出来</small>
            </span>
            <input
              className="ss-file"
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                // 必须先取快照：把 value 清空会把 e.target.files 一起清掉，
                // 于是"选了图但没加进去"——上一版就栽在这。
                const picked = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (picked.length > 0) onAddStickers(picked);
              }}
            />
          </label>
          {stickers.length > 0 ? (
            <div className="stickerGrid">
              {stickers.map((s) => (
                <div key={s.id} className="stickerCell">
                  <img src={s.data} alt={s.name} />
                  <button onClick={() => onRemoveSticker(s.id)} aria-label="删掉">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="ss-note">她还没有表情包。加几张，她就会在合适的时候自己挑一张发出来。</p>
          )}
          <label className="ss-rowStack">
            <span className="ss-rowMain">
              <b>黑塔币接口地址</b>
              <small>留空 = 打包时注入；改这里不用重打 APK</small>
            </span>
            <input
              className="ss-input"
              value={settings.coinApiBase}
              onChange={(e) => onChange({ coinApiBase: e.target.value.trim() })}
              placeholder="https://你的域名，例如 https://htc.example.com"
            />
          </label>
        </section>

        <section className="ss-card">
          <div className="ss-groupHead">
            <span>数据</span>
            <span>本机</span>
          </div>
          <button type="button" className="ss-row ss-rowTap" onClick={onOpenToolLog}>
            <span className="ss-rowMain">
              <b>工具调用记录</b>
              <small>她动过什么手：参数、结果、失败在哪一步</small>
            </span>
            <span className="ss-rowValue">
              <Icon d={ICON.chevron} size={13} />
            </span>
          </button>
          <button type="button" className="ss-row ss-rowTap" onClick={onOpenBackup}>
            <span className="ss-rowMain">
              <b>备份与迁移</b>
              <small>打包随身、换机带走；API Key 不进包</small>
            </span>
            <span className="ss-rowValue">
              <Icon d={ICON.chevron} size={13} />
            </span>
          </button>
          <div className="ss-row">
            <span className="ss-rowMain">
              <b>本机数据</b>
              <small>{fileNames.length} 个文件 · {stickers.length} 张表情 · 全部只留在这台手机</small>
            </span>
          </div>
        </section>

        <p className="ss-hint">全部本机状态，没有一处上传。API Key 不进备份包。</p>
      </div>
    </div>
  );
}
