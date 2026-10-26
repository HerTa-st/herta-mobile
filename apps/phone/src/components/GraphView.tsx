import { MemoryGraph, type GraphEdge, type GraphNode } from "../MemoryGraph.tsx";

/** 记忆星图的全屏视图。物理与手势都在 MemoryGraph 里。 */
export function GraphView({
  nodes,
  edges,
  onOpen,
  onClose,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onOpen(name: string): void;
  onClose(): void;
}) {
  return (
    <div className="viewer graph" role="dialog" aria-label="记忆星图">
      <header className="vh">
        <span className="vt">记忆星图 · {nodes.length} 条</span>
        <button className="vx" onClick={onClose}>
          关闭
        </button>
      </header>
      <MemoryGraph nodes={nodes} edges={edges} onOpen={onOpen} />
      <p className="glegend">
        圆越大 = 权重越高。线 = 她自己串的关联。拖动会拉开，松手会荡回去；双指缩放，空白处拖动平移；点圆看全文。
      </p>
    </div>
  );
}
