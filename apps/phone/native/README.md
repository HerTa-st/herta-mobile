# 原生源码（android/ 不进 git，这里是它的备份）

`apps/phone/android/` 整个目录被 .gitignore 忽略了：那是 `npx cap add android` 生成的东西。
但**生成它也长不出我们这几个 Java 文件**——HTTP 通道、相册、常驻服务都是手写的。
所以它们在这里存一份，换机器、重装依赖之后照下面的步骤搬回去。

## 恢复

```powershell
cd apps/phone
npx cap add android          # 只在 android/ 不存在时跑
Copy-Item native\java\com\personacli\herta\mobile\*.java android\app\src\main\java\com\personacli\herta\mobile\ -Force
Copy-Item native\AndroidManifest.xml android\app\src\main\AndroidManifest.xml -Force
Copy-Item native\res\drawable\window_background.xml android\app\src\main\res\drawable\ -Force
npx cap sync android
```

## 里面有什么

| 文件 | 干什么 |
| --- | --- |
| `HertaHttpPlugin.java` | 原生 HTTP，绕开 WebView 在 `https://localhost` 上的 CORS；SSE 按空行切块 |
| `HertaGalleryPlugin.java` | 相册：先列目录（便宜），再按 id 读一张（缩到长边 1024 / JPEG 80） |
| `HertaKeeperService.java` | 常驻前台服务：让进程活着，她到点才能主动说话 |
| `HertaKeepAlivePlugin.java` | 上面那个服务的开关（start / stop），外加"打开系统详情页" |
| `HertaLocationPlugin.java` | 定位，一次；用系统 LocationManager，不拉 play-services-location（省四兆） |
| `MainActivity.java` | 插件都在 `super.onCreate` **之前**注册；之后处理 Android 15 的「边到边」——把系统栏高度让出来，见下 |
| `AndroidManifest.xml` | 权限（含通知、精确闹钟、日历、前台服务）与 Service 声明 |

## 别忘的

- 改完这里要同步回 `android/`，不然下次打包用的还是旧的。
- `AndroidManifest.xml` 里 `HertaKeeperService` 的 `foregroundServiceType="specialUse"`
  和那条 `<property>` 是 Android 14+ 的硬要求，删了会在真机上直接起不来。
- `res/drawable/window_background.xml` 是边到边让出来那两条的底色（页面同款青白渐变）。
  换了主色记得一起改，不然状态栏底下会露出旧颜色。
