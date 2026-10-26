/**
 * 看图。
 *
 * DeepSeek 的对话模型不吃图片，所以这里走的是旧手机版验证过的路子：
 * 先把图压到长边 1280，交给一个视觉模型描述成文字，再把文字当附件塞进对话。
 *
 * 这不是"多模态对话"，是"她看了一眼，然后记住自己看到了什么"——
 * 在手机上这种做法的代价最小，也不会因为模型不支持图片而整条链路崩掉。
 */

import type { ChatMessage, ChatPart } from "@herta/protocol";
import { collect } from "./stream.ts";
import type { ChatTransport } from "./transport.ts";

/** 本地压缩：长边不超过 1280，转成 jpeg。手机直出的大图会被运营商网络拖死。 */
export function compressImage(file: File, maxSide = 1280, quality = 0.82): Promise<{ dataUrl: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读不了这个文件"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("这不像是一张图"));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("这台机器画不了图"));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: canvas.toDataURL("image/jpeg", quality), mediaType: "image/jpeg" });
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export interface VisionConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * 让她"看一眼"。提示词刻意简短：我们要的是一段能进对话的描述，
 * 不是一篇评论——她那套语气由人格层负责，这里只描述事实。
 */
export async function captionImage(
  transport: ChatTransport,
  cfg: VisionConfig,
  dataUrl: string,
  hint?: string
): Promise<string> {
  const parts: ChatPart[] = [
    {
      type: "text",
      text:
        "用中文客观描述这张图里有什么：文字原样抄出来，界面就说明是什么界面，人物/物体说清是什么。" +
        "不要评论，不要推测情绪，不要用第一人称。控制在 200 字以内。" +
        (hint ? "\n附注：" + hint : ""),
    },
    { type: "image_url", image_url: { url: dataUrl } },
  ];
  const messages: ChatMessage[] = [{ role: "user", content: parts }];
  return collect(
    transport.stream({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      messages,
      maxTokens: 400,
    })
  );
}
