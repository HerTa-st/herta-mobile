/**
 * 这一轮花了多少 token。
 *
 * 徽章只占一行：总数（"4.1M tok"）。点一下展开输入 / 输出 / 缓存 / 调用次数——
 * 数字不对劲时（比如复核连着打回两次），这四个数比一个总数有用得多。
 *
 * 数字来自接口的 usage 回执，不是本地估的：判心情、主对话（含工具轮）、复核、
 * 重说各算一次请求，全加起来。老会话没有这个字段，就不显示。
 */
import { useState } from "react";
import type { TokenUsage } from "@herta/protocol";
import { formatTokens, usageTotal } from "@herta/core";

export function UsageChip({ usage }: { usage: TokenUsage }) {
  const [open, setOpen] = useState(false);
  const detail = [
    "输入 " + formatTokens(usage.prompt),
    "输出 " + formatTokens(usage.completion),
    ...((usage.cached ?? 0) > 0 ? ["缓存命中 " + formatTokens(usage.cached ?? 0)] : []),
    ...((usage.calls ?? 0) > 0 ? [(usage.calls ?? 0) + " 次调用"] : []),
  ].join(" · ");

  return (
    <div className="usageRow">
      <button
        type="button"
        className="usageChip"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="这一轮花掉的 token"
      >
        <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
          <ellipse cx="12" cy="5.5" rx="7" ry="2.8" />
          <path d="M5 5.5v6c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8v-6" />
          <path d="M5 11.5v6c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8v-6" />
        </svg>
        <span>{formatTokens(usageTotal(usage))} tok</span>
      </button>
      {open && <span className="usageDetail">{detail}</span>}
    </div>
  );
}
