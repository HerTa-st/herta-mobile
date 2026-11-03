# NMS 移植进手机端 · 设计

> 状态：**已实现并打出 debug APK（2026-11-02）**。P1 内核/存储/迁移/基础 UI + P2 桌面网络视图均已接线；真机运行验证待做（见 §11）。
> 决策记录见 ADR-0001-nms-kernel-on-mobile.md。
> 本文件只记手机端移植；NMS 宿主插件本身的领域定义见 dsh-neural-memory 的 CONTEXT.md。

## 0. 一句话

手机端放弃现有「废案 + 权重/整理/遗忘」的扁平记忆，改成 **NMS 移动内核**：ep/sem/note 三级 + 带权联想图 + 浅睡/深睡代谢；存储用 **Capacitor SQLite 原生异步 store**，旧 IndexedDB 记忆一次性迁移，UI 全量重做（列表/设置手机原生，网络视图搬桌面 NMS）。

## 1. 范围

**做**

- 新建 packages/nms：NMS 记忆内核的 TypeScript 移植（store 接口 + SQLite 实现 + model + 浅睡/深睡 + 召回/快照 + 迁移）。
- 手机端唯一的记忆写方：聊天回合写入 pending_turns，深睡从 pending 生成 ep，语义化出 sem，note 来自 4 篇种子。
- 旧 IndexedDB 记忆一次性迁移；旧库只读保留一版。
- 全量 UI：NMS 列表/节点详情/设置（手机原生），网络视图（桌面 NMS canvas 3D/LOD/激活适配）。
- 备份 v2：SQLite 导出 + 冻结语气；旧备份导入自动迁移。
- 浅睡常跑；深睡 opportunistic（HertaKeeperService 保活 + JS 计时；cap 8 次/晚）。

**不做**

- 不搬 NMS 宿主壳（plugin/tools/agent-scope）、不搬 NMS 的 28 条种子。
- 不做 PC↔手机记忆同步（现有 gateway 未开工）。
- 不做多 persona/多 workspace；固定单 Herta、单记忆分区。

## 2. 决策清单

| # | 决定 |
|---|---|
| 1 | 替换手机端记忆内核，旧废案不再作为第二套写方。 |
| 2 | 迁移映射：无 sessionId 的 4 篇种子 → note；自造废案 → ep；字段/边/权重/时间保留。 |
| 3 | UI 全量重做：列表/设置手机原生；网络视图搬桌面 NMS（canvas 3D/LOD/激活适配）。 |
| 4 | 语气：移植 NMS 自动语气（「我说话的方式」+ 四个性子参数，一晚一格），存 NMS meta 的 voice_state；旧 DreamState.voice 只作没有自动语气时的回落。见 §13。 |
| 5 | 存储：Capacitor SQLite 原生插件（@capacitor-community/sqlite 8.1.1）。 |
| 6 | store 层异步：NMS 43 个方法 async 化，124 处调用加 await；turn-stopping 写入排队。 |
| 7 | 睡眠：浅睡本地常跑；深睡在有 key + 网络 + 前台/保活时跑，手动按钮可用。 |
| 8 | 深睡触发：复用 HertaKeeperService + JS 计时（不用 WorkManager；native worker 跑不了 JS/读不到 localStorage key）。 |
| 9 | 迁移安全：首启迁移 + 旧 IndexedDB 只读保留；备份 v2；旧备份导入自动迁移。 |
| 10 | 新包 packages/nms；DSH 端 NMS 仓库暂不重构为共享包。 |
| 11 | pending 写入：新增 onTurnEnd，覆盖最终 persist + 拒答 + 模型不收图 + 异常/打断；空文本不写；turn=会话内 user 块计数。 |
| 12 | 前台服务：keepalive 引用计数控制器，proactive 与 NMS 深睡各自 acquire/release，全部 release 才 stop。 |
| 13 | 备份 v2：解析接受 1..2；v1 导入走旧记忆迁移；先修 sanitize 保留 recalls/lastRecallAt/deepenNote。 |

## 3. 目录与边界

