import { useCallback, useEffect, useRef, useState } from "react";
import "../styles/onboarding.css";
import { humanizeError } from "@herta/core";
import type { Settings } from "../settings.ts";
import { ensureNotificationPermission } from "../capabilities.ts";
import { openAppSettings } from "../keepalive.ts";
import { pickTransport } from "../transport.ts";

type Probe = { state: "idle" | "checking" | "ok" | "bad"; text: string };

/**
 * 拿这个 Key 发一个最小的请求：只要能出第一块，就说明鉴权过了。
 *
 * 只回一句话，不挡人继续——Key 抄错、没网、没余额都只是提示，不是错误页。
 * 走 app 同一条通道（原生 / 浏览器），真机与浏览器看到的才是同一种结果。
 */
async function probeKey(args: {
  apiKey: string;
  baseUrl: string;
  model: string;
  signal: AbortSignal;
}): Promise<Probe> {
  try {
    const stream = pickTransport().stream({
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      model: args.model,
      messages: [{ role: "user", content: "在吗" }],
      maxTokens: 1,
      signal: args.signal,
    });
    // 第一块之前就出错（鉴权失败 / 连不上）会在 next() 里抛，不用等整段流走完
    for await (const chunk of stream) {
      void chunk;
      break;
    }
    return { state: "ok", text: "接上了。她听见你了。" };
  } catch (e) {
    if (args.signal.aborted) return { state: "idle", text: "" };
    const raw = e instanceof Error ? e.message : String(e);
    const status = raw.match(/^模型接口\s*(\d{3})/)?.[1];
    // 连不上时没有状态码：浏览器是「Failed to fetch」，原生通道是各种网络错误
    if (
      !status &&
      /fetch|network|load failed|timeout|timed out|unable to resolve|econn|offline|connect|socket|dns|host|unreachable|no route|网络/i.test(
        raw
      )
    ) {
      return { state: "bad", text: "网络不通：换个网再验一次，Key 先不用改。" };
    }
    if (status === "401") return { state: "bad", text: "Key 不对：检查有没有复制全，或者它已经过期。" };
    if (status === "402") return { state: "bad", text: "这个 Key 没余额了：去平台充一点再回来。" };
    return { state: "bad", text: humanizeError(raw) || "没验成——先跳过也行，之后在设置里能再验。" };
  }
}

/**
 * 第一次打开时的五步。
 *
 * 为什么要有这一页：朋友装上之后看到的是一个空白聊天页，而"她还藏着七种能力"
 * 这件事只有翻设置的人才知道。引导不是教程，只把这五件必须由用户做的事排在一屏里：
 * 她怎么叫你、填 Key、挑能力、给通知权限、加电池白名单。
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
  const [keyProbe, setKeyProbe] = useState<Probe>({ state: "idle", text: "" });
  const probeAbort = useRef<AbortController | null>(null);
  /** 上一次验过的 Key：同一个 Key 不重复发请求（验过 / 正在验都算）。 */
  const probedKey = useRef("");

  const verifyKey = useCallback(async () => {
    const key = settings.apiKey.trim();
    if (!key) return;
    probeAbort.current?.abort();
    const ctl = new AbortController();
    probeAbort.current = ctl;
    setKeyProbe({ state: "checking", text: "正在试一下这个 Key…" });
    const result = await probeKey({
      apiKey: key,
      baseUrl: settings.baseUrl,
      model: settings.model,
      signal: ctl.signal,
    });
    if (ctl.signal.aborted) return;
    probedKey.current = key;
    setKeyProbe(result);
  }, [settings.apiKey, settings.baseUrl, settings.model]);

  // 第 2 步「填完」自动验一次：等手停下来再发，别边打边发请求。
  useEffect(() => {
    const key = settings.apiKey.trim();
    if (key.length < 20 || key === probedKey.current) return;
    const timer = window.setTimeout(() => void verifyKey(), 1200);
    return () => window.clearTimeout(timer);
  }, [settings.apiKey, settings.baseUrl, settings.model, verifyKey]);

  // 关掉引导页就别再让请求回来改状态
  useEffect(() => () => probeAbort.current?.abort(), []);

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
        <p className="onboardLede">五件事，两分钟。现在不做也行——之后都能从设置里补。</p>

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
              <p>不填就叫开拓者。只存在这台手机上，想改就重看一遍引导。</p>
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
                onBlur={() => {
                  const key = settings.apiKey.trim();
                  if (key && key !== probedKey.current) void verifyKey();
                }}
                placeholder="sk-..."
                autoComplete="off"
              />
              <p>用你自己的额度。只存在这台手机上，不上传，也不进日志。填完会自动试一次，不对也能先跳过。</p>
              {keyProbe.state !== "idle" && (
                <p
                  className="onboardNote"
                  role="status"
                  style={{
                    margin: 0,
                    textAlign: "left",
                    color:
                      keyProbe.state === "ok" ? "var(--accent)" : keyProbe.state === "bad" ? "#b0575f" : "var(--muted)",
                  }}
                >
                  <span aria-hidden="true">
                    {keyProbe.state === "ok" ? "● " : keyProbe.state === "checking" ? "… " : "! "}
                  </span>
                  {keyProbe.text}
                  {keyProbe.state === "bad" && (
                    <button
                      type="button"
                      className="onboardSkip"
                      style={{ marginLeft: 6, padding: 0, fontSize: 10 }}
                      onClick={() => void verifyKey()}
                    >
                      再验一次
                    </button>
                  )}
                </p>
              )}
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
              <p>默认全关——想让她会哪样，再打开哪样。</p>
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
              <p>不给也能聊，只是到点不会响。</p>
            </div>
          </section>

          <section className="onboardStep">
            <span className="onboardNo">05</span>
            <div className="onboardStepBody">
              <h3>别让她被系统杀掉</h3>
              <p>国产系统会清后台。系统设置 → 电池 → 选「不受限制」，她才能在你不打开 App 的时候也醒着。做不到也行——那样她只在你打开 App 时醒着。</p>
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
