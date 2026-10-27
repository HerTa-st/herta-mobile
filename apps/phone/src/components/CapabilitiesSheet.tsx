import type { Settings } from "../settings.ts";

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

      <p className="memNote">
        还没做的（下一版）：读通知栏、定位、相机、无障碍替你点。这些要单独申请系统授权，不在这版里。
      </p>
    </div>
  );
}
