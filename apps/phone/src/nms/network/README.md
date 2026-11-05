# NMS 网络视图（apps/phone/src/nms/network）

> 状态：已接进 App —— `nms/NmsScreen.tsx:12` import 本目录的 `NetworkView`、`:153` 渲染，
> `App.tsx:1556` 挂 `NmsScreen`。数据源是手机端本地 store，不是桌面版的
> `/nms/api/snapshot`。

桌面参考实现：`dsh-neural-memory/src/client/index.js` 的 NetworkCanvas
（C:1069-1633）与 normalizeSnapshot（C:372-481）。本目录只取网络视图内核：
纯函数 + canvas effect + 外壳，不含 SSE / fetch / 宿主设置 / 演示数据。

## 1. 文件与职责

| 文件 | 职责 |
|---|---|
| `types.ts` | 数据契约：快照输入、画布节点/边/统计、激活事件与模型。 |
| `layout.ts` | `workspaceClusters` / `assignPositions` / `hashString` / `seededRng`；由 key 哈希生成确定性坐标，不写库。 |
| `normalize.ts` | 快照 → 画布数据：tier 过滤、0..n-1 连续索引、边端点 id→索引、`links/nb`、effectiveWeight、统计；另导出 `TIER_ORDER`、`countSnapshotTiers`、`ageDays`。 |
| `activation.ts` | 进程内激活：`createActivationStore`（seq 去重）+ `buildActivationModel`（5 跳 ×0.3、边强 ≥0.6）+ `collectActivationLevels` / `hasActiveActivation`（pulse/retain 时间衰减）。 |
| `network-canvas.tsx` | Canvas 2D 绘制与手势：3D 投影、LOD、选中、捏合缩放、点击命中、tooltip、dirty flag。 |
| `network-view.tsx` | 只做 network 视图的外壳：头部统计、tier chips、画布、节点详情卡；自带 `<style>`，不依赖也不能修改 `styles.css`。 |
| `README.md` | 本文件。 |

## 2. 数据契约

### 2.1 输入（快照）

`NetworkView` 的 `snapshot` 直接接受 `packages/nms` 的 `NmsSnapshot`（结构兼容）：

| 字段 | 说明 |
|---|---|
| `nodes[].id` | store 的原始节点 id（number）；画布内部会换成连续索引。 |
| `nodes[].tier` | `ep` / `sem` / `note`；也容忍 `episode` / `semantic` / `tone` 等旧拼写。 |
| `nodes[].workspace` | 手机端固定 `null`；非空时用作 ep 分簇名。 |
| `nodes[].title/gist/body` | 标题、速写、正文；`body` 可选，缺省时详情卡退回 gist。 |
| `nodes[].weight/effectiveWeight` | 基础权重 / 有效权重（store 算过就直接用，没算就按 lastRecallAt 现场衰减）。 |
| `nodes[].recalls/createdAt/lastRecallAt` | 详情卡与半衰期衰减。 |
| `nodes[].archived/forgotten` | 可选；为 true 的节点会被 normalize 丢掉。 |
| `edges[].a/b/strength` | a/b 是原始节点 id（store 保证 a<b）；strength 0..1。 |
| `stats.halfLifeDays` | 可选，默认 90 天；也兼容 `NmsStats` 的嵌套形状。 |

画布数据（`NmsCanvasData`）：

- `nodes[].id` 一定在 `0..n-1`，数组下标即 id；原始 id 在 `rawId`，选中键在 `key`
  （= `String(rawId)`）。
- `nodes[].links` 是邻接索引数组（激活 BFS 遍历它），`nodes[].nb` 是索引集合（画布用
  它 O(1) 判断选中节点的邻居）。
- `edges` 为 `{ a: number, b: number, s: number }`；端点被 tier 过滤掉的边整条丢弃，
  重复的 (a,b) 只保留一条。
- `stats.counts` 只统计过滤后的可见节点；头部 chips 的全量计数由 `countSnapshotTiers`
  单独从快照算。

