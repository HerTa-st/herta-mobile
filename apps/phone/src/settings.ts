/** 设置只落在本机：localStorage。密钥不上传、不进日志。 */

import { budgetFor } from "@herta/core";

export interface Settings {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 这一轮带多少条历史（旧版只有这一个旋钮，先沿用）。 */
  contextBlocks: number;
  memorySeeds: number;
  /**
   * 说完先让她自己回头看一遍（桌面版行为）。
   * 开着每轮多一次模型调用，被打回还要再加——这是她"不吹牛"的代价。
   */
  reviewEnabled: boolean;
  /** 每轮先判一次心情（八种之一），决定这一轮的语气基线。多一次极便宜的调用。 */
  moodEnabled: boolean;
  /**
   * 省 token 模式。
   *
   * 一刀切掉一轮里最贵的三样：判心情、复核、长上下文；长图与工具轮也压小。
   * 具体数字在 core/budget.ts，这里只存开关——这样"省多少"只有一个出处。
   * 代价是她更容易跑题、记性更短，复核也拦不住她吹牛了。
   */
  cheapMode: boolean;
  /** 你离开一阵子之后，她自己做梦。关掉就只有手动按钮能做。 */
  autoDream: boolean;
  /**
   * 看图用的视觉模型（可选）。
   *
   * 主模型自己就能看图时（deepseek-flash 收 image_url 片段），这一栏用不上；
   * 它留着是给两件事：模型不收图时的「先描述再进对话」老路，以及她翻相册时
   * 真去读那一张（工具结果只能塞文字，塞不了图）。
   */
  visionModel: string;
  /** 允许她翻你的相册。默认关——这是隐私开关，得你自己打开。 */
  albumEnabled: boolean;
  /* 手机能力。全部默认关：她自己不能替你把它们打开，得你在「她能做什么」里逐个勾。 */
  /** 到点提醒（系统通知）。 */
  remindersEnabled: boolean;
  /** 读日历、往日历里写日程。 */
  calendarEnabled: boolean;
  /** 看电量、联网、占用空间。 */
  statusEnabled: boolean;
  /** 用系统打开链接 / 别的 App。 */
  openEnabled: boolean;
  /** 把东西分享到别的 App。 */
  shareEnabled: boolean;
  /** 看你现在在哪儿（经纬度）。 */
  locationEnabled: boolean;
  /** 打开相机拍一张，再让视觉模型描述给她。 */
  cameraEnabled: boolean;
  /** 读通知栏（系统「通知使用权」，要用户手动开）。 */
  notifyEnabled: boolean;
  /** 看与控正在放的音乐（同一个授权）。 */
  mediaEnabled: boolean;
  /** 无障碍：读屏幕 / 按文字点（白名单另存原生侧）。 */
  a11yEnabled: boolean;
  /** 她主动找你（常驻后台 + 到点醒来说一句）。 */
  proactiveEnabled: boolean;
  /** 主动说话时带完整记忆检索（默认只带最近 8 块对话，便宜很多）。 */
  proactiveDeepMemory: boolean;
  /** 云端语音：让她能说任意一句话，而不只是那 41 条录音。 */
  ttsEnabled: boolean;
  ttsProvider: "openai" | "minimax";
  ttsApiKey: string;
  ttsBaseUrl: string;
  ttsModel: string;
  ttsVoice: string;
  ttsGroupId: string;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  contextBlocks: 24,
  memorySeeds: 3,
  reviewEnabled: true,
  moodEnabled: true,
  cheapMode: false,
  autoDream: true,
  visionModel: "",
  albumEnabled: false,
  remindersEnabled: false,
  calendarEnabled: false,
  statusEnabled: false,
  openEnabled: false,
  shareEnabled: false,
  locationEnabled: false,
  cameraEnabled: false,
  notifyEnabled: false,
  mediaEnabled: false,
  a11yEnabled: false,
  proactiveEnabled: false,
  proactiveDeepMemory: false,
  ttsEnabled: false,
  ttsProvider: "openai",
  ttsApiKey: "",
  ttsBaseUrl: "https://api.openai.com/v1",
  ttsModel: "tts-1",
  ttsVoice: "alloy",
  ttsGroupId: "",
};

const KEY = "herta.settings.v1";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/** 这一轮实际用的预算（心情 / 复核 / 上下文 / 种子 / 工具轮 / 长图分段）。 */
export function budgetOf(s: Settings) {
  return budgetFor({
    cheap: s.cheapMode,
    moodEnabled: s.moodEnabled,
    reviewEnabled: s.reviewEnabled,
    contextBlocks: s.contextBlocks,
    memorySeeds: s.memorySeeds,
  });
}
