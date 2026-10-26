import type { Settings } from "../settings.ts";

/** 设置面板。全部是本机状态，没有一处上传。 */
export function SettingsSheet({
  settings,
  onChange,
  mood,
  fileNames,
  onFile,
}: {
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
  mood: string;
  fileNames: string[];
  onFile(file: File): void;
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
        <input
          type="checkbox"
          checked={settings.reviewEnabled}
          onChange={(e) => onChange({ reviewEnabled: e.target.checked })}
        />
        <span>说完先让她自己复核（关掉每轮省一次调用）</span>
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
    </div>
  );
}