### 2.2 激活事件（可选）

`nms_recall` 之后把命中的节点喂给同一个进程内的 store：

```ts
const activation = createActivationStore({
  enabled: true,       // 默认 true
  pulseMs: 2500,       // 300..20000
  retainMs: 30000,     // 0..300000
});

activation.ingest({
  seq: recallId,                    // 去重键；重放同一个 seq 不会亮第二次
  at: new Date().toISOString(),
  query: "用户在问什么",
  nodes: [{ id: node.id, activation: score }], // id 是 store 原始 id
});

<NetworkView snapshot={snapshot} activationStore={activation} />
```

- 每个事件按自身最大 activation 归一，种子最亮；沿关联图最多 5 跳，每跳 ×0.3，
  只走强度 ≥ 0.6 的边；低于 0.02 不再扩散。
- 亮度在 `pulseMs` 内从 1 降到 0.35，再在 `retainMs` 内淡到 0；画布在这段时间内
  以 30fps 重绘，结束后补一帧就停。
- `seq` 为 `null/undefined` 时不去重；`setSettings` 可热改开关/时长；
  `clear()` 清空当前事件。
- 测试或受控渲染可以直接给 `activationModel`（优先级高于 `activationStore`）。

## 3. 接入 App 需要改哪几处

1. **App 入口**：`apps/phone/src/App.tsx` 第 31 行一带加 `NetworkView` import；
   把 1258-1268 行现有的 `<GraphView …>` 换成 `<NetworkView …>`（或由新的
   NMS 页面挂载）。`showGraph` 这个开关可以沿用。
2. **快照来源**：在 `useNms` / 新的 NMS 页面里把 `await store.snapshot()` 放进
   React state，打开网络页、做完梦、recall 后刷新；不要把快照对象每次 render
   重新拼一个（组件已按 nodes/edges/stats 引用做 memo，但保持引用稳定更省）。
3. **激活 store**：在 App 或 NMS 页面层用 `useMemo(() => createActivationStore(), [])`
   建一个，recall 后 `ingest`；不要在网络视图 render 里新建，否则事件会丢。
4. **选中联动**：`onSelect(node | null)` 用来打开后续的 `NmsNodeViewer`；也可以
   传受控的 `selectedKey`。不传时组件自己管选中。
5. **safe-area**：网络视图默认自己处理顶部/底部 safe-area。放进已经带
   `padding: env(safe-area-inset-*)` 的 `.app` / `.viewer` 容器时传
   `safeArea={false}`，避免双层留白。
6. **样式**：不需要改 `styles.css`；`network-view.tsx` 会注入 `.nmsnet-*` 样式，
   颜色优先读现有 `--ink / --ink-soft / --muted / --line / --card / --accent`，
   读不到用内置浅色回退。列表/设置页可直接复用 `NMS_TIER_THEME`。
7. **列表 / 设置**：本目录不包含；由别的组件在同一个 NMS 页面里组合，网络视图
   不提供 tab 切换。

示例：

```tsx
import { useMemo, useState } from "react";
import { createActivationStore } from "./nms/network/activation.ts";
import { NetworkView } from "./nms/network/network-view.tsx";
import type { NmsSnapshot } from "@herta/nms";

const [snapshot, setSnapshot] = useState<NmsSnapshot | null>(null);
const [selectedKey, setSelectedKey] = useState<string | null>(null);
const activation = useMemo(() => createActivationStore(), []);

<NetworkView
  snapshot={snapshot}
  activationStore={activation}
  selectedKey={selectedKey}
  onSelect={(node) => setSelectedKey(node ? node.key : null)}
  onRefresh={() => void refreshSnapshot()}
  safeArea={false}
/>;
```

## 4. 移动端性能参数

都集中在 `network-canvas.tsx` 的 `NETWORK_CANVAS_LIMITS`，改一处即可：

