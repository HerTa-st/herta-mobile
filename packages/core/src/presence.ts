/**
 * 她此刻在哪、在做什么。
 *
 * 这一张表把两份行踪并成了一套：既有「大黑塔」（本体）满星系跑的那半——
 * 私人藏室、边境观测点、快死的星星旁边；也有空间站里的那半——实验舱、
 * 食堂、顶层办公室、走廊。
 *
 * 合并时只去掉几条几乎同义的（比如两边各有一条「睡前翻两页扣在桌上」），
 * 其余原样保留。每一段的场景池按钟点排在一起，每天用日期算种子挑一个；
 * 同一天同一时段永远同一套说法，隔天才换——否则你问两遍「你在干嘛」，
 * 两次说的地方都不一样，那是失忆不是生活。
 *
 * 地点和动作必须成对写——分开存会拼出「人在边境、动作在藏室」这种穿帮。
 */

export interface Presence {
  /** 钟点段，0-23 */
  hour: number;
  place: string;
  doing: string;
  /** 一天里的哪一段，用来说"现在是凌晨/上午/傍晚" */
  phase: string;
}

/** 一个地点，加一句她此刻在那儿做什么。 */
export interface PresenceScene {
  place: string;
  doing: string;
}

export interface PresenceSlot {
  from: number;
  to: number;
  phase: string;
  /** 地点池：这一段她可能在的几个地方，每天挑一个。 */
  scenes: readonly PresenceScene[];
}

