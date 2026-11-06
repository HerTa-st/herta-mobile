import { useEffect, useState } from "react";
import { readUsage, subscribeUsage, type UsageDay } from "../usage-ledger.ts";

/**
 * 今天这一页用量，跟着账本一起变。
 *
 * 设置里那行和明细页共用它：账本一写就 notify，两边同时刷新——
 * 不然在明细页看完回设置，那行还停在打开设置时的数字。
 */
export function useUsageToday(): UsageDay {
  const [day, setDay] = useState<UsageDay>(() => readUsage());
  useEffect(() => subscribeUsage(() => setDay(readUsage())), []);
  return day;
}
