# 黑塔币 v1 · FC 行情接口（`fc/coin-api/`）

阿里云函数计算 **FC 3.0** 上的行情接口：`GET /api/daily` 返回与网页
（`phantom-market\黑塔币.html`）**同一套确定性算法**算出的当日行情。
手机端（`apps/phone`）打开「黑塔币」页后每 30s 轮询它；签到只认它返回的 `serverTime`。

接口契约以 `docs/coin-实现契约.md` §2 为准，本文只讲怎么跑、怎么部署、怎么验证。

```
fc/coin-api/
├── index.js          # FC 入口 exports.handler（HTTP 外壳：路由/CORS/404/405/500）
├── coin-core.js      # 确定性算法逐行同构移植 + buildDailyResponse(nowMs, getSecret)（纯函数）
├── seeds.js          # 每日价格密钥：生成 / 落盘（state/coin.json 顶层 seeds）/ 窗口下发
├── news-pool.js      # 从 phantom-market/news.js 原样搬来的 NEWS_POOL（210 条，参与价格路径）
├── dev-server.mjs    # 本地 mock：127.0.0.1:8787，支持 COIN_MOCK_NOW 钉时间
├── package.json      # {"type":"commonjs"}；零第三方依赖，不需要 npm install
├── README.md         # 本文
└── test/
    ├── gen-vectors.mjs  # 用网页侧 app.js 生成 6 个固定时刻的测试向量 -> vectors.json
    ├── fc.test.mjs      # 同源测试：coin-core 输出 vs vectors.json，逐项比对
    ├── seeds.test.mjs   # /api/seeds：窗口 / 只生成一次 / 旧日期不发 / 账务接口改吃密钥
    ├── vectors.json     # 生成的向量（提交进仓库，算法改了要重跑重新生成）
    └── .tmp/            # gen-vectors 的临时产物（gitignore）：phantom-market 拷贝 / Edge profile
```

## 一、本地跑

零依赖，直接在仓库根目录：

```powershell
# 1) 同源测试（6 个固定时刻，逐项比对全部 bars）
node fc/coin-api/test/fc.test.mjs

# 2) 本地 mock 服务（开发 / 浏览器冒烟用）
node fc/coin-api/dev-server.mjs
# 打开 http://127.0.0.1:8787/api/daily 看 JSON

# 3) 钉住时间再起（模拟盘中 10:15:30）
$env:COIN_MOCK_NOW='2026-10-29T10:15:30+08:00'; node fc/coin-api/dev-server.mjs
# 也可以一行式：$env:COIN_MOCK_NOW='2026-10-29T10:15:30+08:00'; node fc/coin-api/dev-server.mjs
```

- mock 服务监听 `127.0.0.1:8787`（`PORT` 可覆盖），`GET /api/daily` 走和线上**同一份 handler**；
- CORS 全开（`Access-Control-Allow-Origin: *`），`OPTIONS` 预检直接 `204`；
- 不设 `COIN_MOCK_NOW` 就用真实时间（和线上一致）。
- app 开发模式默认 base 就是 `http://127.0.0.1:8787`（见 `apps/phone/src/coin/config.ts`）。

### 测试向量怎么来

`vectors.json` 不是手写的，是从**网页源码**生成的唯一事实来源（6 个固定时刻，均为 +08:00）：

| 时刻 | 网页行为 |
|---|---|
| `2026-10-29T10:15:30+08:00` | 上午盘中，revealed=45 + 当前部分 K，46 根 |
| `2026-10-29T13:45:00+08:00` | 下午盘中，revealed=165 + 部分 K（0 进度），166 根 |
| `2026-10-29T12:00:00+08:00` | 午休，上午 120 根 |
| `2026-10-29T09:00:00+08:00` | 盘前，显示上一场（10-28）完整 240 根 |
| `2026-10-29T16:00:00+08:00` | 已收盘，全天 240 根 |
| `2026-10-31T12:00:00+08:00` | 周六，显示周五（10-30）完整 240 根 |

重新生成（网页算法改了 / 核对线上是否漂移时）：

```powershell
node fc/coin-api/test/gen-vectors.mjs   # 写 test/vectors.json，跑完会杀掉它启动的 Edge 进程树
node fc/coin-api/test/fc.test.mjs       # 必须全绿
```

