/** 设置只落在本机：localStorage。密钥不上传、不进日志。 */

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
  /** 你离开一阵子之后，她自己做梦。关掉就只有手动按钮能做。 */
  autoDream: boolean;
  /** 看图用的视觉模型。留空 = 不做图片识别（仍然能发图，只是她看不见内容）。 */
  visionModel: string;
  /** 允许她翻你的相册。默认关——这是隐私开关，得你自己打开。 */
  albumEnabled: boolean;
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
  model: "deepseek-chat",
  contextBlocks: 24,
  memorySeeds: 3,
  reviewEnabled: true,
  moodEnabled: true,
  autoDream: true,
  visionModel: "",
  albumEnabled: false,
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