| 参数 | 值 | 作用 |
|---|---|---|
| `dprCap` | 1.5 | 2.75x 屏压到 1.5x，画布是低频重绘，够清晰且省填充率。 |
| `targetFps` | 30 | 只有 dirty 时才画；静止时 0 帧，点亮期间 30fps。 |
| `lodNodeThreshold` | 80 | 可见节点超过 80 切精简视图。 |
| `lodTopLabels` | 8 | 精简视图只标最重的 8 个节点。 |
| `lodTopEdges` | 60 | 精简视图只画最强的 60 条边（选中节点的邻边强制保留）。 |
| `hitRadius` | 28 | 触摸命中半径（CSS px），比视觉半径大。 |
| `tapSlop` | 10 | 按下到抬起位移超过 10px 算拖动，不再当点击。 |
| `minZoom/maxZoom` | 0.6 / 2.4 | 双指捏合范围。 |

其它取舍：

- **默认关自转**（`autoRotate = false`）；打开后也要等 1.8s 没有交互才转。
- **LOD 降级**：不画 workspace 星云、非 top 节点不画径向辉光、标签不设
  `shadowBlur`；点亮/选中/邻居节点永远保留辉光。
- **背景交给 CSS**（渐变在 `.nmsnet-canvas-wrap`），canvas 每帧只 clear，不铺整屏
  径向渐变。
- **手势**：`touch-action: none` + pointer capture；单指旋转、双指捏合缩放、点按选中；
  长按菜单被 `contextmenu` 阻止。tooltip 只响应 `pointerType === "mouse"`，触摸不会
  留下悬停气泡。
- **safe-area**：详情卡、图例、提示用 `env(safe-area-inset-bottom)`；可用
  `safeArea={false}` 关掉。

## 5. 与桌面版的差异

- 不 fetch、不接 SSE：召回与画布在同一 JS 进程，直接 `ingest`；没有 Tab 隐藏缓冲、
  补播、unread 角标。
- 没有宿主设置接口：`enabled/pulseMs/retainMs` 由调用方传 `createActivationStore`
  或 `setSettings`；没有 `/nms/api/settings` 的读写。
- 没有演示语料 / mock：空快照显示空态。
- 不用 `--dsw-*` 宿主 token：改用 App 现有 CSS 变量 + 内置回退；桌面深色画布在这里
  换成 App 的浅色画布。
- 布局仍是 3D 投影 + 旋转/缩放，但手机只有单 workspace，ep 会聚成一个「工作区」簇；
  workspace 名只在宽度 > 600px 时画。
- 指针交互从「拖拽旋转 + 滚轮缩放」补成「单指旋转 + 双指捏合」；点击阈值 10px、
  命中半径 28px（桌面是 5px / 20px）。
- 画布只做 network 视图；列表/设置/详情页由别处组合。详情卡由 `NetworkView` 自己
  渲染，不接受桌面那种 `compact` 侧栏布局（`compact` 只隐藏副标题/chips/图例/提示/tooltip）。
- 激活点亮保留桌面语义（seq 去重、5 跳、0.3、0.6 边强、两段衰减），但事件不再跨
  Tab 存活；进程重启即清空。

## 6. 验证与未完成

- `node node_modules/typescript/bin/tsc -p apps/phone/tsconfig.json --noEmit` 通过
  （strict + erasableSyntaxOnly + verbatimModuleSyntax）。
- 纯函数已做过一次性脚本校验：tier 过滤/连续索引/边丢弃/links/nb/有效权重/布局
  确定性；激活 seq 去重、0.3^hop、0.6 边强截断、0.35 脉冲尾巴。
- **未完成**：未在 Android WebView 真机跑过，画布视觉与帧率需要真机确认；没有提交
  测试文件。（已挂进 App 入口，2026-11-04 更正）
- 后续若要在列表里也展示有效权重，直接复用 `normalize.ts` 的 `effectiveWeight` /
  `ageDays` / `countSnapshotTiers`，不要复制公式。