生成器流程：把 `phantom-market` 拷到 `test/.tmp/phantom-market` → 给拷贝的 `app.js` 的
`__HTC_DEBUG__.getState()` 补上 `open/high/low/close/volume/turnover` 与全部 `bars`
（网页只显示两位小数，向量要的是底层原始浮点）→ 用拷贝的 `build.mjs` 重新打包单文件 HTML →
用**无头 Edge + CDP**（`file://` + `pathToFileURL`）打开，逐个 `setNow(iso)` 取状态。

> ⚠ 生成器需要 UTC+8 系统时区（会断言 `getTimezoneOffset()===-480`）。
> 在受限环境（例：DSH 的 Windows 沙箱禁止创建命名管道，Edge 多进程会
> `FATAL platform_channel 0x5 拒绝访问`）起不来无头 Edge 时，脚本会**自动降级**：
> 在 Node `vm` 里加载**同一份拷贝的 app.js**（连同 `news.js`、最小 DOM 桩、不渲染 canvas）
> 取数，并打印警告、在 `vectors.json` 的 `oracle` 字段记录所用路径。
> 降级取的数与真 Edge 在算法/种子/时区上完全一致；到普通机器重跑即可换回真 Edge 复核。

## 二、部署到阿里云函数计算 FC 3.0

运行时 **Node.js 20**（本目录零 npm 依赖，部署包不需要 `node_modules`）。
`index.js` 兼容 FC 3.0 的 `rawPath/requestContext` 与 FC 2.0 的 `httpMethod/path` 两种 event 形态，
也兼容 event 以 JSON 字符串传入的触发方式。

1. 控制台 → **函数计算 FC** → 创建函数。
2. 运行环境选 **Node.js 20**（内置运行时），代码上传方式选 **上传 ZIP 包**（或在线编辑器逐个粘贴 4 个文件）。
3. 函数入口填 **`index.handler`**。
4. 创建 **HTTP 触发器**：
   - 请求方法：**GET**
   - 路径：**`/api/daily`**
   - 认证方式：**无需认证**（匿名；app 不带签名，走公开只读接口）
5. 打完包后确认 ZIP **根目录**直接是 `index.js`、`coin-core.js`、`seeds.js`、`news-pool.js`、`package.json`
   （不要把外层 `fc/coin-api/` 目录打进去，也不要把 `test/`、`dev-server.mjs` 打进部署包）。
   在 PowerShell 里打包示例：

   ```powershell
   cd fc/coin-api
   Compress-Archive -Path index.js,coin-core.js,seeds.js,news-pool.js,market-v2.js,oss-state.js,package.json -DestinationPath ..\..\coin-api.zip -Force
   ```

   或者直接跑仓库里的打包脚本（自动校验七个文件齐全、输出去重后的 zip）：

   ```powershell
   & tools/pack-coin-api.ps1
   ```

6. 部署后记下公网访问地址（形如 `https://<id>.<region>.fcapp.run`），接口地址就是
   `https://<id>.<region>.fcapp.run/api/daily`。

### 部署验证

```powershell
# 200 + JSON；看 Content-Type / Cache-Control / CORS 头，以及 version=1
curl.exe -i https://<你的域名>/api/daily

# 非 GET -> 405、非 /api/daily -> 404
curl.exe -i -X POST https://<你的域名>/api/daily
curl.exe -i https://<你的域名>/api/other
```

期望响应头（handler 固定返回）：

```
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Access-Control-Allow-Origin: *
```

`curl -s https://<域名>/api/daily | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.version,j.serverTime,j.market.status,j.market.revealed,j.market.bars.length)})"`
可快速看版本号 / 服务器时间 / 状态 / 已揭示根数。

### 域名 / HTTPS / CORS 提示

- **FC 默认公网域名（`*.fcapp.run`）自带 HTTPS，不用备案**，手机 app 可直接用；
  缺点是这个域名不固定好看、且跟函数绑定，重建函数可能变。正式发布建议绑定**自定义域名**，
  国内地域绑定自定义域名需要 **ICP 备案**，并在 FC「自定义域名」里上传/托管 HTTPS 证书。
