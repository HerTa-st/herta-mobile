/**
 * 她的声音。.opus 是整篇录好的原声，不走 TTS——M1 只有这一条路。
 *
 * 浏览器自动播放策略要求手势；所以没有"自动开口"，只有按钮。
 * 装成 APK 之后 WebView 会放宽这条，但保留按钮更诚实：她话多，不该一进页面就吵。
 */

let current: HTMLAudioElement | null = null;

export function stopVoice(): void {
  if (current) {
    current.pause();
    current.currentTime = 0;
    current = null;
  }
}

export async function playVoice(url: string): Promise<void> {
  stopVoice();
  const audio = new Audio(url);
  current = audio;
  try {
    await audio.play();
  } catch (e) {
    stopVoice();
    throw e instanceof Error ? e : new Error(String(e));
  }
}