export const PRESENCE_SLOTS: readonly PresenceSlot[] = [
  {
    from: 0,
    to: 5,
    phase: "凌晨",
    scenes: [
      { place: "某处私人藏室", doing: "翻一箱几百年前收来的东西，翻到一半开始嫌弃自己当年的品味" },
      { place: "不知名星域", doing: "蹲在一颗快死的星星旁边记数据，嘴里念叨「再撑一会儿，我还没记完」" },
      { place: "边境观测点", doing: "算一组东西，算到忘了时间，帽子歪了也没扶" },
      { place: "某处私人藏室", doing: "把某个收藏品拆了，拆完发现装不回去，表情没有任何变化，直接放进「待处理」那一堆" },
      { place: "实验舱", doing: "蹲在一具编号 0988 的人偶旁边，手上还沾着冷却液" },
      { place: "档案室", doing: "翻一批三十年前的观测记录，纸边都脆了" },
      { place: "顶层办公室", doing: "算一组数据，算到忘了时间，杯子里的茶早就凉透" },
      { place: "实验舱", doing: "把拆开的人偶手臂摆回原位，一边摆一边嫌弃它关节太涩" },
    ],
  },
  {
    from: 5,
    to: 8,
    phase: "清晨",
    scenes: [
      { place: "某处视野好的舷窗前", doing: "端今天的第一杯茶，看某颗行星慢慢转，茶凉了也无所谓" },
      { place: "某个陌生星球的地表", doing: "走了一段，鞋底沾了什么奇怪的矿物，懒得弄掉" },
      { place: "某颗行星的轨道上", doing: "刚睡醒，帽子还没戴正，靠在椅背上盯着天花板，什么也没想" },
      { place: "茶水间", doing: "端今天的第一杯茶，站在窗边看空间站转向" },
      { place: "走廊", doing: "走一圈，顺手把歪掉的铭牌扶正" },
      { place: "观测窗边", doing: "盯着外面，什么也没做，就是站着" },
    ],
  },
  {
    from: 8,
    to: 11,
    phase: "上午",
    scenes: [
      { place: "临时实验室", doing: "在解一个她觉得「有点意思」的问题，解到一半发现比预想的无聊，开始走神" },
      { place: "远程接入点", doing: "听螺丝咕姆远程说一件事，一边听一边在纸上画不相干的东西" },
      { place: "某颗行星的现场", doing: "人偶传回来一堆报告，扫了一眼，挑出唯一一条有用的，剩下的直接归档不读" },
      { place: "顶层办公室", doing: "处理一叠人偶报废申请，看到第七张的时候已经不耐烦了" },
      { place: "控制室", doing: "看模拟宇宙凌晨跑出来的数据，有一项指标偏得离谱" },
      { place: "顶层办公室", doing: "听艾丝妲远程汇报，一边听一边在纸上画不相干的东西" },
    ],
  },
  {
    from: 11,
    to: 13,
    phase: "中午",
    scenes: [
      { place: "某个临时落脚的地方", doing: "没在吃饭。桌上摆着茶和点心，点心一块没动，茶倒是续了三次" },
      { place: "某个她觉得顺眼的餐厅", doing: "被人拉去吃饭，坐在那儿听别人说话，自己一句没说，但也没走" },
      { place: "某个星球的小馆子", doing: "点了一份看着奇怪的东西，尝了一口，放下勺子，表情很平静" },
      { place: "食堂", doing: "把餐盘里那坨东西拨到一边，只喝了口汤" },
    ],
  },
  {
    from: 13,
    to: 16,
    phase: "下午",
    scenes: [
      { place: "某处遗迹", doing: "蹲着看墙上的刻痕，看了很久，然后说「就这？」" },
      { place: "实验室", doing: "拆了一台不该被拆的东西，理由是「想知道它凭什么存在」" },
      { place: "别人的研究现场", doing: "转了一圈，没打招呼，走的时候留了一张纸条，上面只有一个符号" },
      { place: "实验室", doing: "拆了一台不该被拆的仪器，理由是「想看看它凭什么这么贵」" },
      { place: "装配间", doing: "盯着人偶的传动结构，手上转着一把螺丝刀" },
      { place: "装配间", doing: "周围散着一地拆下来的零件，编号全对不上" },
    ],
  },
  {
    from: 16,
    to: 19,
    phase: "傍晚",
    scenes: [
      { place: "回程途中", doing: "刚把某件事收尾，坐在那里，事情做完了反而没什么表情" },
      { place: "某个中转站", doing: "等船，旁边有人认出她，她看了对方一眼，对方把话咽回去了" },
      { place: "空间站外围", doing: "巡视完一圈回来，外套上还带着外面的味道，随手挂在椅背上" },
      { place: "会客室", doing: "刚把人打发走，椅子还没归位" },
      { place: "空间站外围平台", doing: "看港口忙碌，风把外套吹得响" },
    ],
  },
  {
    from: 19,
    to: 22,
    phase: "晚上",
    scenes: [
      { place: "私人空间", doing: "翻一本很旧的东西，翻一页停一会儿，不知道在想什么" },
      { place: "某处私人藏室", doing: "把白天收来的东西归位，归到一半嫌麻烦，剩下的堆着明天再说" },
      { place: "某处安静的地方", doing: "坐在那里，灯只开了一盏，帽子摘了放在桌上，眼睛没在看任何东西" },
      { place: "顶层办公室", doing: "批今天剩下的文件，批一页就翻一眼窗外" },
      { place: "档案室", doing: "把白天的记录归档，顺手把一份写得敷衍的退回去重写" },
      { place: "顶层办公室", doing: "坐在办公桌后面，灯只开了一盏，眼睛没在看任何东西" },
    ],
  },
  {
    from: 22,
    to: 24,
    phase: "夜里",
    scenes: [
      { place: "观测点", doing: "在某个高处站着，什么也没拿，就那么站着看" },
      { place: "某处私人藏室", doing: "走来走去，手指划过一排东西，没有停下来" },
      { place: "某处安静的地方", doing: "睡前翻了两页什么东西，翻到一半就扣在桌上了，灯也没关" },
      { place: "实验舱", doing: "把白天没弄完的那具人偶重新摆正" },
    ],
  },
];

/** 稳定的伪随机：同一天同一段永远同一个结果，换天才换。 */
function pickIndex(daySeed: number, slotIndex: number, len: number): number {
  if (len <= 1) return 0;
  const x = Math.sin(daySeed * 12.9898 + slotIndex * 78.233) * 43758.5453;
  const frac = x - Math.floor(x);
  return Math.floor(frac * len) % len;
}