- Android WebView / Capacitor 页面请求这个接口属于跨域：线上 handler 已返回
  `Access-Control-Allow-Origin: *`。GET 是简单请求，不会触发浏览器预检；
  handler 对 `OPTIONS` 按契约返回 405（只有本地 mock 才回 204 方便调试）。
  若以后给请求加自定义头而触发预检，需要走 app 现有原生 HTTP 通道（`transport.ts`）
  或自行在 FC 前加一层网关处理 OPTIONS，不要为此改契约。
- 响应 `Cache-Control: no-store`：app 自己缓存最后一次成功响应（IndexedDB），
  30s 内的行情变化必须拿到新数据，别加 CDN 缓存。

## 三、手机端怎么填接口地址

app 的接口基址走**构建配置**（发布包绝不内置 mock）：

- 构建环境变量：**`VITE_COIN_API_BASE`**，填 FC 地址的**基址**（不带 `/api/daily`、不带尾斜杠），例如：

  ```powershell
  # 浏览器 vite 构建
  $env:VITE_COIN_API_BASE='https://coin.example.com'; npm run build --workspace apps/phone

  # Android APK 构建（tools/build-apk.ps1 的 -CoinApiBase 参数最终也是设这个变量）
  powershell -File tools/build-apk.ps1 -CoinApiBase https://coin.example.com
  ```

  客户端实际请求 `coinApiUrl(base)` = `base.replace(/\/+$/,'') + '/api/daily'`。
- 开发模式没设 `VITE_COIN_API_BASE` 时回落到本地 mock `http://127.0.0.1:8787`；
  真机调试要把手机和电脑放同一局域网，并把 base 换成电脑的局域网 IP（`http://192.168.x.x:8787`），
  或在设置页「黑塔币接口地址」里运行时覆盖。
- 设置页留了「黑塔币接口地址」运行时可覆盖，优先级高于构建值。

## 四、返回体（契约 §2.2 摘要）

```jsonc
{
  "version": 1,
  "serverTime": "2026-10-29T10:15:30+08:00",
  "market": {
    "name": "黑塔币", "code": "HTC", "pair": "HTC/USDT",
    "sessionDate": "2026-10-29", "sessionNumber": 214,
    "status": "trading",                      // trading | preopen | lunch | closed | weekend
    "statusLabel": "交易中 · 上午",
    "prevClose": 88.9806, "open": 89.0253, "high": 90.0264, "low": 88.4160, "close": 89.8722,
    "changePct": 1.0020,                      // 百分数，不是小数
    "volume": 77031, "turnover": 6871767.4,   // 已揭示部分求和；turnover = Σ((o+c)/2*v)
    "revealed": 45, "partial": 0.5, "keyFingerprint": "4CDBB70C",
    "bars": [ { "t": 0, "o": 88.99, "h": 89.18, "l": 88.84, "c": 89.04, "v": 1051 },
              { "t": 45, "o": 89.90, "h": 89.96, "l": 89.86, "c": 89.87, "v": 635, "partial": true } ]
  }
}
```

要点：

- **只输出已揭示部分**：已走完的整分钟 K（`t` 为 0..239 下标）+ 当前分钟的部分 K（`partial: true`，
  只在盘中且 `revealed < 240` 时追加；`partial` 是这分钟已走比例 0~1）。绝不补未来数据。
- **价格是原始浮点**，没做前端两位小数取整（`changePct` 也是原始百分数）；
  UI 用 `formatPrice`/`formatPct` 自己格式化。测试向量比对的也是原始浮点。
- `statusLabel` 盘中是「交易中 · 上午 / 交易中 · 下午」，其余沿用网页原文案
  （盘前 · 未开盘 / 午间休市 / 已收盘 / 休市 · 周末）。
- `keyFingerprint` = 网页 `fingerprint(sessionDate)`；同一天任何人、任何时间拿到的行情都一致。

## 五、算法同源与维护规则（重要）

- 唯一事实来源是 `phantom-market\app.js` 与 `news.js`（只读，**不许改**）。
- `coin-core.js` 逐行同构移植了：`cyrb128/sfc32/makeRng`、日线链 `dailySeries`
  （genesis `2026-01-05` / `88.88` / dailyVol `0.030`）、`buildPlan`（新闻排点 + 开盘跳空 +
  240 根路径 + 桥接收盘 + 成交量）、`getSession`、`buildDisplay`、`partialBar`、`computeQuote`、`fingerprint`。
