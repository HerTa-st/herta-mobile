import { useState } from "react";
import type { Settings } from "../settings.ts";
import { ensureNotificationPermission } from "../capabilities.ts";
import { openAppSettings } from "../keepalive.ts";

/**
 * 第一次打开时的四步。
 *
 * 为什么要有这一页：朋友装上之后看到的是一个空白聊天页，而"她还藏着七种能力"
 * 这件事只有翻设置的人才知道。引导不是教程，只把这四件必须由用户做的事排在一屏里：
 * 填 Key、挑能力、给通知权限、加电池白名单。
 *
 * 全部可以跳过——这一页不拦人，跳过之后再从设置里补。
 */
export function Onboarding({
  settings,
  onChange,
  onOpenCapabilities,
  onDone,
}: {
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
  onOpenCapabilities(): void;
  onDone(): void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const askNotify = async () => {
    setAsking(true);
    try {
      await ensureNotificationPermission();
      setNote("给了。到点她就能喊你了。");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="sheet onboarding">
      <div className="sheetHead">
        <span>先把她安顿好</span>
        <button type="button" className="sheetClose" onClick={onDone} aria-label="跳过">
          ✕
        </button>
      </div>
      <p className="memNote">四件事，两分钟。都能跳过，之后再从设置里补。</p>

      <h3 className="capGroup">1 · 她的 Key</h3>
      <label>
        API Key
        <input
          type="password"
          value={settings.apiKey}
          onChange={(e) => onChange({ apiKey: e.target.value.trim() })}
          placeholder="sk-..."
        />
      </label>
      <p className="memNote">用你自己的额度。只存在这台手机上，不上传，也不进日志。</p>

      <h3 className="capGroup">2 · 她能做什么</h3>
      <button type="button" className="sheetLink" onClick={onOpenCapabilities}>
        <span>挑几件让她做</span>
        <span className="sheetLinkHint">默认全关 ›</span>
      </button>

      <h3 className="capGroup">3 · 到点能喊你</h3>
      <button type="button" className="onboardBtn" onClick={() => void askNotify()} disabled={asking}>
        {asking ? "等系统弹窗…" : "允许通知"}
      </button>

      <h3 className="capGroup">4 · 别让她被系统杀掉</h3>
      <p className="memNote">国产系统会清后台。打开本应用的系统设置 → 电池 → 选「不受限制」，她才能在你不打开 App 的时候也醒着。</p>
      <button
        type="button"
        className="onboardBtn"
        onClick={() =>
          void openAppSettings().then((ok) =>
            setNote(ok ? "去「电池」里改成不受限制再回来。" : "浏览器里打不开系统设置——真机上才有。")
          )
        }
      >
        打开系统设置
      </button>

      {note && <p className="memNote">{note}</p>}

      <button type="button" className="onboardDone" onClick={onDone}>
        开始
      </button>
    </div>
  );
}
