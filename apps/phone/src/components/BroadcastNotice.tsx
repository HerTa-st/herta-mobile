/**
 * 聊天里的「播报提示」。
 *
 * 它不是一个对话气泡：那是她递过来的一份东西，用户扫一眼就去播报页看。
 * 所以做成一张带左侧色条的转播卡 —— 和她说出口的话（白气泡）明确分开；
 * 她自己的转录里也不再算「我 说」（见 core/tags.ts 的序列化）。
 */

export interface BroadcastNoticeProps {
  /** 第几期。 */
  no: number;
  /** 这一期几条；拿不到就不显示。 */
  count?: number;
  text: string;
  onOpen(): void;
}

export function BroadcastNotice({ no, count, text, onOpen }: BroadcastNoticeProps) {
  return (
    <article className="bcastNotice">
      <div className="bcastNoticeHead">
        <span className="bcastNoticeLabel">星际和平播报</span>
        <span className="bcastNoticeNo">第 {no} 期</span>
        {typeof count === "number" && count > 0 && <span className="bcastNoticeCount">{count} 条</span>}
      </div>
      <p className="bcastNoticeText">{text}</p>
      <button type="button" className="bcastNoticeOpen" onClick={onOpen}>
        查看播报
        <span aria-hidden="true"> →</span>
      </button>
    </article>
  );
}
