import { useState } from "react";
import type { Settings } from "../settings.ts";
import { openNotifySettings } from "../notif.ts";
import { A11ySheet } from "./A11ySheet.tsx";

/**
 * 「她能做什么」——一整页，不是塞在设置里的一堆勾。
 *
 * 三组按**敏感度**排，而不是按功能排：她能看见什么 / 她会动手做什么 / 她是不是
 * 一直在后台。这个顺序和"她在对话里先问一句"那条规矩是一条线：越往下越需要
 * 你自己想清楚再打开。
 *
 * 全部默认关。她自己不能替你把它们打开——权限是用户给的，不是人格给的。
 */
export function CapabilitiesSheet({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
  onClose(): void;
}) {
  const [showA11y, setShowA11y] = useState(false);
  const row = (checked: boolean, key: keyof Settings, title: string, hint: string) => (
    <label className="check capRow">
      <input type="checkbox" checked={checked} onChange={(e) => onChange({ [key]: e.target.checked } as Partial<Settings>)} />
      <span>
        <b>{title}</b>
        <em>{hint}</em>
      </span>
    </label>
  );

  return (
    <div className="sheet">
      <div className="sheetHead">
        <span>她能做什么</span>
        <button type="button" className="sheetClose" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>
      <p className="memNote">
        默认全是关的。开一项，她那一轮才拿得到那只手；没开的那些，她连工具都看不见。
      </p>

      <h3 className="capGroup">只看得见</h3>
      {row(settings.statusEnabled, "statusEnabled", "看手机状态", "电量、是否在充电、联网方式、这个 App 占多大地方。看不到你的照片和消息。")}
      {row(
        settings.notifyEnabled,
        "notifyEnabled",
        "看通知栏",
        "她只会读最近二十几条（应用名、标题、正文、时间），不落盘、不常驻盯着；问她「刚才有什么事」才用得上。"
      )}
      {row(
        settings.mediaEnabled,
        "mediaEnabled",
        "看/控正在放的音乐",
        "和上面共用同一个系统授权；只能暂停、继续、切歌，看不到播放列表。"
      )}
      {(settings.notifyEnabled || settings.mediaEnabled) && (
        <button type="button" className="onboardBtn" onClick={() => void openNotifySettings()}>
          去系统里开「通知使用权」
        </button>
      )}
      {row(
        settings.locationEnabled,
        "locationEnabled",
        "知道你在哪",
        "只给经纬度和精度，不做逆地理编码。只在你要她查的时候查一次，不会在后台跟着你。"
      )}

      <h3 className="capGroup">会动手</h3>
      {row(
        settings.remindersEnabled,
        "remindersEnabled",
        "排提醒",
        "到点由系统响。标题是她那句话，正文写清楚事情。关掉之后她只能说「你自己记一下」。"
      )}
      {row(
        settings.calendarEnabled,
        "calendarEnabled",
        "你的日历",
        "能看接下来几天有什么，也能往里写字。写之前她会先说一句，你说行才写。"
      )}
      {row(settings.openEnabled, "openEnabled", "打开链接或别的 App", "把 https、tel:、地图、深链交给系统打开。她不会自己偷偷打开。")}
      {row(settings.shareEnabled, "shareEnabled", "分享出去", "调出系统分享面板，发不发、发给谁由你点。")}
      {row(
        settings.cameraEnabled,
        "cameraEnabled",
        "打开相机",
        "她会先问一句再开；拍完只拿到一段文字描述，原图不留在她那儿。这条要配了视觉模型才有用。"
      )}

      {row(
        settings.a11yEnabled,
        "a11yEnabled",
        "无障碍：替你看屏、替你点",
        "只在下面勾过的 App 里生效；动手之前她会先在对话里问一句。这是这批里权限最重的一样。"
      )}
      {settings.a11yEnabled && (
        <button type="button" className="sheetLink" onClick={() => setShowA11y(true)}>
          <span>允许她碰哪些 App</span>
          <span className="sheetLinkHint">白名单 ›</span>
        </button>
      )}

      <h3 className="capGroup">常驻后台</h3>
      {row(
        settings.proactiveEnabled,
        "proactiveEnabled",
        "她自己找你",
        "通知栏会挂一条「她在后台」。一天最多三条，二十二点到早上八点不吵；省 token 模式下不发。"
      )}
      {settings.proactiveEnabled &&
        row(
          settings.proactiveDeepMemory,
          "proactiveDeepMemory",
          "主动找你时翻完整记忆",
          "默认只带最近八块对话（几 k token）；打开后她会先检索一遍记忆，更像她，但一次可能上万 token。"
        )}

      {showA11y && <A11ySheet onClose={() => setShowA11y(false)} />}

      <p className="memNote">
        v0.29 这批到这儿就齐了。再往后是 M4 双模（连 PC）——那是另一整块。
      </p>
    </div>
  );
}