```text
packages/nms/
  src/
    types.ts          node/edge/pending/dream/meta/snapshot 类型
    model.ts          NMS model.js 的 TS 移植（评分、衰减、MMR、装配）
    schema.ts         核心表 DDL（nodes/edges/dream_runs/meta/pending_turns）
    store.ts          NmsStore 异步接口（43 方法裁剪后的移动面）
    sqlite-store.ts   Capacitor SQLite 实现
    recall.ts         recall/status/snapshot（供 UI 与提示词）
    light-sleep.ts    衰减/去重/剪边（零 LLM）
    deep-sleep.ts     六阶段深睡（异步 store + 注入 chat）
    pending.ts        聊天回合 → pending_turns（排队写）
    migrate.ts        旧 MemoryRecord → NMS 节点/边
    backup.ts         DB 导出/导入 + 旧备份兼容
  test/               纯函数 + 内存异步 store 测试

apps/phone/src/nms/
  useNms.ts           store 生命周期/快照/刷新
  NmsList.tsx         按 tier 的列表 + 搜索
  NmsNodeViewer.tsx   节点详情
  NmsSettings.tsx     睡眠开关/cap/状态
  NmsNetwork.tsx      桌面网络视图移植
  migrate.ts          首启迁移接线
```

**依赖方向**：apps/phone → @herta/nms → @capacitor-community/sqlite；@herta/core 不再持有记忆主键。

## 4. 数据模型（移动 store）

只建 NMS 的核心五表（单 persona，固定 persona='herta'）：

- nodes：id/tier(ep|sem|note)/persona/workspace/title/gist/body/weight/recalls/created_at/last_recall_at/forgotten/archived/merged_into/consolidated_count/last_consolidated_at/history/semanticized_at。
- edges：a/b/strength/kind，PK(a,b)，CHECK a<b。
- dream_runs：id/started_at/ended_at/kind/stats。
- meta：k/v（deep_sleep_cursor、merge_decisions、migration 标记、frozen_voice）。
- pending_turns：id/session_id/persona/workspace/user_text/assistant_text/turn/created_at/consumed_at，唯一 (session_id,turn)。

不建 personas / persona_routes / persona_base_versions / persona_schema_versions 表（单人格，基底直接用随包的 HertaBio）。自动语气不另建表：状态存在 meta 的 voice_state（JSON，含最多 5 个快照），见 §13。

- 索引：nodes(tier)、nodes(persona,workspace)、nodes(archived,forgotten)、edges(a/b)、pending 未消费、pending 唯一。
- 迁移：新库 schema_version=1（移动端独立于 DSH 的 v4）；后续用 meta 迁移。
- 时间统一 ISO；单分区 workspace=null（手机没有 cwd）。

## 5. 旧记忆迁移（Q2 A）

对每个旧 MemoryRecord：

- tier = sessionId ? ep : note（4 篇种子无 sessionId → note；自造 → ep）。
- title 用 memoryTitle，body/gist 原样；weight/recalls/createdAt/lastRecallAt/forgotten 保留。
- 旧 name 进节点 history（{kind:"migrate", legacyName}），不占主键；旧 tag/deepenNote 一并进 history。
- 旧 links（存 name）先建 name→新 id 映射，迁移为 assoc 边；强度先取 0.5，之后由 recall/Hebbian 调整。
- 旧 DreamState.voice 冻结：写入 meta frozen_voice，persona 注入继续读它；不再改。
- 迁移在首启一次完成；旧 IndexedDB 原样保留只读，meta 记 legacy_migrated=1、时间和计数。
- 迁移失败：不标记完成，保持旧库可用；App 回退到旧记忆 UI（见 §9）。

## 6. 异步 store 与调用链

- NMS 原 store 43 个方法裁剪为移动面约 30 个；全部 Promise。
- deep-sleep 六阶段、memory-api 全部 async；store.* 调用加 await（NMS 原 124 处）。
- turn-stopping 不阻塞 UI：pending.ts 先把本轮写入内存队列，.then 异步 insert；失败只记日志。
- 写入点：useChatTurn 新增 onTurnEnd（App.tsx 装配），覆盖最终 persist（useChatTurn.ts:485-487）、拒答（:151-170）、模型不收图重跑（:384-400）、异常/打断（:491-502）；空文本不写；turn=会话内 user 块计数（同轮 (session_id,turn) 唯一）。撤回时按 (session_id,turn) 删除 pending。
- recall/snapshot 是 async；UI 用 hook 拉取，不假设同步。
- 同步点仅剩：启动迁移、设置读取；不放在 WebView 每次渲染路径。
- 事务：Capacitor SQLite 的 execute/executeSet/run；需要跨语句事务的写路径用 beginTransaction/commitTransaction，失败 rollback。

