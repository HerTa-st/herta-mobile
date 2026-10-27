/**
 * 把接口报错翻成人话。
 *
 * 服务端回来的是这样一坨：
 *   模型接口 400: {"error":{"message":"The supported API model names are deepseek-v4-pro,
 *   but you passed DeepSeek-V4.1-Flash-1017.","type":"invalid_request_error",...}}
 * 直接贴进界面会把布局撑爆，而且用户看不出要改什么。
 *
 * 这里只做两件事：从 JSON 里挖出 message，再按常见错误给出**该动哪个设置**。
 * 挖不出来就原样返回——宁可难看，也不要骗人。
 */

const MAX_LEN = 220;

interface Parsed {
  status: number | null;
  detail: string;
}

/** 从「模型接口 400：{...}」里拆出状态码与服务端原文。 */
export function splitApiError(raw: string): Parsed {
  const text = String(raw ?? "").trim();
  const m = text.match(/^模型接口\s*(\d{3})\s*[：:]([\s\S]*)$/);
  const status = m ? Number(m[1]) : null;
  const body = m ? m[2].trim() : text;

  let detail = body;
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const err = j?.error;
    if (typeof err === "string") detail = err;
    else if (err && typeof err.message === "string") detail = err.message;
    else if (typeof j?.message === "string") detail = j.message;
  } catch {
    /* 不是 JSON 就原样用 */
  }
  return { status, detail };
}

function clip(text: string): string {
  return text.length > MAX_LEN ? text.slice(0, MAX_LEN).trimEnd() + "…" : text;
}

/** 把一句话变短，并在能判断的时候指出该改哪里。 */
export function humanizeError(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";

  const { status, detail } = splitApiError(text);

  // 最容易踩的一个：把 App 里显示的模型名填进了 API 的 model 字段
  const modelHint = detail.match(/supported API model names? (?:are|is)\s*([^.,;]+)/i);
  if (modelHint || /invalid.*model|model.*not.*(found|exist|support)/i.test(detail)) {
    const want = modelHint ? modelHint[1].trim() : "";
    return (
      "模型名填错了" +
      (want ? "：这个接口只认 " + want : "") +
      "。设置里的「模型」要填接口的 model id，不是 App 里看到的显示名。" +
      "\n服务端原话：" +
      clip(detail)
    );
  }

  if (status === 401) return "Key 不对或者过期了。设置里重新填一次。";
  if (status === 402) return "余额不足，去平台充点钱。";
  if (status === 429) return "触到限流了，等一下再说话。";
  if (status === 503 || status === 500) return "服务端那边出问题了（" + status + "），不是你的配置。\n" + clip(detail);

  return status ? "接口 " + status + "：" + clip(detail) : clip(detail);
}
