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
  /** NMS 深睡：有 key + 网络 + 前台/保活时，App 空闲才跑。 */
  nmsDeepSleepEnabled: boolean;
  /** NMS 每晚 LLM 调用上限（0 关、默认 8、最高 40）。 */
  nmsNightCap: number;
  /**
   * 她会看时机回话：有时不接（尤其是收尾那句）、有时慢半拍。
   * 关掉就回到"每句立刻回"——调提示词的时候有用。
   */
  replyPacing: boolean;
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
  /**
   * 她怎么叫你。
   *
   * 引导页填一次；空着就按老的叫法（开拓者）。只在引导页改——
   * 想改就重看一遍引导（设置 · 界面 · 开屏与引导）。
   */
  userName: string;
  /**
   * 左轨收起。
   *
   * true = 左轨压成 12px 的把手（正文多出 46px）；false = 常驻 58px 工作台。
   * 只改宽度，不改入口；整屏页（币 / 播报 / 设置）跟着一起让位。
   */
  railCollapsed: boolean;
  /**
   * 外观。
   *
   * system = 跟随系统；light = 白天的玻璃工作台；dark = C 的夜间（深空底 / 青色信号）。
   * 只换 token，不换布局；开屏的 ASCII 白底保持不动。
   */
  theme: "system" | "light" | "dark";
  /**
   * 当前的脸。
   *
   * - `"preset"` = 随包带来的预设像（半调 H，和启动图标同一套）；
   * - `"data:image/..."` = 从相册选的那张（压缩后的 data URL，只在本机）。
   *
   * 全应用唯一：头像不进消息、不进会话，每条消息渲染时读这一个值——
   * 所以换完之后历史消息里的头像也跟着换。见 CONTEXT 的「当前的脸」。
   */
  avatar: string;
  /**
   * 聊天背景（全局那张）。
   *
   * `""` = 不设；预设 id 见 BACKGROUND_PRESETS；`"data:image/..."` = 从相册选的那张。
   * 作用域是「按会话」时，这条只是没单独设过的会话的兜底（新会话继承它）。
   */
  chatBackground: string;
  /**
   * 背景作用域。
   *
   * global = 一张背景管全部会话；session = 当前会话可以单独覆盖，
   * 没覆盖过的会话（包括新会话）继续用全局那张。
   */
  backgroundScope: "global" | "session";
  /**
   * 上次开屏的时间（ms，0 = 从没播过）。
   *
   * 只用于开屏频次：距上次 ≥12 小时才播一次，而且只算冷启动。
   * 被门控跳过的那次不算「开屏」，所以不能拿 App 启动时间顶替。
   */
  lastSplashAt: number;
  /**
   * 黑塔币行情接口基址（可选覆盖）。
   *
   * 空 = 用构建时注入的 VITE_COIN_API_BASE（开发模式自动落到本地 mock）；
   * 填了就以这里为准——FC 还没部署时，装机后改这一栏就能接上，不用重打 APK。
   */
  coinApiBase: string;
  /**
   * 共享市场昵称 / QQ 号。
   *
   * 空 = 单机模式（本地钱包 + 本地签到 + 行情）；
   * 填了 = 进共享市场（服务端账本、买卖、服务端签到、排行榜）。
   * 在「黑塔币」页顶部填，不放在设置里。
   */
  coinIdentity: string;
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
  nmsDeepSleepEnabled: true,
  nmsNightCap: 8,
  replyPacing: true,
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
  coinApiBase: "",
  coinIdentity: "",
  userName: "",
  railCollapsed: false,
  theme: "system",
  avatar: "preset",
  chatBackground: "",
  backgroundScope: "global",
  lastSplashAt: 0,
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
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (err) {
    // 相册背景把 localStorage 撑爆时别让整个 App 挂掉：这一轮没落盘，界面还在
    console.warn("设置没存下来（本地存储满了）", err);
  }
}

/* ------------------------------------------------------------ 外观 · 她的样子 */

/** 预设像：随包带来的半调 H（和启动图标同一套），不依赖任何立绘素材。 */
export const PRESET_FACE_SRC = "/avatars/halftone-h.png";

/**
 * 背景预设。
 *
 * id 同时是 CSS 里 `[data-bg="…"]` 的名字——预览块和真正那层背景用的是同一套声明，
 * 所以这里改一个名字，两处一起变。都是程序画的，不加图片素材。
 */
export const BACKGROUND_PRESETS = [
  { id: "dots", label: "半调" },
  { id: "dusk", label: "暮色" },
  { id: "grid", label: "坐标纸" },
] as const;

/** 相册选的那张是 data URL；预设像 / 预设背景是短 id。 */
export function isCustomImage(value: string): boolean {
  return value.startsWith("data:image/");
}

/** 当前的脸的地址（4 处头像渲染只认这一个函数）。 */
export function faceSrc(s: Settings): string {
  return isCustomImage(s.avatar) ? s.avatar : PRESET_FACE_SRC;
}

/**
 * 当前该画哪张背景。
 *
 * 按会话时：这条会话单独设过就用它的（`""` 也算设过 = 这条不设），
 * 没设过（null）就落到全局——新会话天然继承全局。
 */
export function backgroundOf(s: Settings, sessionBackground: string | null): string {
  return s.backgroundScope === "session" && sessionBackground !== null ? sessionBackground : s.chatBackground;
}

/** 背景值 → CSS 的 data-bg（none / custom / 预设 id）。 */
export function backgroundKind(value: string): string {
  if (!value) return "none";
  return isCustomImage(value) ? "custom" : value;
}

/** 「按会话」的覆盖表：sessionId → 背景值。存在 kv，不往 Session 协议里加字段。 */
export const SESSION_BACKGROUND_KEY = "sessions.background";

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