## 7. 浅睡 / 深睡

**浅睡（零 LLM，常跑）**：applyDecay → dedupeByTitle → pruneEdges；在 App 启动、切回前台、空闲计时里跑，阈值同 NMS（90 天半衰期、剪边 0.12、归档 0.08/365 天）。

**深睡（LLM，opportunistic）**：

- 触发：HertaKeeperService 开启时，JS 计时检查（App.tsx:510-531 的 60s tick；凌晨/深夜 2min、白天 6min）；满足 apiKey + 网络 + 未超 8 次/晚 + 有 pending 或 stale 才跑；设置页可手动触发。
- 服务寿命：新增 keepalive 引用计数控制器（proactive 与 NMS 深睡各自 acquire/release；全部 release 才 stop），不直接沿用 useProactive.ts:46-54 的 start/stop。
- 浅睡挂点：App.tsx:589-597 启动一次 + :557-569 回前台。
- 六阶段：pending → hygiene → merge → semanticize → reconsolidate → connect；游标存 meta，中断续跑。
- caller：手机 transport.stream + collect 包成 chat({system,user,maxTokens})，再适配 NMS 的 caller({stage,system,user,maxTokens,timeoutMs})。
- 失败：保留游标/旧数据，不阻塞 App；连续失败停一晚。
- 成本：默认 cap 8 次/晚，设置页可调/关闭。

## 8. UI（全量）

- 列表：按 ep/sem/note 分组/筛选；标题、gist、有效权重、lastRecall；搜索复用 model 的 CJK bigram 匹配。
- 节点详情：正文、tier、权重、recall 次数、history、关联边；旧废案名以 history 显示。
- 设置：浅睡/深睡开关、每晚 cap、数据库大小、迁移状态、手动做梦/浅睡、备份导出。
- 网络：移植桌面 NMS client 的 canvas 视图（节点布局、边强度、tier 颜色、LOD、选中、拖拽/缩放、激活扩散）；数据源改为本地 NmsStore.snapshot()，不依赖 /nms/api/EventSource；触摸手势与手机 DPR 适配。
- 旧 Drawer/MemoryViewer/星图：替换为 NMS 组件；旧组件可先保留但不再作为写方/数据源。

## 9. 备份与回滚

- 新备份 v2：manifest + nms.db 导出（JS 侧 plugin.exportToJson 或 snapshot JSON）+ frozen_voice + 旧记忆只读快照；恢复时写 SQLite 并重建迁移标记。
- 旧备份 v1：解析接受 version 1..2（core/src/backup.ts:232-234 的等值校验改成范围）；v1 导入时先把 MemoryRecord 走迁移函数写入 NMS；语气/游标一并进 meta。
- 先修 sanitize（core/src/backup.ts:257-276）保留 recalls/lastRecallAt/deepenNote，否则迁移前数据已在备份里丢了。
- 回滚：旧 IndexedDB 不清；迁移失败/新内核严重 bug 时，App 可走「旧记忆只读模式」（隐藏 NMS 写入，persona 仍读旧记忆/voice），等修复后再迁移。
- 迁移与备份操作都要幂等；重复导入不重复建节点。

## 10. 验收

- 迁移：4 篇种子→note、自造→ep；links→边；recalls/时间保留；旧库只读可回看。
- 召回：nms_recall 等价函数按 query 返回 ep/sem/note + 边；reinforce 真正写 recalls/lastRecallAt（修手机端现缺口）。
- 浅睡：90 天衰减、去重、剪边在 SQLite 上结果与 DSH NMS 测试向量一致。
- 深睡：mock chat 跑六阶段；有 key 真机跑一轮 pending→ep；cap/续跑/失败保留。
- UI：列表/详情/设置/网络视图在 Android WebView 渲染；触摸/缩放/LOD 不崩；大图（300+ 节点）可接受。
- 备份：导出→清库→导入恢复 nodes/edges/meta/voice；旧备份导入自动迁移。
- 构建：npm run build:phone + npx cap sync android + Gradle assembleDebug 通过。

