/**
 * B5 · 记忆网络全屏页。
 *
 * 记忆页顶上那个 236px 小窗点「看全图」进到这里：满屏 NetworkView（非 compact）、
 * 顶部 chips 四选一（全部 / ep / sem / note）、点节点从底部浮详情卡（图不消失）。
 *
 * 正文的坑：NmsStore.snapshot() 不带 body（只有 gist，约 60 字），所以选中节点后
 * 走 controller 的单例 store 的 getNode(rawId) 现取一次正文，取不到就退回 gist。
 * Web 开发环境没有 SQLite，getNmsStore() 会抛错，这里静默退回，不挡图。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { NmsSnapshot } from "@herta/nms";
import { getNmsStore } from "./controller.ts";
import type { NmsActivationStore } from "./network/activation.ts";
import { NetworkView } from "./network/network-view.tsx";
import type { NmsCanvasNode } from "./network/types.ts";

const GRAPH_CSS = `
.nmsgraph {
  position: fixed;
  inset: 0;
  z-index: 45;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: linear-gradient(165deg, #f7fbfb 0%, #eef6f7 100%);
  color: var(--ink, #2f3a45);
}
.nmsgraph > * {
  flex: 1 1 auto;
  min-height: 0;
}
`;

export interface GraphScreenProps {
  snapshot: NmsSnapshot | null;
  activationStore: NmsActivationStore;
  onRefresh(): void;
  onClose(): void;
}

export function GraphScreen({ snapshot, activationStore, onRefresh, onClose }: GraphScreenProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailBody, setDetailBody] = useState<string | null>(null);
  /** 连点两个节点时，晚回来的那次正文不能盖掉新的。 */
  const requestSeq = useRef(0);

  const handleSelect = useCallback((node: NmsCanvasNode | null) => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setSelectedKey(node ? node.key : null);
    setDetailBody(null);
    if (!node) return;
    const rawId = typeof node.rawId === "number" ? node.rawId : Number(node.rawId);
    if (!Number.isFinite(rawId)) return;
    void getNmsStore()
      .then((store) => store.getNode(rawId))
      .then((record) => {
        if (requestSeq.current !== seq) return;
        const body = record && typeof record.body === "string" ? record.body : "";
        if (body.length > 0) setDetailBody(body);
      })
      .catch(() => {
        /* Web / 非原生：没有 SQLite，详情卡退回节点的 gist */
      });
  }, []);

  // 离开这一页时作废还在路上的请求。
  useEffect(
    () => () => {
      requestSeq.current += 1;
    },
    [],
  );

  return (
    <div className="nmsgraph" role="dialog" aria-label="记忆网络全屏">
      <style>{GRAPH_CSS}</style>
      <NetworkView
        snapshot={snapshot}
        activationStore={activationStore}
        selectedKey={selectedKey}
        onSelect={handleSelect}
        onRefresh={onRefresh}
        onClose={onClose}
        tierMode="single"
        detailMode="full"
        detailBody={detailBody}
        title="记忆网络"
      />
    </div>
  );
}
