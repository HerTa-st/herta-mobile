import { useSyncExternalStore } from "react";
import { getUpdateSnapshot, subscribeUpdate, type UpdateSnapshot } from "../update/store.ts";

/** 设置页与更新页共用这一份状态：谁都不会自己再发一次请求。 */
export function useUpdate(): UpdateSnapshot {
  return useSyncExternalStore(subscribeUpdate, getUpdateSnapshot, getUpdateSnapshot);
}
