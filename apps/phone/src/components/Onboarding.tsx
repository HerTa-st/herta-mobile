import { useState } from "react";
import "../styles/onboarding.css";
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
    <div className="onboardA">
      <div className="onboardGlow" aria-hidden="true" />
      <div className="onboardInner">
        <div className="onboardMark" aria-hidden="true">H</div>
        <img className="onboardAvatar" src="/herta.png" alt="" />
        <h1>她在这里。</h1>
        <p className="onboardLede">五件事，两分钟。都能跳过，之后再从设置里补。</p>

        <div className="onboardCard">
          <section className="onboardStep">
            <span className="onboardNo">01</span>
            <div className="onboardStepBody">
              <h3>她怎么叫你</h3>
              <input
                type="text"
                value={settings.userName}
                maxLength={16}
                onChange={(e) => onChange({ userName: e.target.value.slice(0, 16) })}
                placeholder="开拓者（不填就用这个）"
                autoComplete="off"
              />
              <p>她会拿这个名字叫你；只存在这台手机上，想改就重看一遍引导。</p>
            </div>
          </section>

          <section className="onboardStep">
            <span className="onboardNo">02</span>
            <div className="onboardStepBody">
              <h3>她的 Key</h3>
              <input
                type="password"
                value={settings.apiKey}
                onChange={(e) => onChange({ apiKey: e.target.value.trim() })}
                placeholder="sk-..."
              />
              <p>用你自己的额度。只存在这台手机上，不上传，也不进日志。</p>
            </div>
          </section>

          <section className="onboardStep">
            <span className="onboardNo">03</span>
            <div className="onboardStepBody">
              <h3>她能做什么</h3>
              <button type="button" className="onboardRow" onClick={onOpenCapabilities}>
                <span>挑几件让她做</span>
                <span>默认全关 ›</span>
              </button>
            </div>
          </section>

          <section className="onboardStep">
            <span className="onboardNo">04</span>
            <div className="onboardStepBody">
              <h3>到点能喊你</h3>
              <button type="button" className="onboardRow" onClick={() => void askNotify()} disabled={asking}>
                <span>{asking ? "等系统弹窗…" : "允许通知"}</span>
                <span>到点提醒 ›</span>
              </button>
            </div>
          </section>

          <section className="onboardStep">
            <span className="onboardNo">05</span>
            <div className="onboardStepBody">
              <h3>别让她被系统杀掉</h3>
              <p>国产系统会清后台。系统设置 → 电池 → 选「不受限制」，她才能在你不打开 App 的时候也醒着。</p>
              <button
                type="button"
                className="onboardRow"
                onClick={() =>
                  void openAppSettings().then((ok) =>
                    setNote(ok ? "去「电池」里改成不受限制再回来。" : "浏览器里打不开系统设置——真机上才有。")
                  )
                }
              >
                <span>打开系统设置</span>
                <span>电池 ›</span>
              </button>
            </div>
          </section>
        </div>

        {note && <p className="onboardNote">{note}</p>}

        <button type="button" className="onboardStart" onClick={onDone}>
          开始
        </button>
        <button type="button" className="onboardSkip" onClick={onDone}>
          先跳过，之后在设置里补
        </button>
      </div>
    </div>
  );
}