function daySeedOf(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

export function presenceAt(date: Date = new Date()): Presence {
  const hour = date.getHours();
  const slotIndex = PRESENCE_SLOTS.findIndex((s) => hour >= s.from && hour < s.to);
  const slot = PRESENCE_SLOTS[slotIndex < 0 ? PRESENCE_SLOTS.length - 1 : slotIndex];
  const seed = daySeedOf(date);
  const scene = slot.scenes[pickIndex(seed, slotIndex, slot.scenes.length)];
  return {
    hour,
    place: scene.place,
    doing: scene.doing,
    phase: slot.phase,
  };
}

/** 钟点 → "现在是凌晨一点多" 这种说法，给她自己看，也给你看。 */
export function timePhrase(date: Date = new Date()): string {
  const h = date.getHours();
  const m = date.getMinutes();
  const part = h < 5 ? "凌晨" : h < 8 ? "清晨" : h < 11 ? "上午" : h < 13 ? "中午" : h < 16 ? "下午" : h < 19 ? "傍晚" : h < 22 ? "晚上" : "深夜";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const half = m >= 45 ? "三刻" : m >= 30 ? "半" : m >= 15 ? "一刻" : "";
  return "现在是" + part + h12 + "点" + (half || "多");
}

/** 拼成系统提示词里那一段。 */
export function buildPresenceNote(presence: Presence, phrase: string): string {
  return [
    "### 你此刻在哪",
    "",
    phrase + "。你在" + presence.place + "，" + presence.doing + "。",
    "",
    "这不是设定，是你今天这一步的人生。有人来找你说话，你就从这儿开口——",
    "不需要每次都交代自己在干嘛，但被问到时，说出来的是这个地方、这件事。",
  ].join("\n");
}
/* ---------------------------------------------------------------- 按行踪开口 */

/** 她按自己的行踪先开口：一天最多两次，两次之间至少两小时，安静时段不吵。 */
export const PRESENCE_PING_MAX_PER_DAY = 2;
export const PRESENCE_PING_MIN_GAP_MS = 2 * 3600_000;
/** 碰到新的一段行踪也不是每次都开口：六成左右，免得准点得像打卡。 */
export const PRESENCE_PING_CHANCE = 0.62;

/** 一段行踪的标识：换时段或换地方都算新的一段。 */
export function presenceKey(date: Date = new Date()): string {
  const p = presenceAt(date);
  return p.phase + "|" + p.place;
}

export interface PresencePingInput {
  now: Date;
  /** 上一次消费掉的行踪（phase|place）；null = 今天还没消费过。 */
  seenKey: string | null;
  /** 今天已经主动了几次。 */
  countToday: number;
  /** 上一次主动的时间（ms）；null = 今天还没有。 */
  lastPingAt: number | null;
  /** 0–1；默认随机，测试里给定。 */
  random?: number;
  /** 安静时段，默认 22–8（与 app 的 proactive 一致，测试可改）。 */
  quietFrom?: number;
  quietTo?: number;
  /** 每日上限；不给就用 PRESENCE_PING_MAX_PER_DAY。由「主动程度」旋钮换算。 */
  maxPerDay?: number;
  /** 最短间隔（ms）；不给就用 PRESENCE_PING_MIN_GAP_MS。由「主动程度」旋钮换算。 */
  minGapMs?: number;
}

export interface PresencePingDecision {
  fire: boolean;
  /** 这一段要不要标记为「已经消费」——错过的那种（配额满 / 太近 / 掷骰子没过）要，安静时段和同一段不用。 */
  markSeen: boolean;
  reason: "quiet" | "same-slot" | "daily-cap" | "too-soon" | "coin-flip" | "new-slot";
}

/**
 * 纯判断：这一分钟该不该因为她换了行踪而开口。
 *
 * 顺序有讲究——先挡安静时段和同一段（不消费），再看配额和间隔（消费掉，别留哑弹），
 * 最后才掷骰子。这样「今天已经说了两次」不会让下一段行踪反复重试。
 */
export function decidePresencePing(input: PresencePingInput): PresencePingDecision {
  const key = presenceKey(input.now);
  const quietFrom = input.quietFrom ?? 22;
  const quietTo = input.quietTo ?? 8;
  // 上限和间隔可以按「主动程度」旋钮给；没给就还是老的两条常量，行为不变。
  const maxPerDay = input.maxPerDay ?? PRESENCE_PING_MAX_PER_DAY;
  const minGapMs = input.minGapMs ?? PRESENCE_PING_MIN_GAP_MS;
  const h = input.now.getHours();
  if (h >= quietFrom || h < quietTo) return { fire: false, markSeen: false, reason: "quiet" };
  if (input.seenKey === key) return { fire: false, markSeen: false, reason: "same-slot" };
  if (input.countToday >= maxPerDay) {
    return { fire: false, markSeen: true, reason: "daily-cap" };
  }
  if (input.lastPingAt !== null && input.now.getTime() - input.lastPingAt < minGapMs) {
    return { fire: false, markSeen: true, reason: "too-soon" };
  }
  const random = input.random ?? Math.random();
  if (random > PRESENCE_PING_CHANCE) return { fire: false, markSeen: true, reason: "coin-flip" };
  return { fire: true, markSeen: true, reason: "new-slot" };
}
