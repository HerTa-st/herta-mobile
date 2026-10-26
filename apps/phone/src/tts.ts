/**
 * 云端语音合成。
 *
 * 她自己的声音（36 条开场 + 4 条 veto）是打包在 APK 里的，那只是录音。
 * 想让她说任意一句话，就得走云端克隆声——这也是桌面版的做法。
 *
 * 两种接口都支持：
 *   openai —— POST {base}/audio/speech，直接回二进制
 *   minimax —— POST {base}/t2a_v2，回 JSON 里一段 hex 编码的音频
 * 选哪个取决于你手上是什么 key，不替你决定。
 */

import type { ChatTransport } from "./transport.ts";

export type TtsProvider = "openai" | "minimax";

export interface TtsConfig {
  provider: TtsProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  /** MiniMax 需要，其他不用。 */
  groupId?: string;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBlobUrl(bytes: Uint8Array, mediaType: string): string {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return URL.createObjectURL(new Blob([copy], { type: mediaType }));
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** 合一段语音，返回可以直接塞给 Audio 的 blob URL。用完记得 revoke。 */
export async function synthesize(
  transport: ChatTransport,
  cfg: TtsConfig,
  text: string
): Promise<string> {
  const say = text.trim().slice(0, 1200);
  if (!say) throw new Error("没有要念的字");
  if (!cfg.apiKey) throw new Error("还没填语音的 Key");

  const base = cfg.baseUrl.replace(/\/$/, "");

  if (cfg.provider === "minimax") {
    // MiniMax 回来的是 JSON，里面一段 hex 编码的 mp3——所以走 post 而不是 postBinary
    const url = base + "/t2a_v2" + (cfg.groupId ? "?GroupId=" + encodeURIComponent(cfg.groupId) : "");
    const { status, body } = await transport.post(url, {
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model || "speech-01-turbo",
        text: say,
        voice_setting: { voice_id: cfg.voice || "female-shaonv", speed: 1, vol: 1, pitch: 0 },
        audio_setting: { format: "mp3", sample_rate: 32000, bitrate: 128000 },
      }),
    });
    if (status >= 400) throw new Error("语音接口 " + status + "：" + body.slice(0, 200));
    const hex = (JSON.parse(body) as { data?: { audio?: string } })?.data?.audio;
    if (!hex) throw new Error("语音接口没给音频：" + body.slice(0, 200));
    return bytesToBlobUrl(hexToBytes(hex), "audio/mpeg");
  }

  const { base64, mediaType } = await transport.postBinary(base + "/audio/speech", {
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
    body: JSON.stringify({
      model: cfg.model || "tts-1",
      input: say,
      voice: cfg.voice || "alloy",
      response_format: "mp3",
    }),
  });
  return bytesToBlobUrl(base64ToBytes(base64), mediaType);
}
