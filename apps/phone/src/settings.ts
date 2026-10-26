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
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  contextBlocks: 24,
  memorySeeds: 3,
  reviewEnabled: true,
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
