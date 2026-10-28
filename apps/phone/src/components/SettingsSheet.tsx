import { CHEAP_LIMITS } from "@herta/core";
import type { Settings } from "../settings.ts";
import type { StickerRecord } from "../storage.ts";

/** 设置面板。全部是本机状态，没有一处上传。 */
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
}) {
  const capCount = [
    settings.statusEnabled,
    settings.remindersEnabled,
    settings.calendarEnabled,
    settings.openEnabled,
    settings.shareEnabled,
    settings.proactiveEnabled,
  ].filter(Boolean).length;
  return (
    <div className="sheet">
      <div className="sheetHead">
        <span>设置</span>
        <button type="button" className="sheetClose" onClick={onClose} aria-label="关闭设置">
          ✕
        </button>
      </div>
      <button type="button" className="sheetLink" onClick={onOpenCapabilities}>
        <span>她能做什么</span>
        <span className="sheetLinkHint">{capCount > 0 ? capCount + " 项开着" : "全关着"} ›</span>
      </button>
      <button type="button" className="sheetLink" onClick={onOpenToolLog}>
        <span>工具调用记录</span>
        <span className="sheetLinkHint">她动过什么手 ›</span>
      </button>
      <label>
        API Key
        <input
          type="password"
          value={settings.apiKey}
          onChange={(e) => onChange({ apiKey: e.target.value.trim() })}
          placeholder="sk-..."
        />
      </label>
      <label>
        Base URL
        <input value={settings.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value.trim() })} />
      </label>
      <label>
        模型（deepseek-flash 能看图；deepseek-v4-pro 只能读字）
        <input value={settings.model} onChange={(e) => onChange({ model: e.target.value.trim() })} />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.cheapMode}
          onChange={(e) => onChange({ cheapMode: e.target.checked })}
        />
        <span>
          省 token 模式：不判心情、不复核；历史 ≤ {CHEAP_LIMITS.contextBlocks} 块、记忆 ≤{" "}
          {CHEAP_LIMITS.memorySeeds} 篇、长图 ≤ {CHEAP_LIMITS.imagePieces} 段、工具 ≤ {CHEAP_LIMITS.toolRounds} 轮
        </span>
      </label>
      {settings.cheapMode && (
        <p className="memNote">
          每轮少两次请求（判心情、复核），上下文与长图也压小了。代价：她更容易跑题、记性更短，复核也拦不住她吹牛。
        </p>
      )}
      <label>
        带多少块历史{settings.cheapMode ? "（省 token 下按 " + CHEAP_LIMITS.contextBlocks + " 算）" : ""}
        <input
          type="number"
          disabled={settings.cheapMode}
          value={settings.contextBlocks}
          onChange={(e) => onChange({ contextBlocks: Number(e.target.value) || 24 })}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          disabled={settings.cheapMode}
          checked={settings.moodEnabled}
          onChange={(e) => onChange({ moodEnabled: e.target.checked })}
        />
        <span>每轮先判心情（现在是：{mood}）{settings.cheapMode ? "——省 token 下不判" : ""}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.autoDream} onChange={(e) => onChange({ autoDream: e.target.checked })} />
        <span>我走开之后她自己做梦（关掉就只有手动按钮）</span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.replyPacing}
          onChange={(e) => onChange({ replyPacing: e.target.checked })}
        />
        <span>她会看时机回话（有时不接、有时慢半拍；聊得越久回得越快）</span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          disabled={settings.cheapMode}
          checked={settings.reviewEnabled}
          onChange={(e) => onChange({ reviewEnabled: e.target.checked })}
        />
        <span>说完先让她自己复核（关掉每轮省一次调用）{settings.cheapMode ? "——省 token 下不复核" : ""}</span>
      </label>
      <label>
        视觉模型（可选：主模型不收图时用来描述；翻相册也靠它）
        <input
          value={settings.visionModel}
          onChange={(e) => onChange({ visionModel: e.target.value.trim() })}
          placeholder="例如 deepseek-vl 或你服务商的多模态模型名"
        />
      </label>
      <label>
        给她读的文件
        <input
          type="file"
          accept=".txt,.md,.json,.csv,.log,text/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
          }}
        />
      </label>
      <p className="memNote">
        {fileNames.length > 0 ? "她能读：" + fileNames.join("、") : "还没给她文件。只能读你在这里选的，不能自己翻手机。"}
      </p>
      <label className="check">
        <input type="checkbox" checked={settings.albumEnabled} onChange={(e) => onChange({ albumEnabled: e.target.checked })} />
        <span>允许她翻我的相册（要配视觉模型才会真看）</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.ttsEnabled} onChange={(e) => onChange({ ttsEnabled: e.target.checked })} />
        <span>用云端语音念出来（不然只能播那 41 条录音）</span>
      </label>
      {settings.ttsEnabled && (
        <>
          <label>
            语音接口
            <select
              value={settings.ttsProvider}
              onChange={(e) => onChange({ ttsProvider: e.target.value as Settings["ttsProvider"] })}
            >
              <option value="openai">OpenAI 兼容（/audio/speech）</option>
              <option value="minimax">MiniMax（/t2a_v2）</option>
            </select>
          </label>
          <label>
            语音 Key
            <input
              type="password"
              value={settings.ttsApiKey}
              onChange={(e) => onChange({ ttsApiKey: e.target.value.trim() })}
              placeholder="sk-..."
            />
          </label>
          <label>
            语音 Base URL
            <input value={settings.ttsBaseUrl} onChange={(e) => onChange({ ttsBaseUrl: e.target.value.trim() })} />
          </label>
          <label>
            语音模型
            <input value={settings.ttsModel} onChange={(e) => onChange({ ttsModel: e.target.value.trim() })} />
          </label>
          <label>
            音色 ID
            <input value={settings.ttsVoice} onChange={(e) => onChange({ ttsVoice: e.target.value.trim() })} />
          </label>
          {settings.ttsProvider === "minimax" && (
            <label>
              GroupId
              <input value={settings.ttsGroupId} onChange={(e) => onChange({ ttsGroupId: e.target.value.trim() })} />
            </label>
          )}
        </>
      )}
      <label>
        她的表情包（{stickers.length} 张）
        <input
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
        <p className="memNote">她还没有表情包。加几张，她就会在合适的时候自己挑一张发出来。</p>
      )}
    </div>
  );
}