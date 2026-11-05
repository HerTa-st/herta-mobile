/**
 * 成就：20 条目录 + 纯判定函数（B7）。
 *
 * 这里只放**判断规则**，不碰存储、不碰网络：
 *   - 单机钱包把已解锁 id 存在 wallet.achievements；
 *   - 共享市场把同样 20 条存在服务端 user.achievements（market-v2.js 镜像同一份目录）。
 *
 * 条件口径：计数器来自 stats（签到 / 交易 / 手续费 / 成交量），资产类实时算
 * （净资产 = 现金 + 持仓市值；单机没有现金，netWorth = holdings × price）。
 * “首次爆仓 / 破产”B7 先占位（bankruptCount 默认 0），B8 允许负余额后自然会点亮。
 */

import type { CoinAchievementStats, CoinWallet } from "./types.ts";

/** 判定快照：计数器 + 当前资产 + 几个一次性状态。 */
export interface AchievementSnapshot extends CoinAchievementStats {
  /** 净资产 = 现金 + 持仓市值（单机 = holdings × price）。 */
  netWorth: number;
  htc: number;
  usdt: number;
  merged: boolean;
  bankruptCount: number;
}

export type AchievementGroup = "签到" | "交易" | "资产" | "历程";

export interface CoinAchievement {
  id: string;
  title: string;
  desc: string;
  group: AchievementGroup;
  /** 达到这个值就解锁。 */
  target: number;
  /** 从快照算当前进度。 */
  value(snapshot: AchievementSnapshot): number;
}

/** 20 条成就的唯一目录。顺序就是界面展示顺序。 */
export const ACHIEVEMENTS: readonly CoinAchievement[] = [
  {
    id: "first_signin",
    title: "初次打卡",
    desc: "完成第一次签到",
    group: "签到",
    target: 1,
    value: (s) => s.signins,
  },
  {
    id: "signin_10",
    title: "打卡十次",
    desc: "累计签到 10 次",
    group: "签到",
    target: 10,
    value: (s) => s.signins,
  },
  {
    id: "signin_50",
    title: "打卡五十次",
    desc: "累计签到 50 次",
    group: "签到",
    target: 50,
    value: (s) => s.signins,
  },
  {
    id: "streak_3",
    title: "三日不辍",
    desc: "连续签到 3 天",
    group: "签到",
    target: 3,
    value: (s) => s.maxStreak,
  },
  {
    id: "streak_7",
    title: "七日例行",
    desc: "连续签到 7 天，开始拿 +5%",
    group: "签到",
    target: 7,
    value: (s) => s.maxStreak,
  },
  {
    id: "streak_30",
    title: "满月值守",
    desc: "连续签到 30 天",
    group: "签到",
    target: 30,
    value: (s) => s.maxStreak,
  },
  {
    id: "reward_500",
    title: "积少成多",
    desc: "累计签到奖励达到 500 HTC",
    group: "签到",
    target: 500,
    value: (s) => s.totalReward,
  },
  {
    id: "first_trade",
    title: "第一笔成交",
    desc: "完成第一次买卖",
    group: "交易",
    target: 1,
    value: (s) => s.trades,
  },
  {
    id: "first_buy",
    title: "建仓",
    desc: "完成第一次买入",
    group: "交易",
    target: 1,
    value: (s) => s.buys,
  },
  {
    id: "first_sell",
    title: "落袋",
    desc: "完成第一次卖出",
    group: "交易",
    target: 1,
    value: (s) => s.sells,
  },
  {
    id: "trade_10",
    title: "手熟",
    desc: "累计交易 10 次",
    group: "交易",
    target: 10,
    value: (s) => s.trades,
  },
  {
    id: "trade_50",
    title: "常客",
    desc: "累计交易 50 次",
    group: "交易",
    target: 50,
    value: (s) => s.trades,
  },
  {
    id: "volume_10000",
    title: "万币过手",
    desc: "累计成交 10,000 HTC",
    group: "交易",
    target: 10000,
    value: (s) => s.volume,
  },
  {
    id: "fee_100",
    title: "手续费常客",
    desc: "累计手续费达到 100 信用点",
    group: "交易",
    target: 100,
    value: (s) => s.fees,
  },
  {
    id: "networth_250k",
    title: "小有资产",
    desc: "净资产达到 250,000 信用点",
    group: "资产",
    target: 250000,
    value: (s) => s.netWorth,
  },
  {
    id: "htc_2000",
    title: "持仓两千",
    desc: "持有 2,000 HTC",
    group: "资产",
    target: 2000,
    value: (s) => s.htc,
  },
  {
    id: "htc_5000",
    title: "持仓五千",
    desc: "持有 5,000 HTC",
    group: "资产",
    target: 5000,
    value: (s) => s.htc,
  },
  {
    id: "usdt_200k",
    title: "现金二十万",
    desc: "信用点余额达到 200,000",
    group: "资产",
    target: 200000,
    value: (s) => s.usdt,
  },
  {
    id: "merged",
    title: "搬家完成",
    desc: "把单机钱包并进共享市场",
    group: "历程",
    target: 1,
    value: (s) => (s.merged ? 1 : 0),
  },
  {
    id: "first_bankrupt",
    title: "破产初体验",
    desc: "第一次破产（B8 起可解锁）",
    group: "历程",
    target: 1,
    value: (s) => s.bankruptCount,
  },
];

/** 全 0 的计数器，老钱包 / 老服务端缺字段时用。 */
export function emptyAchievementStats(): CoinAchievementStats {
  return {
    signins: 0,
    maxStreak: 0,
    totalReward: 0,
    trades: 0,
    buys: 0,
    sells: 0,
    volume: 0,
    fees: 0,
  };
}

/** 单机钱包快照：没有信用点现金，净资产 = 持仓 × 现价。 */
export function snapshotFromWallet(wallet: CoinWallet, price: number): AchievementSnapshot {
  const stats = { ...emptyAchievementStats(), ...(wallet.stats ?? {}) };
  const holdings = Number.isFinite(wallet.holdings) ? wallet.holdings : 0;
  const p = Number.isFinite(price) ? price : 0;
  return {
    ...stats,
    netWorth: holdings * p,
    htc: holdings,
    usdt: 0,
    merged: false,
    bankruptCount: wallet.bankruptCount ?? 0,
  };
}

/** 当前快照下应该解锁的全部 id（按目录顺序）。 */
export function unlockedAchievementIds(snapshot: AchievementSnapshot): string[] {
  return ACHIEVEMENTS.filter((item) => item.value(snapshot) >= item.target).map((item) => item.id);
}

/** 把新解锁的 id 并进已有列表；返回按目录顺序去重后的完整列表。 */
export function mergeAchievementIds(
  existing: readonly string[] | undefined,
  snapshot: AchievementSnapshot
): string[] {
  const have = new Set(existing ?? []);
  for (const id of unlockedAchievementIds(snapshot)) have.add(id);
  return ACHIEVEMENTS.filter((item) => have.has(item.id)).map((item) => item.id);
}

/** 单条成就的展示进度。 */
export function achievementProgress(
  id: string,
  snapshot: AchievementSnapshot
): { value: number; target: number; unlocked: boolean; ratio: number } {
  const item = ACHIEVEMENTS.find((a) => a.id === id);
  if (!item) return { value: 0, target: 1, unlocked: false, ratio: 0 };
  const raw = item.value(snapshot);
  const value = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const ratio = item.target > 0 ? Math.min(1, value / item.target) : 1;
  return { value, target: item.target, unlocked: value >= item.target, ratio };
}
