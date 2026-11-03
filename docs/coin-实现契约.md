# 黑塔币 v1 · 实现契约（2026-10-29）

> 这份文件只服务**本次实现**：把 `docs/设计-黑塔币-v1.md` 翻成可并行施工的接口与文件归属。
> 设计决策以设计文档为准；实现细节以本文为准；两者冲突时找 Lead，不要自己改口径。

## 0. 已定事项（Lead 已确认）

| 待补项 | 结论 |
|---|---|
| FC 接口地址与部署方式 | 代码与部署文档进仓库；用户自行部署；app 接口基址走构建配置 `VITE_COIN_API_BASE`（开发模式默认本地 mock `http://127.0.0.1:8787`，发布包绝不内置 mock）。设置页另留一行「黑塔币接口地址」运行时可覆盖。 |
| 交易入口占位文案 | 沿用「交易功能开发中」。 |
| 备份是否含 coin store | **含**：备份包新增可选 `coin` 字段，恢复时本地无钱包才写入。 |

补充口径（设计文档没写死，这里定下来，实现时不再猜）：

- 签到只在**工作日**、服务器本地时间 **≥ 09:30** 之后可签；周末不可签（显示「休市 · 下一场开盘后可签」）。
- 签到目标场次 = 服务器本地日期（工作日）。奖励按**签到当时实时价**入账；成本价 v1 固定为首次激活的开盘价。
- 断签：`lastSign.date` 的下一个交易日 ≠ 目标场次 → 连签从 1 重新算。
- 行情轮询：页面打开时每次拉完排 30s；页面关闭即停；30s 内不重复拉。

## 1. 文件归属（只改自己的，跨了先找 Lead）

| 文件 / 目录 | 归属 |
|---|---|
| `packages/coin/**` | coin-core |
| `fc/**`（FC 函数、新闻库、测试向量、dev mock、部署文档） | coin-fc |
| `apps/phone/src/coin/coin-storage.ts`、`useCoin.ts`、`notify.ts` | coin-core |
| `apps/phone/src/coin/chart.ts` | coin-ui |
| `apps/phone/src/components/CoinView.tsx` | coin-ui |
| `apps/phone/src/styles.css`（只追加「黑塔币」一节，不改已有规则） | coin-ui |
| `apps/phone/src/coin/config.ts` | Lead |
| `apps/phone/src/storage.ts`、`settings.ts`、`components/SettingsSheet.tsx` | Lead |
| `apps/phone/src/App.tsx`、`components/Drawer.tsx` | Lead |
| `apps/phone/src/backup.ts`、`packages/core/src/backup.ts`、`components/BackupSheet.tsx` | Lead |
| 根 `package.json`、`apps/phone/package.json`、`tools/build-apk.ps1` | Lead |
| `docs/*`、`README.md` | Lead |

样式只走 `styles.css` 的追加段；禁止写内联 `<style>`。新文件一律 TS + 具名导出，不加默认导出。

## 2. FC 契约（coin-fc）

### 2.1 运行形态

- 阿里云 FC 3.0，**Node.js 20**，HTTP 触发器，路径 `/api/daily`，方法 GET。
- CJS 入口：`fc/coin-api/index.js` 里 `exports.handler = async (event, context) => ({ statusCode, headers, body })`；
  `fc/coin-api/package.json` 写 `{"type":"commonjs"}`。
- 响应头：`Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`、`Access-Control-Allow-Origin: *`。
  非 GET → 405，非 `/api/daily` → 404，异常 → 500（JSON 里带一句人话）。
- 时间口径：**固定 UTC+8（Asia/Shanghai，无夏令时）**，不依赖服务器 TZ。`serverTime` 形如 `2026-10-29T10:15:30+08:00`。
- 纯函数核心放 `fc/coin-api/coin-core.js`，导出 `buildDailyResponse(nowMs)`；handler 只做外壳，便于本地测试。

### 2.2 返回体（version 1，字段一个不能少）

