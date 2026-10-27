/**
 * 看图。
 *
 * 主模型自己能看图的（deepseek-flash 收 image_url 片段），图随消息直接进请求。
 * 这个文件干两件事：
 *   1. 把相册/相机来的图压成「模型看得清」的一到多片（长图要切，见 prepareImage）；
 *   2. 给不收图的模型留一条「先描述再进对话」的老路（captionImage）。
 */

import { planImageSlices } from "@herta/core";
import type { ChatMessage, ChatPart } from "@herta/protocol";
import { collect } from "./stream.ts";
import type { ChatTransport } from "./transport.ts";

function decodeFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读不了这个文件"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("这不像是一张图"));
      img.onload = () => resolve(img);
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** 压一张小图（表情包用）：长边不超过 maxSide，转 jpeg。 */
export function compressImage(file: File, maxSide = 512, quality = 0.85): Promise<{ dataUrl: string; mediaType: string }> {
  return decodeFile(file).then((img) => {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("这台机器画不了图");
    ctx.drawImage(img, 0, 0, w, h);
    return { dataUrl: canvas.toDataURL("image/jpeg", quality), mediaType: "image/jpeg" };
  });
}

/**
 * 把一张图压成「模型看得清」的一到多片。
 *
 * 官方单图预算：单边最长 8192 像素、每张图最多算 1024 个 token。1:13 的手机
 * 长截图整张寄过去，边长先超限；就算收下，那点预算摊到一万多像素的高度上，
 * 字也只会糊成灰带。所以先按宽度切段：每片 ≈ 1:1.4，各自都在单图预算内。
 *
 * 切出来的是这一条消息的附件：气泡里只显示第一片当缩略图，点开是整摞。
 */
export async function prepareImage(file: File, quality = 0.82): Promise<string[]> {
  const img = await decodeFile(file);
  const plan = planImageSlices(img.naturalWidth, img.naturalHeight);

  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("这台机器画不了图");

  const out: string[] = [];
  for (const s of plan.slices) {
    canvas.height = s.height;
    ctx.clearRect(0, 0, plan.width, s.height);
    // 整张按缩放后的尺寸铺上去，画布只留这一段——不用为每片各算一次缩放
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, -s.top, plan.width, plan.height);
    out.push(canvas.toDataURL("image/jpeg", quality));
  }
  return out;
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