## 11. 实现状态（2026-11-02）

已落地：

- packages/nms：types/schema/store/model/recall/migrate/pending/sqlite-store/light-sleep/deep-sleep；Capacitor SQLite async store 全量接口；深睡六阶段。
- 手机端接线：useMemory 换成 NMS（迁移 + 只读适配视图）、useChatTurn onTurnEnd 写 pending、撤回删 pending、NMS recall 注入 persona + 点亮网络、NmsScreen（网络/列表/设置）、桌面网络视图移植、keepalive 引用计数、深睡 opportunistic + 每晚 cap、备份 v2（NMS dump + 旧备份兼容）。
- 构建：npm run typecheck、packages/nms/test/nms.test.mjs（3/3）、packages/core/test/core.test.mjs（128/128）、npm run build:phone、tools/build-apk.ps1 均通过；APK ≈19.2 MB。

未验证/已知边界：

- 没有 Android 真机/模拟器：Capacitor SQLite 原生桥、WebView 内实际迁移、画布帧率、深睡真实模型调用都未跑过。
- 旧 Drawer/MemoryViewer 仍通过只读适配层显示 NMS 节点；完整「只保留 NMS UI」还差把 Drawer 记忆区替换成 NmsScreen 入口。
- 备份 v2 的 NMS dump 只在目标 NMS 库为空时恢复；同机覆盖恢复需要下一步做替换/合并。
- 深睡 cap 按 UTC 日期记账；语气冻结（DreamState.voice 只读）。

## 12. 风险

- 异步 store 改造面大（124 处）；先用内存 async store 跑通 NMS 测试，再接 SQLite。
- Capacitor SQLite 事务/FK/部分索引语义要逐条验证；迁移期间旧库只读。
- 桌面网络视图 2793 行，canvas 在手机性能未知；先保 LOD 与降采样。
- 手机端零测试；需要给 packages/nms 建测试，UI 至少手测。
- 旧备份 sanitize 丢 recalls/lastRecallAt/deepenNote，迁移前先修备份解析。
- 深睡依赖 WebView 存活（HertaKeeperService）；系统杀进程/服务关闭时不保证，需在设置页如实说明。

## 13. 自动语气（2026-11-04 补）

**一句话**：她读最近几篇记忆，重写「我说话的方式」，同时最多挪一格自己的性子；有自动语气就用它，没有才回落冻结的旧语气。

- **状态**：NMS meta 的 `voice_state`（JSON）：profile / params / version / updatedAt / reason / history（最多 5 个快照）。不新建表，不动 schema 版本。
- **参数**：四个旋钮（speech 说话长短 / patience 耐心 / initiative 主动程度 / address 称呼方式），schema 在 `packages/nms/src/voice.ts`。生成时数字每次最多差一个 step、枚举只能挪到相邻候选，越界夹回；参数只进提示词，不直接驱动行为。
- **生成**：`buildVoicePrompt` = 最近 6 条 ep/sem 正文 + 上一版 + 当前参数；模型只输出 `{"profile","params"}`；`parseVoiceReply` 校验失败整次拒绝、保留旧版。
- **触发**：深睡返回 ok 且这次 `pendingConsumed > 0 || semanticNodesCreated > 0` 时自动跑一次（fire-and-forget）；面板「重写」可手动跑；省 token 模式不跑。一次约 1–2k 输入 token，不计入 nmsNightCap。
- **注入**：`useChatTurn` 把 profile 传给 `buildStaticPrefix` 的 voiceText，参数摘要（「我现在的性子：说话长短 75/100；…」）作为 voiceParams 跟在同一段；自动语气缺席时回落 `voiceTextOf(dreamState)`。
- **面板**：记忆页 · 设置 ·「人格与语气」：当前正文、生成时间/版本、四参数（± / 枚举，连点 600ms 合一次落盘）、重写、最近 5 版回滚。
- **边界**：不改 DEEP_STAGES、不占深睡调用配额；生成失败只记日志；单人格、单分区。