```jsonc
{
  "version": 1,
  "serverTime": "2026-10-29T10:15:30+08:00",
  "market": {
    "name": "黑塔币", "code": "HTC", "pair": "HTC/USDT",
    "sessionDate": "2026-10-29", "sessionNumber": 214,
    "status": "trading",                  // trading | preopen | lunch | closed | weekend
    "statusLabel": "交易中 · 上午",         // 盘中：交易中 · 上午 / 交易中 · 下午；其余用网页原文案
    "prevClose": 88.98, "open": 89.03, "high": 90.03, "low": 88.42, "close": 89.87,
    "changePct": 1.002,                   // 百分数，不是小数
    "volume": 77000, "turnover": 6871800, // 已揭示部分求和；turnover = Σ((o+c)/2*v)
    "revealed": 45, "partial": 0.5, "keyFingerprint": "4CDBB70C",
    "bars": [ { "t": 0, "o": 88.99, "h": 89.18, "l": 88.84, "c": 89.04, "v": 1051 },
              { "t": 45, "o": 89.04, "h": 89.10, "l": 88.97, "c": 89.02, "v": 620, "partial": true } ]
  }
}
```

- `bars` = 网页 `state.displayBars`：已揭示的完整分钟 K（`t` 为 0..239 的下标）+ 当前分钟的部分 K（带 `"partial": true`，只在 `inSession && revealed<240` 时追加）。
- `high/low/close/volume/turnover` 按 displayBars 现算（和网页 `computeQuote` 一致）；`open` 取当日计划的 open。
- `keyFingerprint` = 网页 `fingerprint(ds(sessionDate))`。
- 只输出已揭示部分，绝不补未来数据。

### 2.3 算法同源（硬要求）

把 `phantom-market\app.js` 的确定性算法**逐行同构**搬进 Node，包括：
`cyrb128/sfc32/makeRng`、日线链 `dailySeries`（genesis 2026-01-05 / 88.88 / dailyVol 0.03）、
`buildPlan`（新闻排点 + 开盘跳空 + 240 根路径 + 桥接收盘）、`getSession`、`buildDisplay`、`partialBar`、`computeQuote`。
新闻池从 `phantom-market\news.js` 的 `NEWS_POOL`（210 条）原样搬成 `news-pool.js`——
**它参与价格路径生成，删了就对不上网页**。所有日期/星期运算用 UTC 换算模拟上海时间，不碰 `new Date(y,m,d)` 的本地时区。

### 2.4 测试向量（可证伪）

- `fc/coin-api/test/gen-vectors.mjs`：把 phantom-market 拷到 `fc/coin-api/test/.tmp/`（gitignore），
  给 app.js 的 `__HTC_DEBUG__.getState()` 补上 quote/plan/bars 字段，用 `node build.mjs` 重新打包，
  启动无头 Edge（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，CDP 模式，参考 phantom-market/visual-test.mjs），
  `setNow(iso)` 后取状态，写 `fc/coin-api/test/vectors.json`。
- 固定时刻（+08:00）：`2026-10-29T10:15:30`、`2026-10-29T13:45:00`、`2026-10-29T12:00:00`、
  `2026-10-29T09:00:00`、`2026-10-29T16:00:00`、`2026-10-31T12:00:00`。
- 向量字段：上表全部标量 + 全部 bars。`fc/coin-api/test/fc.test.mjs` 用 `buildDailyResponse(Date.parse(iso))` 逐项比对：
  字符串/int 精确相等；浮点 `|a-b| <= 1e-9 * max(1,|b|)`；bars 数量与每项都查。
- `dev-server.mjs`：本地 HTTP 服务，端口 8787，回同一份 JSON；支持 `COIN_MOCK_NOW` 环境变量钉住时间。

## 3. `packages/coin`（coin-core）

`package.json`：`{"name":"@herta/coin","version":"0.1.0-dev","private":true,"type":"module","exports":{".":"./src/index.ts"}}`
（`erasableSyntaxOnly`：不用 enum / 参数属性，Node 24 直接跑 .ts 测试。）

### types.ts

```ts
export const COIN_API_VERSION = 1;
export const TOTAL_BARS = 240;
export type CoinStatus = "trading" | "preopen" | "lunch" | "closed" | "weekend";
export interface CoinBar { t: number; o: number; h: number; l: number; c: number; v: number; partial?: boolean }
export interface CoinMarket { /* 与 §2.2 market 完全同形 */ }
export interface CoinDailyResponse { version: number; serverTime: string; market: CoinMarket }
export interface CoinSignRecord { date: string; streak: number; price: number; reward: number }
export interface CoinHistoryEntry { date: string; reward: number; price: number }
export interface CoinWallet {
  version: 1; holdings: number; costPrice: number; initialAt: string;
  lastSign: CoinSignRecord | null; history: CoinHistoryEntry[]; updatedAt: string;
}
```

