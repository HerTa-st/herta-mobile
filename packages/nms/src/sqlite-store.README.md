# sqlite-store · Capacitor SQLite 异步 NMS store

对应文件：`packages/nms/src/sqlite-store.ts`  
导出：`createMobileNmsStore(options?)`（实现 `NmsStore`）

## 数据库与连接

- 默认数据库名：`herta_nms`（Android 落盘通常是 `herta_nmsSQLite.db`）。可用 `options.database` 覆盖。
- 连接由 `new SQLiteConnection(CapacitorSQLite)` 建立：
  ```ts
  connection.createConnection(database, false, "no-encryption", 1, false)
  ```
  版本固定为移动端 schema 版本 1（独立于 DSH 的 v4）。`options.connection` 可注入已有
  `SQLiteConnection`（测试/复用）。
- `open()`：执行 `NMS_SCHEMA_STATEMENTS`（五表 + 索引 + `PRAGMA foreign_keys=ON`），
  然后确保 `meta.schema_version=1`。同一实例重复 `open()` 幂等；`close()` 后可再 open。
- `close()`：先 `db.close()`，再 `connection.closeConnection(database, false)`，均为 best-effort。

## 事务

- 跨语句写路径使用 `beginTransaction() / commitTransaction() / rollbackTransaction()`：
  `recall`、`reinforce`、`applyDecay`、`dedupeByTitle`、`mergeNodeInto`、
  `consumePendingTurns`、`dreamLight`。
- 所有 `run()` 都显式传 `transaction=false`。Capacitor 的 `run` 默认会在语句外再开事务；
  在手工事务里不传 false 会触发原生层 `Already in transaction`。
- 顶层事务用内部 Promise 队列串行化，避免两个 async 调用同时 begin。内部
  `applyDecayInternal / dedupeByTitleInternal / pruneEdgesInternal` 不再开事务，
  因此 `dreamLight` 可以把「去重 → 衰减 → 剪边 → 记账」包成一个事务而不会嵌套。
- 注意：同一数据库不要同时创建多个 store 实例写库。`createConnection` 在原生层同名连接
  已存在时会报错；应用层应把 store 做成单例（`useNms`）。同一实例重复 open 没问题。

## 实现的方法

nodes / edges：`listNodes` / `getNode` / `insertNode` / `updateNode` /
`appendNodeHistory` / `mergeNodeInto` / `countMerged` / `insertEdge` /
`allEdges` / `neighbors`

代谢：`recall` / `reinforce` / `applyDecay` / `dedupeByTitle` / `pruneEdges` /
`dreamLight`

pending：`insertPendingTurn` / `listPendingTurns` / `consumePendingTurns` /
`pendingTurnStats`

dream 账本：`recordDreamRun` / `lastDreamRun` / `dreamRuns`

meta / 统计：`getMeta` / `setMeta` / `stats` / `snapshot` / `countNodes` / `sizeBytes`

行转换：nodes/edges/pending/dream 的 snake_case → camelCase；`history` 与
`dream_runs.stats` 解析 JSON（坏 JSON 回落空数组 / `{parseError:true}`）；0/1 → boolean。
`lastId` 取自 `run()` 返回的 `changes.lastId`，不使用 `RETURNING`。

`stats()` / `snapshot()` 按 `NmsStats` / `NmsSnapshot` 输出：统计五表、按 tier/workspace
聚合、pending、dream 账本；快照包含 active 节点（weight/effectiveWeight 四舍五入到 4 位）
与两端都 active 的边。

## 与 DSH store.js 的必要差异

- **reinforce**：`NmsStore` 接口要求返回被触碰的边数组 `{a,b,strength}`，
  而 DSH 返回 `{pairs,created,strengthened}`。这里按接口返回边数组（长度 = pairs）。
- **mergeNodeInto**：DSH 在节点不存在时返回 `null`；`NmsStore` 返回类型不允许 null，
  这里抛 `NmsStoreError("node_not_found")`。
- **insertPendingTurn**：persona 缺省用 `"herta"`（手机端固定单 persona），DSH 用 `"assistant"`。
- **未迁移 seed**：不播种 28 条 DSH 种子；空库就是空库。旧手机记忆由 migrate.ts 负责。
- **sizeBytes**：插件没有暴露库文件路径/stat，改用
  `PRAGMA page_count × PRAGMA page_size` 估算逻辑大小（不含 WAL 文件）；失败返回 0。
- schema 版本固定为移动端 v1；不包含 personas / voice / persona_routes 等表。

## 未实现 / 未验证

- 未实现浅睡/深睡引擎、迁移、备份、UI —— 本文件只做 store。
- **没有在 Android 模拟器/真机或 iOS 上跑过**：Capacitor 原生桥的
  `createConnection`、多语句 `execute`、手工事务、`changes.lastId`、partial unique index、
  `PRAGMA page_count` 的实际行为未验证。
- 已用 `node:sqlite` 假连接跑过一轮 SQL/逻辑冒烟（建表、CRUD、召回、衰减、去重、合并、
  pending、dream、快照、重开库），但这不替代真机验证。
- 已通过单文件 strict tsc 与仓库 `apps/phone` tsc；第三方类型噪声用 `skipLibCheck` 忽略。
- 接入应用前需要 `@capacitor-community/sqlite`（package 已声明 8.1.1）执行
  `npx cap sync android`，把原生插件同步进 Android 工程。

## 用法

```ts
import { createMobileNmsStore } from "@herta/nms";

const store = createMobileNmsStore(); // database: "herta_nms"
await store.open();

const stats = await store.stats();
const node = await store.insertNode({ tier: "ep", title: "标题", gist: "摘要", body: "正文" });
const recalled = await store.recall([node.id]);

await store.close();
```