- 时间口径**固定 UTC+8**（Asia/Shanghai，无夏令时），不依赖服务器时区：
  先把 epoch +8h 换成「墙上时间」，再全部用 UTC 换算，绝不用 `new Date(y,m,d)` 的本地时区语义。
  确定性随机种子只吃日期字符串 / 下标 / epoch 秒，所以换时区也不影响结果。
- `news-pool.js` 是 `NEWS_POOL`（210 条）的**原样副本**：它参与当日新闻排点与价格冲击，
  **不能删、不能改顺序、不能少条**，否则 FC 行情会和网页对不上。
- 改算法顺序：先改网页 `app.js` → 重新拷 `news.js`/`app.js` 生成 `coin-core.js`
  → `node fc/coin-api/test/gen-vectors.mjs` 重新生成向量 → `node fc/coin-api/test/fc.test.mjs` 必须全绿。
  网页、FC、向量三者不一致时**以网页为准**，不要反过来改向量迁就实现。

## 六、已知限制 / 遗留风险

- **Edge 沙箱降级**：受限环境（DSH Windows 沙箱）里无头 Edge 起不来，`gen-vectors.mjs`
  会降级到 Node vm 执行同一份 `app.js`（详见上文）。算法一致性没问题，但"真浏览器"
  这一层是降级环境里唯一没跑到的；到普通机器重跑一次即可复核，`vectors.json` 的 `oracle` 字段会变成真 Edge。
- **跨引擎浮点**：Node 与 Edge 都是 V8，数学函数实现一致；测试容差 `1e-9`。若未来 V8 数学实现
  变化（极罕见），新闻排点这类离散决策可能跨边界，重跑 `gen-vectors` + `fc.test` 能立刻发现。
- **固定 UTC+8 / 无节假日**：算法里只有周末休市，没有法定节假日；节假日也会照常"开盘"。
  这是网页既有行为，FC 与网页保持一致（契约要求），不要在 FC 单方面加节假日。
- **FC 冷启动 / 成本**：函数是纯计算（240 根 K，毫秒级），128MB 够用；30s 轮询一天约 900 次，
  免费额度内。若未来加签名/鉴权/服务端账本（v2），需要重新设计。
- **接口地址变更**：FC 默认域名可能随函数重建变化，发版后 app 里写死的 `VITE_COIN_API_BASE`
  会失效；正式发布建议自定义域名（备案 + HTTPS 证书）。

## 七、v2 共享市场部署（增量，2026-10-29）

新增文件：`market-v2.js`（共享市场逻辑）、`oss-state.js`（OSS 状态 + 锁）、`seeds.js`（每日价格密钥，2026-11-07 加）；`index.js` 新增 `/api/state`、`/api/trade`、`/api/leaderboard`、`/api/seeds`。

### 1. 给函数配置执行角色（读写 OSS）

