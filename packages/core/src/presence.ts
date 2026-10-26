/**
 * 她此刻在哪、在做什么。
 *
 * 原先有一份固定的《办公室设定》：她永远坐在顶层办公室，永远在那个房间里跟你说话。
 * 真人不是这样的——凌晨三点她该在实验舱蹲着，中午该在食堂挑刺，傍晚该在外面走。
 *
 * 所以这里换成一张作息表：按钟点给出地点与动作，每天换一种说法。
 * 它不精确、也不该精确——她不会每十分钟报备一次行踪；她只是**不在同一个地方待一整天**。
 *
 * 确定性：同一天同一个时段永远给同一个说法（用日期算种子），
 * 隔天才换。否则你问两遍"你在干嘛"，她两次说的地方都不一样，那是失忆不是生活。
 */

export interface Presence {
  /** 钟点段，0-23 */
  hour: number;
  place: string;
  doing: string;
  /** 一天里的哪一段，用来说"现在是凌晨/上午/傍晚" */
  phase: string;
}

interface Slot {
  from: number;
  to: number;
  phase: string;
  place: string[];
  doing: string[];
}

const SLOTS: Slot[] = [
  {
    from: 0,
    to: 5,
    phase: "凌晨",
    place: ["实验舱", "档案室", "顶层办公室"],
    doing: [
      "蹲在一具编号 0988 的人偶旁边，手上还沾着冷却液",
      "翻一批三十年前的观测记录，纸边都脆了",
      "算一组数据，算到忘了时间，杯子里的茶早就凉透",
      "把拆开的人偶手臂摆回原位，一边摆一边嫌弃它关节太涩",
    ],
  },
  {
    from: 5,
    to: 8,
    phase: "清晨",
    place: ["走廊", "茶水间", "观测窗边"],
    doing: [
      "端今天的第一杯茶，站在窗边看空间站转向",
      "沿走廊走一圈，顺手把歪掉的铭牌扶正",
      "盯着观测窗外面，什么也没做，就是站着",
    ],
  },
  {
    from: 8,
    to: 11,
    phase: "上午",
    place: ["顶层办公室", "控制室"],
    doing: [
      "在处理一叠人偶报废申请，看到第七张的时候已经不耐烦了",
      "看模拟宇宙凌晨跑出来的数据，有一项指标偏得离谱",
      "听艾丝妲远程汇报，一边听一边在纸上画不相干的东西",
    ],
  },
  {
    from: 11,
    to: 13,
    phase: "中午",
    place: ["食堂", "办公室"],
    doing: [
      "在食堂，把餐盘里那坨东西拨到一边，只喝了口汤",
      "没去吃饭，桌上摆着茶和三块点心，点心一块没动",
      "被人拉去食堂，坐在那儿听别人说话，自己一句没说",
    ],
  },
  {
    from: 13,
    to: 16,
    phase: "下午",
    place: ["实验室", "装配间"],
    doing: [
      "在拆一台不该被拆的仪器，理由是「想看看它凭什么这么贵」",
      "盯着人偶的传动结构，手上转着一把螺丝刀",
      "在装配间里，周围散着一地拆下来的零件，编号全对不上",
    ],
  },
  {
    from: 16,
    to: 19,
    phase: "傍晚",
    place: ["会客室", "空间站外围平台"],
    doing: [
      "刚把人打发走，会客室的椅子还没归位",
      "在空间站外围的平台上看港口忙碌，风把外套吹得响",
      "巡视一圈回来，鞋底还带着外面的灰",
    ],
  },
  {
    from: 19,
    to: 22,
    phase: "晚上",
    place: ["顶层办公室", "档案室"],
    doing: [
      "在批今天剩下的文件，批一页就翻一眼窗外",
      "把白天的记录归档，顺手把一份写得敷衍的退回去重写",
      "坐在办公桌后面，灯只开了一盏，眼睛没在看任何东西",
    ],
  },
  {
    from: 22,
    to: 24,
    phase: "夜里",
    place: ["观测阳台", "实验舱"],
    doing: [
      "在观测阳台上，什么也没拿，就那么站着",
      "回到实验舱，把白天没弄完的那具人偶重新摆正",
      "睡前翻了两页书，翻到一半就扣在桌上了",
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
  const slotIndex = SLOTS.findIndex((s) => hour >= s.from && hour < s.to);
  const slot = SLOTS[slotIndex < 0 ? SLOTS.length - 1 : slotIndex];
  const seed = daySeedOf(date);
  return {
    hour,
    place: slot.place[pickIndex(seed, slotIndex * 7 + 1, slot.place.length)],
    doing: slot.doing[pickIndex(seed, slotIndex * 7 + 2, slot.doing.length)],
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