### api.ts

```ts
export function coinApiUrl(base: string): string;                  // base 去尾斜杠 + "/api/daily"
export function parseCoinDaily(text: string): CoinDailyResponse;   // 非法 JSON / 字段缺失 → throw Error("行情数据格式不对：…")
export async function fetchCoinDaily(base: string, getText: (url: string) => Promise<string>): Promise<CoinDailyResponse>;
export function formatPct(pct: number, digits?: number): string;   // "+1.00%" / "-0.50%" / "0.00%"
export function formatPrice(v: number, digits?: number): string;   // 两位小数
export function formatAmount(v: number): string;                   // 万/亿 缩写（网页 fmtWan 口径）
```

### signin.ts

```ts
export type SigninReason = "ok" | "already" | "preopen" | "weekend" | "clock";
export interface SigninCheck {
  canSign: boolean;
  reason: SigninReason;
  targetDate: string | null;   // 本次要签的场次（服务器本地日期，工作日）
  currentStreak: number;       // 现在的连签天数（已签/未签都填）
  nextStreak: number;          // 现在签完之后的天数
  reward: number;              // 现在签能拿多少
  message: string;             // 签到卡副文案，UI 直接用
}
export const SIGNIN_OPEN_MINUTE = 570; // 09:30
export function rewardForStreak(streak: number): number;   // 1→10 2→20 3→25 … 7→45 ≥8→50
export function isTradingDay(ymd: string): boolean;        // 周一~周五
export function nextTradingDay(ymd: string): string;
export function signinCheck(input: { wallet: CoinWallet | null; sessionDate: string; serverTime: string }): SigninCheck;
export function applySignin(input: { wallet: CoinWallet; check: SigninCheck; price: number; nowISO: string }): CoinWallet;
```

文案口径（message）：`ok` → `连续签到第 N 天，+R HTC`；`already` → 手机本地日期 ≠ 服务器日期时
`以服务器时间为准，未到下一场`，否则 `今日已签到 · 连续 N 天`；`preopen` → `09:30 开盘后可签到`；
`weekend` → `休市 · 下一场开盘后可签`；`clock` → `以服务器时间为准`。

### wallet.ts

```ts
export const INITIAL_HOLDINGS = 1000;
export function createWallet(openPrice: number, nowISO: string): CoinWallet; // holdings=1000, costPrice=openPrice
export function marketValue(wallet: CoinWallet, price: number): number;       // holdings * price
export function todayPnl(wallet: CoinWallet, price: number, prevClose: number): number; // holdings*(price-prevClose)
export function todayPnlPct(price: number, prevClose: number): number;        // 百分数
```

### 测试 `packages/coin/test/coin.test.mjs`

覆盖：连签曲线 1~9 天；断签（周五→周一续签、周三断签重置）；同日重复签拒绝；
09:30 前不可签、周末不可签；防改时间 message；钱包初始 1000、签到入账、市值/今日盈亏；history 上限 60；api 解析与畸形 JSON。

## 4. app 数据层（coin-core）

### `apps/phone/src/coin/config.ts`（Lead 写，只读）

```ts
export const COIN_DEV_MOCK_BASE = "http://127.0.0.1:8787";
export function coinApiBase(): string;
// VITE_COIN_API_BASE（构建注入，去尾斜杠）> DEV 模式 COIN_DEV_MOCK_BASE > ""
```

### `apps/phone/src/coin/coin-storage.ts`

```ts
export async function loadCoinWallet(): Promise<CoinWallet | null>;
export async function saveCoinWallet(wallet: CoinWallet): Promise<void>;
export async function loadCoinQuote(): Promise<{ savedAt: string; response: CoinDailyResponse } | null>;
export async function saveCoinQuote(response: CoinDailyResponse): Promise<void>;
```

复用 `storage.ts` 的 `tx` 与 `STORE_COIN`（Lead 会把 `DB_VERSION` 升到 4 并建 store，keyPath `"key"`）。
记录形如 `{ key: "wallet", value: CoinWallet }` / `{ key: "quote", savedAt, response }`。

