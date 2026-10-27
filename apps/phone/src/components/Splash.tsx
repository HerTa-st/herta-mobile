/**
 * 启动页。
 *
 * 原生闪屏（res 里那一组 splash.png）只是一张静态图，这里接上动画：
 * 立绘淡入、身后一圈虚线紫环慢慢转、「黑塔 / 天才俱乐部 #83」的字距展开，
 * 然后淡出，交给聊天。
 *
 * 时长按"至少 1.5 秒"：太快像闪了一下没加载出来，太慢会烦。App 准备好之后
 * 就开始收尾；但最多等到 2.8 秒——启动出错时不能让她永远卡在门口。
 */
import { useEffect, useState } from "react";

const MIN_MS = 1500;
const MAX_MS = 2800;
const LEAVE_MS = 450;

export function Splash({ ready, onDone }: { ready: boolean; onDone(): void }) {
  const [minElapsed, setMinElapsed] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const min = setTimeout(() => setMinElapsed(true), MIN_MS);
    const hard = setTimeout(() => setLeaving(true), MAX_MS);
    return () => {
      clearTimeout(min);
      clearTimeout(hard);
    };
  }, []);

  useEffect(() => {
    if (ready && minElapsed) setLeaving(true);
  }, [ready, minElapsed]);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(onDone, LEAVE_MS);
    return () => clearTimeout(t);
  }, [leaving, onDone]);

  return (
    <div className={"splash" + (leaving ? " leaving" : "")} aria-hidden="true">
      <div className="splashArt">
        <span className="splashRing" />
        <img src="art/herta-320.png" alt="" />
      </div>
      <h1>黑塔</h1>
      <p className="splashSub">天才俱乐部 · #83</p>
      <p className="splashTip">正在启动模拟宇宙</p>
    </div>
  );
}
