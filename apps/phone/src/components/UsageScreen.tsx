import { formatTokens, usageTotal } from "@herta/core";
import { useUsageToday } from "../hooks/useUsageToday.ts";
import { USAGE_LABELS, USAGE_SOURCES } from "../usage-ledger.ts";
import "../styles/settings-suite.css";
import "../styles/usage.css";

const ICON = {
  back: "M15 6l-6 6 6 6",
  close: "M6 6l12 12M18 6L6 18",
} as const;

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

/**
 * 今日用量。
 *
 * 为什么单独一页、还非要分链路：复核那一段 system 两万多字符、每轮重发，
 * 单轮成本的一半以上在它身上——只给一个总数，这个事实永远看不见。
 * 后台的深睡、自动语气、播报也照实记，藏起来这个数字就不真。
 *
 * 不折算成钱：要填单价，还要处理缓存命中价，先给你硬事实。
 */
export function UsageScreen({ onClose }: { onClose(): void }) {
  const day = useUsageToday();
  const total = day.prompt + day.completion;
  const rows = USAGE_SOURCES.map((source) => ({ source, row: day.rows[source] })).filter(
    ({ row }) => row.calls > 0
  );

  return (
    <div className="ss-page" data-part="panel" role="dialog" aria-label="今日用量">
      <header className="ss-top">
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="返回">
          <Icon d={ICON.back} size={18} />
        </button>
        <div className="ss-title">
          <b>今日用量</b>
          <span>按本地自然日 · 过零点清零</span>
        </div>
        <span className="ss-badge">
          <i />
          {day.calls > 0 ? formatTokens(total) + " tok" : "今天还没有"}
        </span>
        <button type="button" className="ss-iconBtn" onClick={onClose} aria-label="关闭">
          <Icon d={ICON.close} size={16} />
        </button>
      </header>

      <div className="ss-body">
        <section className="ss-card us-totalCard">
          <div className="ss-kicker">TODAY · {day.date}</div>
          <div className="us-total">
            <div>
              <small>输入</small>
              <b>{formatTokens(day.prompt)}</b>
            </div>
            <div>
              <small>输出</small>
              <b>{formatTokens(day.completion)}</b>
            </div>
            <div>
              <small>请求</small>
              <b>{day.calls}</b>
            </div>
          </div>
          <p className="us-totalNote">
            {day.cached > 0
              ? "其中输入有 " + formatTokens(day.cached) + " 走了缓存命中。"
              : "数字来自接口的 usage 回执，不是本地估的。"}
          </p>
        </section>

        <section className="ss-card us-listCard">
          <div className="ss-groupHead">
            <span>分链路</span>
            <span>{rows.length} 条在动</span>
          </div>
          {rows.length === 0 ? (
            <p className="us-empty" data-part="empty-state">
              今天还没有调用记录。说一句话、让它跑一次深睡或生成一期播报，这里就会多一行。
            </p>
          ) : (
            <div className="us-list">
              {rows.map(({ source, row }) => {
                const rowTotal = row.prompt + row.completion;
                const share = total > 0 ? Math.round((rowTotal / total) * 100) : 0;
                return (
                  <div className="us-row" key={source}>
                    <div className="us-rowTop">
                      <span className="us-rowName">
                        {USAGE_LABELS[source]}
                        <em>{row.calls} 次</em>
                      </span>
                      <span className="us-rowNum">
                        入 {formatTokens(row.prompt)} · 出 {formatTokens(row.completion)}
                      </span>
                    </div>
                    <div className="us-bar" aria-hidden="true">
                      <i style={{ width: Math.max(2, share) + "%" }} />
                    </div>
                    <div className="us-rowShare">{share}%</div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <p className="ss-hint">
          全算，含后台：深睡、自动语气、播报这些你不看着的时候也在花钱，所以它们也进这张表。播报里联网搜的那一段走的是{" "}
          <code>/v1/tools/search</code>，那个端点不回 usage 回执——这部分统计不到，别把它当成「今天只花了这么点」。
        </p>
        <p className="ss-hint">
          一共 {usageTotal({ prompt: day.prompt, completion: day.completion, cached: day.cached, calls: day.calls })} tok。
          不折算成金额：要填单价、还要处理缓存命中价，先给硬事实。
        </p>
      </div>
    </div>
  );
}