RAM 先建一个自定义策略 `coin-state-rw`（最小权限）：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["oss:GetObject", "oss:PutObject", "oss:DeleteObject"],
      "Resource": ["acs:oss:*:*:<bucket>/*"]
    }
  ]
}
```

然后在 FC 控制台 → 函数 `coin-api` → 配置 → 权限 / 执行角色 → 创建或选择角色，把该策略绑到角色上。
（不想折腾最小权限的话，直接给 `AliyunOSSFullAccess` 也能跑。）

### 2. HTTP 触发器加上 POST

编辑现有 HTTP 触发器，请求方法勾选 **GET + POST**（只留 GET 的话 `/api/trade` 会被网关 403）。

### 3. 上传新代码

上传 `herta-mobile/coin-api-deploy.zip`（根目录含 `index.js`、`coin-core.js`、`seeds.js`、`news-pool.js`、`market-v2.js`、`oss-state.js`、`package.json`），函数入口仍是 `index.handler`。

### 4. 环境变量

```
OSS_BUCKET=<bucket>
OSS_ENDPOINT=<region>.aliyuncs.com
STATE_KEY=<state-key>
LOCK_KEY=<state-key>.lock
```

**`OSS_BUCKET` 与 `STATE_KEY` 不是可选的**（2026-11-08 迁的，见下）。代码里**没有**默认桶名和默认账本键——
桶不配就直接报 `MissingBucket`。仓库是公开的，桶名/账本键不进代码，一律走环境变量。

#### 为什么在杭州

函数跑在 cn-hangzhou。此前账本存在境外一个桶里，每次读写都要跨境往返
（单程 ~180 ms），`/api/state` 要 0.8–2 秒。换成同地域的私有桶（只存
`<state-key>` 和锁）后，单程降到 ~10 ms，接口耗时 40–60 ms。

网址用的那个桶**没有删**，里面还有网站 `index.html`。它的账本对象已经过期
（2026-11-08 切换时的快照），**不要**再拿它当账本用。

#### 回滚

把上面两个环境变量删掉（或改回香港那组），函数立刻回到旧桶。旧桶数据只到
2026-11-08 01:21，回滚会丢掉之后的交易，非必要不要回滚。

### 5. 验证

```bash
curl "https://<fc域名>/api/state?user=%E6%A2%A6%E6%BA%90"
curl -X POST "https://<fc域名>/api/trade" -H "Content-Type: application/json" -d '{"user":"player","side":"buy","amount":100}'
curl "https://<fc域名>/api/leaderboard"
```

状态存在 OSS `state/coin.json`；想重置市场/清空用户，直接在 OSS 控制台删掉这个对象即可。

> 规则常量在 `market-v2.js` 的 `RULES`：初始 1000 HTC / 100000 USDT、手续费 0.3%、5 秒 1 单、每天买卖各 5 次、单笔 ≤10000 HTC。

### 6. v2.1 追加接口（2026-10-29）

- `POST /api/signin` `{"user":"昵称"}`：服务端签到（09:30 后、工作日；连签 10/20/25/…/50；服务端时间判断，改手机时间无效）
- `POST /api/claim` `{"user":"昵称","amount":本地HTC整数}`：把单机钱包一次性并入共享账户（每人仅一次，上限 100000）
- 用户数据里新增 `merged / streak / lastSignDay`；`GET /api/state` 的 `user.signin` 返回连签与下次奖励

上传 `herta-mobile/coin-api-deploy.zip` 后重新「部署代码」即可。

### 7. v2.2 每日价格密钥（2026-11-07）

口径见 `docs/价格密钥-设计-2026-11-07.md`：切换日 `CUTOVER = 2026-11-07`（含当天）之前的日期
走旧的「日期派生」规则，**历史价格一根都不许变**；切换日起每天一把 16 字节随机密钥（32 位小写 hex），
由服务端生成、落盘在 `state/coin.json` 顶层 `seeds`，客户端取走后本地算 K 线。

派生规则（`coin-core.js`）：

| 用途 | 切换日之前 | 切换日（含）之后 |
|---|---|---|
| 日线 | `HTC\|daily\|<date>` | `HTC\|daily\|<date>\|<secret>` |
| 分钟路径 | `HTC\|intraday\|<date>` | `HTC\|intraday\|<date>\|<secret>` |

新接口：

```bash
curl "https://<fc域名>/api/seeds?from=2026-11-07"
# { "version": 1, "cutover": "2026-11-07", "seeds": { "2026-11-09": "<32 hex>" } }
```

- 只发 `[max(from, CUTOVER), 今天]` 区间里的**交易日**（周末不发）；`from` 早于 CUTOVER 按 CUTOVER 回，晚于今天就回空表；
- 缺的当场生成并**加锁**落盘：同一日期只生成一次，重复调用不会换密钥；旧状态没有 `seeds` 按空对象处理，不会清库；
- 服务端**没有密钥就是开不了盘**（`503 missing_secret`），不拿日期派生备用钥匙——那会和手机端算出两条线。
- 其它接口请求/响应形状不变（`/api/daily` 的 `bars` 这一轮先留着，给对账用），只是内部先读 `seeds` 再算；
  每个写盘的接口（`/api/state`、`/api/trade`、`/api/signin`、`/api/claim`）都会把已知密钥补回账本，
  免得老代码 / 读得早的实例把 `seeds` 覆盖掉（覆盖掉就会重摇一把，价格换条线）。

> 上线注意①：HTTP 触发器的路径要覆盖 `/api/*`（不是只挂 `/api/daily`），否则 `/api/seeds` 到不了函数。
> 上线注意②：切换日前把新代码部署到**所有实例**。旧版本函数不知道 `seeds`，写盘时会把它抹掉，
> 抹掉后不同实例可能各摇一把、算出两条价格线——这是唯一需要留心的滚动窗口。

---

## 安全：用户密钥（2026-11 起）

### 为什么有这一层

在这之前，`/api/trade` 和 `/api/state` **完全信任请求里的 `user` 字段**：

```bash
# 任何人，无凭据，就能读别人的持仓
curl "https://<fc域名>/api/state?user=源梦"

# 任何人，无凭据，就能替别人下单
curl -X POST "https://<fc域名>/api/trade" -d '{"user":"源梦","side":"sell","amount":99999}'
```

这不是理论问题，是当时线上的实际状态。`auth.js` 补的就是这一块：
**一把钥匙只开一个号。**

### 怎么工作

| 环节 | 说明 |
|---|---|
| 密钥 | 24 字节随机数的 48 位 hex，绑定时返回**一次** |
| 存储 | 服务端只存 `sha256(salt + secret)`，账本泄露也还原不出钥匙 |
| 传输 | 请求头 `X-Herta-Key`（首选）；`Authorization: Bearer` 也认；`?key=` 只给改不了原生层的客户端兜底 |
| 校验 | `timingSafeEqual`，长度或格式不对一律当失败 |

**接口：**

```bash
# 领取（没绑过就绑，绑过的必须出示原钥匙才放行）
curl -X POST "https://<fc域名>/api/bind" -d '{"user":"源梦"}'
# → { "ok": true, "secret": "<48 hex>", ... }   明文只出现这一次

# 换发（掉设备、怀疑泄露）：要 ADMIN_KEY，这个变量永远不进 APK
curl -X POST "https://<fc域名>/api/bind/reset" -d '{"user":"源梦","adminKey":"<ADMIN_KEY>"}'
```

### 三档开关 AUTH_MODE

| 值 | 行为 | 用在什么时候 |
|---|---|---|
| `off`（默认） | 完全不校验，和老版本一样 | 还没发新版客户端时 |
| `lenient` | 已绑定的必须带钥匙；没绑定的放行 | 希望用户慢慢升级时 |
| `strict` | 没绑定一律 403 `not_bound` | 新版客户端铺开之后 |

哪些接口要钥匙：`/api/state`、`/api/trade`、`/api/restart`、`/api/signin`、`/api/claim`。
`/api/daily`、`/api/seeds`、`/api/leaderboard` 仍然公开。

> ⚠️ `strict` **只在客户端已经会带钥匙之后**再开。老客户端不会调 `/api/bind`，
> 一开就再也读不到共享市场（行情不受影响，它是本地算的）。

### 限流

`ratelimit.js`，三层，默认开着：

| 变量 | 默认 | 含义 |
|---|---|---|
| `RATE_LIMIT` | `on` | `off` 关掉全部限流 |
| `RATE_GLOBAL_PER_MIN` | 2400 | 单实例每分钟总量，**钱包的最后一道闸** |
| `RATE_IP_PER_MIN` | 180 | 单 IP 每分钟 |
| `RATE_USER_PER_MIN` | 120 | 单昵称/单钥匙每分钟 |

超了回 `429` + `Retry-After`。计数器在进程内存里，**每个实例各算各的**——
真要做跨实例精确计数得上 Redis，为这个量级的接口不值得；防的是「被打爆」，不是「精确到个位」。

### 还没解决的

- **密钥丢了等于账号丢了**：换手机 / 清数据 / 重装都会丢，只能管理员 `/api/bind/reset` 换发。
  客户端应该把这句话写在界面上——目前只是文档里记着。
- **令牌/密钥都能被反编译拿到**：APK 里没有真正的秘密。这一层挡的是「随手 curl」，
  不是「铁了心逆向的人」。真防得住的是限流和预算告警。

