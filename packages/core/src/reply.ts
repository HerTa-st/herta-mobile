/**
 * 她要不要接这句话、隔多久接。
 *
 * 三条常识：
 *   1. **她不是客服**。有些话可以不接——尤其是你已经在收尾的那一句（"那睡了""好"）。
 *      每句都回会让她变成自动应答机，傲娇也就不成立了。
 *   2. **关系越好，回得越快、越少冷场**。这是用户要的"聊久了延迟变小"，
 *      所以延迟与冷场概率都从 bond 里读，而不是写死。
 *   3. **问了问题就必须答**。这是底线：不接话可以，装没听见不行。
 *
 * 这里只算决策，不发请求、不睡——睡眠在调用方（回合层）做，才测得了。
 */

export interface BondInput {
  /** 这个会话里已经有多少块（聊得越久越多）。 */
  blocks: number;
  /** 记忆库有多少篇（她记住你的东西越多，关系越近）。 */
  memories: number;
  /** 认识多少天。 */
  days: number;
}

/**
 * 好感度 0~1。
 *
 * 三样加权：聊过多少（占一半）、记住多少（三成）、认识多久（两成）。
 * 数字是拍的，但方向不能反——后面的"延迟变小"全靠它。
 */
export function bondLevel(input: BondInput): number {
  const talk = Math.min(1, Math.max(0, input.blocks / 160));
  const mem = Math.min(1, Math.max(0, input.memories / 24));
  const time = Math.min(1, Math.max(0, input.days / 45));
  const score = talk * 0.5 + mem * 0.3 + time * 0.2;
  return Math.min(1, Math.max(0, score));
}

/** 收尾的话：这类最容易"以我为结束"。 */
const CLOSING_WORDS = [
  "嗯",
  "哦",
  "好",
  "好的",
  "行",
  "可以",
  "睡了",
  "去睡了",
  "晚安",
  "拜拜",
  "再见",
  "回头聊",
  "先这样",
  "谢谢",
  "明白了",
  "知道了",
  "懂了",
  "收到",
  "ok",
];

/** 这些话前面的字：有它才像"接上一句收尾"，没有就只是碰巧以这个字结尾（"今天很好"）。 */
const BEFORE_OK = /[了啊呀啦哦嘛吧呢，、.\s]$/;

/** 问句：这些必须回。 */
const QUESTION = /[？?]|(吗|呢|么|怎么|为什么|为啥|什么|几点|多少|哪儿|哪里|谁|是不是|能不能|可不可以)[。！？~…\s]*$/;

export function isClosing(text: string): boolean {
  // 先把尾巴上的标点剥掉："好。" 和 "好" 是同一句
  const t = String(text ?? "")
    .replace(/[。！？~…!?.,\s]+$/g, "")
    .trim();
  if (!t || t.length > 24) return false;
  // "嗯嗯嗯" / "哦哦" 这种整句就是语气词
  if (/^[嗯哦啊呀]+$/.test(t)) return true;
  for (const w of CLOSING_WORDS) {
    if (!t.toLowerCase().endsWith(w)) continue;
    const before = t.slice(0, t.length - w.length);
    if (before === "" || BEFORE_OK.test(before)) return true;
  }
  return false;
}

export function isQuestion(text: string): boolean {
  return QUESTION.test(String(text ?? "").trim());
}

/** 从创建时间算到今天几天（未满一天算 0）。 */
export function daysSince(iso: string | undefined, now: number = Date.now()): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

export interface ReplyInput {
  text: string;
  /** 0~1，见 bondLevel。 */
  bond: number;
  /** 换测试用。 */
  random?: () => number;
}

export interface ReplyDecision {
  /** 这一轮要不要说话。false = 不接话，只留你那句。 */
  reply: boolean;
  /** 说话之前先沉默多久。 */
  delayMs: number;
  /** 一句人话，给记录/调试看。 */
  reason: string;
}

/**
 * 决定接不接、多久接。
 *
 * 延迟随关系缩短：0 关系时 2.5~9 秒（像刚认识，要想一下再回），
 * 关系满了是 0.9~3 秒。冷场概率同理：0 关系下收尾句有 55% 不接，
 * 关系满了只剩 10%。
 */
export function decideReply(input: ReplyInput): ReplyDecision {
  const rnd = input.random ?? Math.random;
  const bond = Math.min(1, Math.max(0, input.bond));
  const text = String(input.text ?? "").trim();

  if (isQuestion(text)) {
    return { reply: true, delayMs: delayFor(bond, rnd) * 0.6, reason: "问句，必答" };
  }

  const closing = isClosing(text);
  const skipChance = closing ? 0.55 - 0.45 * bond : 0.15 * (1 - bond);
  if (rnd() < skipChance) {
    return {
      reply: false,
      delayMs: 0,
      reason: closing ? "他这句是收尾，她不接" : "这句可以不接",
    };
  }

  return {
    reply: true,
    delayMs: delayFor(bond, rnd),
    reason: closing ? "收尾句，但她还是接了" : "正常接话",
  };
}

function delayFor(bond: number, rnd: () => number): number {
  const slowest = 9000 - 6200 * bond;
  const fastest = 2500 - 1600 * bond;
  const base = fastest + (slowest - fastest) * rnd();
  // 再加一点抖动：真实的人不会每次都隔一样的秒数
  return Math.round(base + rnd() * 1200);
}
