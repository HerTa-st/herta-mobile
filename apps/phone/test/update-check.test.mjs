import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkUpdate, judgeUpdate, parseUpdateManifest, UPDATE_URL } from "../src/update/check.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFile(path.join(here, "..", "src", rel), "utf8");

const good = { latest: "0.40.0", min: "0.30.0", url: "https://example.com/Herta.apk", note: "修了几个问题。" };

test("版本清单：只认形状完整的那份", () => {
  assert.deepEqual(parseUpdateManifest(good), good);
  assert.equal(parseUpdateManifest(null), null);
  assert.equal(parseUpdateManifest([]), null);
  assert.equal(parseUpdateManifest({ ...good, latest: "" }), null, "没有 latest 不收");
  assert.equal(parseUpdateManifest({ ...good, latest: "最新" }), null, "latest 不是版本号不收");
  assert.equal(parseUpdateManifest({ ...good, url: "" }), null, "没有下载地址不收");
  assert.equal(parseUpdateManifest({ ...good, url: "javascript:alert(1)" }), null, "只认 http(s)");
  assert.equal(parseUpdateManifest({ ...good, min: "随便写的" }).min, null, "min 写坏就当没写");
  assert.equal(parseUpdateManifest({ ...good, note: "   " }).note, null, "空白说明当没有");
});

test("比版本：有新版才提示，低于 min 才是必须更新", () => {
  const manifest = parseUpdateManifest(good);
  const newer = judgeUpdate(manifest, "0.35.0");
  assert.equal(newer.hasNew, true);
  assert.equal(newer.must, false, "0.35 > min 0.30，不强制");

  assert.equal(judgeUpdate(manifest, "0.40.0").hasNew, false, "一样就是最新");
  assert.equal(judgeUpdate(manifest, "0.41.0").hasNew, false, "比线上还新，不提示");

  const old = judgeUpdate(manifest, "0.20.0");
  assert.equal(old.hasNew, true);
  assert.equal(old.must, true, "低于 min 就是必须更新");

  const noMin = parseUpdateManifest({ ...good, min: undefined });
  assert.equal(judgeUpdate(noMin, "0.1.0").must, false, "没写 min 永远不强制");
});

test("取不到就静默：404 / 坏 JSON / 断网 / 超时都只是 ok:false", async () => {
  const json = (body, status = 200) =>
    async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const ok = await checkUpdate({ current: "0.1.0", fetchImpl: json(good) });
  assert.equal(ok.ok, true);
  assert.equal(ok.verdict.hasNew, true);

  const notFound = await checkUpdate({ current: "0.1.0", fetchImpl: json({}, 404) });
  assert.equal(notFound.ok, false);
  assert.match(notFound.detail, /404/);

  const broken = await checkUpdate({
    current: "0.1.0",
    fetchImpl: async () => new Response("<html>not json</html>", { status: 200 }),
  });
  assert.equal(broken.ok, false);
  assert.match(broken.detail, /读不懂/);

  const offline = await checkUpdate({
    current: "0.1.0",
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  assert.equal(offline.ok, false);
  assert.match(offline.detail, /没连上网/);

  const hang = await checkUpdate({
    current: "0.1.0",
    timeoutMs: 40,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
      }),
  });
  assert.equal(hang.ok, false, "超时也要有个结果，不能一直挂着");
  assert.match(hang.detail, /没回应/);
});

test("隐私：只 GET 一个静态文件，不带任何设备或用户信息", async () => {
  const source = await src("update/check.ts");
  assert.ok(source.includes('"https://www.herta-st-gp.top/version.json"'), "地址写死，只能从站点根取");
  assert.equal(UPDATE_URL, "https://www.herta-st-gp.top/version.json");

  const calls = [];
  await checkUpdate({
    current: "0.1.0",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(good), { status: 200 });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined, "GET 不该带 body");
  assert.deepEqual(Object.keys(calls[0].init.headers ?? {}), ["accept"], "只带一个 accept，不带任何标识");
  assert.equal(new URL(calls[0].url).search, "", "地址上不许挂查询串");
  assert.equal(/deviceId|model|imei|androidId|nickname|userName/.test(source), false, "不许读任何设备或用户字段");
  assert.equal(/localStorage|getKV/.test(source), false, "检查本身不碰本机存储（缓存那层不在这个文件里）");
});

test("界面：设置里挂红点、点开是独立一页、拉失败不留痕", async () => {
  const settings = await src("components/SettingsSheet.tsx");
  assert.ok(settings.includes("ss-dot"), "有新版要挂红点");
  assert.ok(settings.includes("onOpenUpdate"), "红点那一行要能压栈");
  assert.equal(/0\.\d+\.\d+/.test(settings), false, "版本号仍然只走 APP_VERSION");

  const routes = await src("nav/routes.ts");
  assert.match(routes, /update: \{ label: "版本更新", fullscreen: true \}/);

  const app = await src("App.tsx");
  assert.ok(app.includes("ensureUpdateChecked"), "启动要静默拉一次");
  assert.match(
    app,
    /setTimeout\(\(\) => \{\s*void ensureUpdateChecked\(\{ force: true \}\);\s*\}, 2000\)/,
    "延后拉，别挤在启动那一刻；启动这次要绕开缓存，否则重开 App 看不到新发的版"
  );
  assert.ok(settings.includes("useEffect"), "进设置时顺手看一眼");
  assert.ok(settings.includes("ensureUpdateChecked()"), "设置页那次走缓存，别每翻一次发一次请求");

  const sheet = await src("components/UpdateSheet.tsx");
  assert.ok(sheet.includes("去下载"), "要给下载按钮");
  assert.ok(sheet.includes("以后再说"), "不强制时能先放着");
  assert.ok(sheet.includes("这版不能再往后拖了"), "必须更新时文案更重");
  assert.ok(sheet.includes("不上报任何信息"), "页面上要写明只取清单");

  const store = await src("update/store.ts");
  assert.ok(store.includes("CHECK_TTL_MS"), "要缓存，别翻一次设置发一次请求");
  assert.ok(store.includes("emit("), "状态变了要通知界面");
  assert.equal(/toast|alert\(/.test(store), false, "拉失败不许弹任何东西");
});
