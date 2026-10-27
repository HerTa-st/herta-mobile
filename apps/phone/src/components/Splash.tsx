/**
 * 开屏动画。
 *
 * 用的是 dsh-herta 主题里那套 ASCII 半调开场（`theme/dsh-theme-herta/lib/opening`）：
 * 她的轮廓由几千个字符的明暗拼出来，白底，字符每隔半秒换一次，播完整体淡出。
 *
 * 播放器与编码好的段落原样放在 `assets/opening/`（publicDir，浏览器直接当 ES 模块
 * 取），这里只负责：给一块画布、跑 requestAnimationFrame、在 dissolve 那一点开始淡出。
 * 不在 app 里重写渲染逻辑——那种"照着抄一半"的东西，迟早跟原版长得不一样。
 *
 * 失败就退化成一次快步淡出：开屏不该挡着人进 App。
 */
import { useEffect, useRef, useState } from "react";
import { cropSegmentToFigure } from "../opening/crop-segment.ts";

const PLAYER_URL = "opening/opening-player.js";
const SEGMENT_URL = "opening/segment-b-0.json";


interface OpeningPlayer {
  resize(width: number, height: number, dpr: number): void;
  frame(timeMs: number): boolean;
}

export function Splash({ onDone }: { onDone(): void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [fadeMs, setFadeMs] = useState(600);

  // 淡出结束后再卸载：过渡没走完就抽掉画布会闪一下
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(onDone, fadeMs + 80);
    return () => window.clearTimeout(t);
  }, [leaving, fadeMs, onDone]);

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let player: OpeningPlayer | null = null;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d") ?? null;

    const leave = (ms = 600) => {
      if (cancelled) return;
      setFadeMs(ms);
      setLeaving(true);
    };
    // 兜底：动画再怎么卡，四秒后也得让人进去
    const bail = window.setTimeout(() => leave(500), 4000);

    const resize = () => {
      player?.resize(window.innerWidth, window.innerHeight, Math.min(2, window.devicePixelRatio || 1));
    };
    window.addEventListener("resize", resize);

    void (async () => {
      try {
        if (!canvas || !ctx) throw new Error("没有画布");
        const [mod, data] = await Promise.all([
          import(/* @vite-ignore */ new URL(PLAYER_URL, document.baseURI).href),
          fetch(SEGMENT_URL).then((r) => {
            if (!r.ok) throw new Error("开场段落 HTTP " + r.status);
            return r.json();
          }),
        ]);
        if (cancelled) return;

        player = mod.createOpeningPlayer(
          canvas,
          ctx,
          cropSegmentToFigure(data),
          false,
          {
            onDissolve: (ms: number) => leave(Math.max(300, Math.round(ms))),
            onInstant: () => leave(400),
          },
          performance.now(),
          null
        );
        resize();

        const tick = (t: number) => {
          if (cancelled || !player) return;
          if (player.frame(t)) raf = requestAnimationFrame(tick);
          else leave(400);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        leave(400);
      } finally {
        window.clearTimeout(bail);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.clearTimeout(bail);
    };
  }, []);

  return (
    <div
      className={"opening" + (leaving ? " leaving" : "")}
      style={{ transitionDuration: fadeMs + "ms" }}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} />
    </div>
  );
}