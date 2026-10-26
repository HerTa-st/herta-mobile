import type { Settings } from "../settings.ts";
import type { StickerRecord } from "../storage.ts";

/** 设置面板。全部是本机状态，没有一处上传。 */
export function SettingsSheet({
  settings,
  onChange,
  mood,
  fileNames,
  onFile,
  stickers,
  onAddStickers,
  onRemoveSticker,
}: {
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
  mood: string;
  fileNames: string[];
  onFile(file: File): void;
  stickers: StickerRecord[];
  onAddStickers(files: File[]): void;
  onRemoveSticker(id: string): void;
}) {
  return (
    <div className="sheet">
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
        模型
        <input value={settings.model} onChange={(e) => onChange({ model: e.target.value.trim() })} />
      </label>
      <label>
        带多少块历史
        <input
          type="number"
          value={settings.contextBlocks}
          onChange={(e) => onChange({ contextBlocks: Number(e.target.value) || 24 })}
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.moodEnabled} onChange={(e) => onChange({ moodEnabled: e.target.checked })} />
        <span>每轮先判心情（现在是：{mood}）</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.autoDream} onChange={(e) => onChange({ autoDream: e.target.checked })} />
        <span>我走开之后她自己做梦（关掉就只有手动按钮）</span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.reviewEnabled}
          onChange={(e) => onChange({ reviewEnabled: e.target.checked })}
        />
        <span>说完先让她自己复核（关掉每轮省一次调用）</span>
      </label>
      <label>
        视觉模型（看图用，留空则不识别）
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
