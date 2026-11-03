---
status: accepted
---

# 手机端记忆内核换成 NMS：Capacitor SQLite 异步 store + 全量 UI

手机端原记忆是「废案文件名 + MemoryRecord + 权重/整理/遗忘」，和 DSH 端 NMS 的 ep/sem/note 三级 + 带权联想图 + 浅睡/深睡是两套语义。长期维护两套后端会让「她到底记得什么」有两个答案，因此选择**替换**：新建 packages/nms 移植 NMS 内核，手机端唯一写方改为 NMS；旧 MemoryRecord 只做一次性迁移源与只读回滚快照。

存储选择 Capacitor SQLite 原生插件（@capacitor-community/sqlite 8.1.1，兼容 Capacitor 8）：保留 NMS 的 SQL/schema/事务语义，避免把 1,436 行 store 重写成 IndexedDB；代价是原生桥异步，NMS store 的 43 个方法与约 124 处调用要 async 化，turn-stopping 写入改为排队。拒绝 sql.js WASM（包体/强杀丢写入）与 IndexedDB 适配（改写量最大、事务/索引语义要手写）。

UI 全量重做：列表/节点详情/设置用手机原生组件；网络视图移植桌面 NMS 的 canvas 3D/LOD/激活，数据源改为本地 store snapshot，不依赖 /nms/api/EventSource。迁移采用首启一次性 + 旧 IndexedDB 只读保留；4 篇种子→note、自造废案→ep，旧 links→assoc 边，weight/recalls/时间/forgotten 保留。语气冻结：保留 DreamState.voice 供 persona 注入，不移植 NMS 自动语气（Q4）。浅睡常跑；深睡 opportunistic，复用 HertaKeeperService + JS 计时，cap 8 次/晚；不用 WorkManager（native worker 跑不了 JS/读不到 localStorage key）。

## Considered Options

- **并行双后端（shelf/nms 可切）**：回退容易；但两套记忆/UI/迁移长期背着，和「替换」目标冲突。
- **只增强现有 MemoryRecord**：改动小；但不是完整 NMS，三级/深睡/语义化仍然没有。
- **只搬 NMS 上层（自动语气等）**：最省；但记忆内核不变，问题没解决。
- **sql.js WASM**：保留同步 SQL；包体 +1–2MB、强杀可能丢最后几秒写入。
- **IndexedDB 适配**：零原生依赖；NMS store 整层异步重写、事务/索引语义手写，工作量最大。
- **WorkManager 原生后台**：真后台；但 native worker 没有 WebView/JS/API key，需自研 headless WebView。
- **搬 NMS 宿主壳（tools/plugin/agent-scope）**：最完整；手机没有 DSH，属于背壳。

## Consequences

- 手机端新增原生 SQLite 依赖与 Android 构建配置；APK 体积增加。
- NMS 内核 124 处调用 async 化；现有手机端零测试，需要为 packages/nms 建测试与手测清单。
- 旧记忆迁移失败时可用旧库只读回退；迁移完成前旧 UI/dream/consolidate 不能再写，需在启动流程里切换。
- 语气不再自动演化（Q4 冻结）；等记忆内核稳定后再决定是否移植 NMS 自动语气。
- 深睡依赖 WebView 存活（HertaKeeperService）；服务关闭/系统杀进程时不保证。
- 桌面网络视图 2793 行移植移动端，canvas 性能与触摸交互需要实测；先保 LOD/降采样。
