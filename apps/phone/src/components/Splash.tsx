/**
 * 开屏动画（B9）：满屏 ASCII 竖流。
 *
 * 播放器在 `assets/opening/vertical-flow.js`（实时算，参数取自同目录的
 * vertical-flow.json，600 字节，不存帧）；这里只负责：给一块画布、跑
 * requestAnimationFrame、演完把覆盖层淡出。
 *
 * 三条不许破的线：
 *   1) 不画角色剪影——旧那段 cropSegmentToFigure 的剪影路已经整条不用了；
 *   2) 流完是**覆盖层淡出**，底下的主页一直在，不存在"换页"那一帧，也就不会闪白；
 *   3) 四秒兜底：动画再卡、参数再取不到，也要让人进 App。
 *
 * 12 小时门控与"从后台切回不播"是 B1 的开关（App.tsx），这里不动。
 */
import { useEffect, useRef, useState } from "react";

const PLAYER_URL = "opening/vertical-flow.js";
const DATA_URL = "opening/vertical-flow.json";

/** 开屏最短间隔：12 小时。 */
export const SPLASH_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * 这次冷启动该不该播开屏。
 *
 * 只按「上次开屏时间」算：0 / 非数 当作从没播过。
 * 后台切回不算冷启动（那一条在 App 里收住），所以这里只回答时间够不够。
 */
export function shouldPlaySplash(lastSplashAt: number, now = Date.now()): boolean {
  if (!Number.isFinite(lastSplashAt) || lastSplashAt <= 0) return true;
  return now - lastSplashAt >= SPLASH_INTERVAL_MS;
}

interface VerticalFlow {
  resize(width: number, height: number, dpr: number): void;
  setConfig?(data: unknown): void;
  frame(timeMs: number): boolean;
  tune?(): { quality: number; fps: number; cols: number };
}

/** 覆盖层底色：与播放器两套配色一致，深色用户开屏不该先亮一张白纸。 */
const PAPER = { light: "#fafcfd", dark: "#0d1116" };

export function Splash({ onDone }: { onDone(): void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [fadeMs, setFadeMs] = useState(600);
  // index.html 在 React 之前就把 data-theme 打上了，冷启动读得到
  const [dark] = useState(
    () => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
  );

  // 淡出结束后再卸载：过渡没走完就抽掉画布会闪一下
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(onDone, fadeMs + 80);
    return () => window.clearTimeout(t);
  }, [leaving, fadeMs, onDone]);

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let player: VerticalFlow | null = null;
    let leavingNow = false;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d") ?? null;

    const leave = (ms = 600) => {
      if (cancelled || leavingNow) return;
      leavingNow = true;
      setFadeMs(ms);
      setLeaving(true);
    };
    // 兜底：动画再怎么卡，四秒后也得让人进去。这条一直挂到卸载，不提前清。
    const bail = window.setTimeout(() => leave(500), 4000);

    const resize = () => {
      player?.resize(window.innerWidth, window.innerHeight, Math.min(2, window.devicePixelRatio || 1));
    };
    window.addEventListener("resize", resize);

    void (async () => {
      try {
        if (!canvas || !ctx) throw new Error("没有画布");
        const mod = await import(/* @vite-ignore */ new URL(PLAYER_URL, document.baseURI).href);
        if (cancelled) return;

        // 默认值先跑起来：createVerticalFlow 内部有一份与 JSON 相同的常量，
        // 数据文件没到（或没取到）就先按它流，不会白屏等文件。
        player = mod.createVerticalFlow(canvas, ctx, null, {
          dark,
          onDissolve: (ms: number) => leave(Math.max(300, Math.round(ms))),
        });
        resize();

        void fetch(DATA_URL)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (!cancelled && player && data) player.setConfig?.(data);
          })
          .catch(() => undefined);

        const tick = (t: number) => {
          if (cancelled || !player) return;
          if (player.frame(t)) raf = requestAnimationFrame(tick);
          else leave(400);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        leave(400);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.clearTimeout(bail);
    };
  }, [dark]);

  return (
    <div
      data-part="splash"
      className={"opening" + (leaving ? " leaving" : "")}
      style={{ transitionDuration: fadeMs + "ms", background: dark ? PAPER.dark : PAPER.light }}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