### `apps/phone/src/coin/useCoin.ts`

```ts
export interface UseCoinOptions { base: string; active: boolean }
export interface UseCoinResult {
  loading: boolean;
  quote: CoinDailyResponse | null;   // 最新成功数据；失败时回退缓存
  cached: boolean;                   // quote 是不是缓存
  offline: boolean;                  // 无网/接口失败/未配置接口
  error: string | null;
  wallet: CoinWallet | null;
  signin: SigninCheck | null;
  signing: boolean;
  refresh(): Promise<void>;
  sign(): Promise<string>;           // 返回给用户看的一句话（成功/失败）
}
export function useCoin(opts: UseCoinOptions): UseCoinResult;
```

行为：
- 首次 `active` 时并行读钱包/缓存，再拉接口；成功 → `saveCoinQuote`；失败 → 用缓存并 `offline=true`。
- 拉取用 `fetchCoinDaily(base, (url) => pickTransport().getText(url))`（浏览器/native 都走 transport 的 getText）。
- `base === ""` → 不请求，`offline=true, error="未配置行情接口"`。
- `active` 期间每 30s 刷新一次（setInterval + 页面 `visibilitychange` 恢复时补拉）；`active=false` 或卸载即清。
- 首次拿到接口且本地无钱包 → `createWallet(market.open, serverTime)` 落库（只发一次）。
- `sign()`：调 `signinCheck` → 不可签返回 message；可签则 `applySignin` + 落库 + 返回「签到成功，+R HTC」。

### `apps/phone/src/coin/notify.ts`

```ts
export type CoinReminderPermission = "granted" | "denied" | "prompt" | "unsupported";
export interface CoinReminderState { permission: CoinReminderPermission; enabled: boolean }
export async function coinReminderState(): Promise<CoinReminderState>;
export async function enableCoinReminder(): Promise<CoinReminderState>;
export async function disableCoinReminder(): Promise<void>;
export async function syncCoinReminder(): Promise<void>;  // 每次开 app 调；enabled 才补排，失败静默
export async function onCoinNotificationTap(handler: () => void): Promise<() => void>;
```

- 用 `@capacitor/local-notifications`：**周一~周五各一条**，`schedule.on = { weekday: Weekday.Monday..Friday, hour: 9, minute: 30 }` + `repeats: true` + `allowWhileIdle: true`。
- 通知 id 固定 `730000..730004`（`coinNotificationIds()`），extra `{ route: "coin" }`；标题「黑塔币 · 开盘」，正文「开盘了，签到可以拿 +N HTC。」（N 取当前连签的下一档，默认 10）。
- 浏览器环境：`unsupported`，`enable` 只返回状态不报错；本地持久化用 `localStorage["herta.coin.reminder"]="1"`。
- `onCoinNotificationTap` 只在 native 上挂 `localNotificationActionPerformed`，按 extra.route 过滤，返回取消函数。

## 5. 行情页 UI（coin-ui）

### `apps/phone/src/coin/chart.ts`

```ts
export interface CoinChartTheme { up: string; down: string; grid: string; axis: string; ma5: string; ma10: string; ma20: string; vwap: string; prevLine: string }
export const COIN_CHART_THEME: CoinChartTheme;  // 设计文档「视觉」一节：涨 #d96a7a 跌 #4f9d8a 网格 #e6eef0 均线 #d9a66a/#6fa8ad/#a58ac9
export interface CoinChartOptions {
  width: number; height: number; dpr: number;
  bars: CoinBar[]; prevClose: number;
  hover: number | null;           // bars 下标
  theme?: CoinChartTheme;
}
export function drawCoinChart(ctx: CanvasRenderingContext2D, opts: CoinChartOptions): void;
export function barIndexOf(x: number, width: number, height: number, barsLength: number): number | null; // 动态轴命中（按已揭示根数铺满）
export function barTimeLabel(index: number): string;  // 0=09:30 … 119=11:29 120=13:00 … 239=14:59
```

画法：**动态时间轴**（2026-10-30 修订，对齐网页版 `phantom-market/app.js` 的 `draw()`）——按已揭示根数 n 等宽铺满绘图区
（step = plotWidth / n，绝不预留未来格子），时间刻度只覆盖已揭示区间（4~6 个、随屏宽自适应、用真实 bar.t），
午休分隔线只在已揭示进入下午后出现，当前 partial K 画淡；价格轴 + 成交量副图（20% 高），
MA5/10/20 + 均价线，昨收虚线，最新价标签，十字光标（hover 时竖线 + 时间标签）。长按/拖动由 CoinView 转 hover。

### `apps/phone/src/components/CoinView.tsx`

```ts
export interface CoinViewProps {
  base: string;                                  // 行情接口基址
  onClose(): void;
  onQuoteChange?(quote: CoinDailyResponse | null): void; // 抽屉小字用
}
```

页面结构（全屏覆盖，左上返回）：
1. 顶栏：返回、标题「黑塔币 · HTC/USDT」、状态徽标（交易中/盘前/午休/已收盘/休市）+ 离线标记。
2. 价格条：现价、涨跌幅、今开/最高/最低/成交量；灰字「行情与网页同源 · 30s 刷新」。
3. 分钟 K 图（canvas，`drawCoinChart`）：动态轴（只铺已揭示区间，随行情向右生长）、成交量副图、长按/拖动十字光标、单根 OHLC 浮层。
4. 持仓卡：持有数量、当前市值、今日盈亏（较昨收，红/绿）、成本价。
5. 签到卡：可签按钮「签到 +N HTC」；不可签显示 `signin.message`；已签显示「今日已签到 · 连续 N 天 · 明天 +XX」；离线禁用并提示「签到需要联网」。
6. 交易占位：按钮「交易功能开发中」，disabled。
7. 离线/错误态：有缓存 → 显示缓存 + 「离线」；无缓存 → 「行情暂不可用」+ 刷新按钮。
8. 开盘提醒：未授权时一行「开盘提醒未开启」+「开启」按钮（调 notify）；已开启一行小字。

样式追加到 `styles.css` 末尾 `/* ===== 黑塔币 ===== */` 一节，沿用 `--card/--ink/--line/--muted/--accent`，不引入新主题。

## 6. 集成点（Lead 做，teammate 不要碰）

- `storage.ts`：`DB_VERSION=4`、`STORE_COIN="coin"`（keyPath `"key"`）、`clearAll` 清 coin。
- `settings.ts`：`coinApiBase: string`（默认 `""`）；`SettingsSheet` 加一行「黑塔币接口地址」。
- `App.tsx`：`showCoin` 状态、`coinPct` 状态（抽屉用）、`<CoinView base=... onClose=... onQuoteChange=.../>`、
  启动时 `syncCoinReminder()`、`onCoinNotificationTap(() => setShowCoin(true))`。
- `Drawer.tsx`：`DrawerActions.openCoin()`；「＋ 新的对话」下面一行「黑塔币 HTC」+ 右侧涨跌幅小字。
- 备份：`packages/core/src/backup.ts` 加可选 `coin`（结构同 CoinWallet，避免 core 依赖 coin 包），
  `apps/phone/src/backup.ts` 打包/恢复，`BackupSheet` 显示钱包是否随包。
- 根 `package.json`：`test` 追加 `node packages/coin/test/coin.test.mjs && node fc/coin-api/test/fc.test.mjs`；
  `coin:mock` 脚本；`apps/phone/package.json` 加 `"@herta/coin": "*"`；`tools/build-apk.ps1` 加 `-CoinApiBase`。

## 7. 验收映射

| 设计验收 | 落在哪 |
|---|---|
| 1 算法同源 | fc vectors + `fc.test.mjs`；网页侧由 gen-vectors 生成 |
| 2 有网 5s 出手、60s 有变化 | 浏览器冒烟（mock 钉时间）+ 真机（用户） |
| 3 断网缓存 | useCoin offline + CoinView 离线态 |
| 4/5/6 签到时间与连签曲线 | packages/coin 测试 + UI 按钮 |
| 7 持仓口径 | packages/coin wallet 测试 + 持仓卡 |
| 8 通知 | notify.ts + App 监听（真机由用户验） |
| 9 持久化/备份 | storage.ts + backup 改动 |
| 10 工程 | `npm run typecheck`、`npm test`、`vite build`、APK |
| 11 UI | 浏览器 390×844 截图检查 |
