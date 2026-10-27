<#
  打一个 debug APK。

  为什么要这个脚本而不是一句 gradlew：这个工作区的沙箱不许写 `G:\gradle-home`
  （gradle 默认的 GRADLE_USER_HOME），所以把依赖缓存搬进仓库本地，构建才跑得动。
  换台机器时：GRADLE_HOME 指向任意一份解压好的 gradle（9.2.x 验过），
  缓存会自己按需下载到 .gradle-home。
#>
param(
  [string]$GradleHome = "$PSScriptRoot\..\.gradle-dist\gradle-9.2.1",
  [switch]$SkipWeb,
  # normal=正常版；pure=带那 628 条对话；blank=白纸版（什么都不带）
  [ValidateSet('normal', 'pure', 'blank')]
  [string]$Variant = 'normal'
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\.."
$app = Join-Path $root 'apps\phone'

# -GradleHome 默认指向仓库内的 .gradle-dist（换机器时放这儿）；这台机器上那份没有解压到
# 那里，gradle wrapper 早就把 9.2.1 下到 G: 了，于是往那边找一次。都没找到再说清楚要什么，
# 而不是让 & 报一句「不是 cmdlet」——那句对下一个人毫无帮助。
if (-not (Test-Path (Join-Path $GradleHome 'bin\gradle.bat'))) {
  $cached = Get-ChildItem 'G:\gradle-home\wrapper\dists\gradle-9.2.1-bin' -Recurse -Depth 3 -Filter 'gradle.bat' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($cached) { $GradleHome = Split-Path (Split-Path $cached.FullName -Parent) -Parent }
}
if (-not (Test-Path (Join-Path $GradleHome 'bin\gradle.bat'))) {
  throw "找不到 gradle：$GradleHome 下没有 bin\gradle.bat。把解压好的 gradle 放进去，或用 -GradleHome 指定。"
}
Write-Host ("[0/4] gradle: " + $GradleHome)

if (-not $SkipWeb) {
  Write-Host '[1/4] 类型检查'
  Push-Location $root
  $env:npm_config_cache = Join-Path $root '.npm-cache'
  node node_modules\typescript\bin\tsc -p apps\phone\tsconfig.json --noEmit
  if ($LASTEXITCODE -ne 0) { throw '类型检查没过，不打包' }

  Write-Host ('[2/4] 构建 web（' + $Variant + '）')
  $script = switch ($Variant) {
    'pure' { 'build:pure' }
    'blank' { 'build:blank' }
    default { 'build:phone' }
  }
  npm run $script
  Pop-Location
}

Write-Host '[3/4] 同步进 android 工程'
Push-Location $app
node (Join-Path $root 'node_modules\@capacitor\cli\bin\capacitor') sync android
Pop-Location

Write-Host '[4/4] 打包'
# 增量打包会把上一版删掉的大文件留成 APK 里的空洞（这次删了 1.8MB 的 png 闪屏，
# 产物反而从 7.3MB 涨到 9.5MB——空洞不会自己消失）。先删旧产物，让 gradle 从零写。
Remove-Item (Join-Path $app 'android\app\build\outputs\apk\debug\app-debug.apk') -ErrorAction SilentlyContinue
$env:GRADLE_USER_HOME = Join-Path $root '.gradle-home'
$env:ANDROID_HOME = 'E:\android-sdk'
Push-Location (Join-Path $app 'android')
& (Join-Path $GradleHome 'bin\gradle.bat') assembleDebug --console=plain
Pop-Location

$apk = Join-Path $app 'android\app\build\outputs\apk\debug\app-debug.apk'
if (Test-Path $apk) {
  Write-Host ""
  Write-Host ("APK: " + $apk)
  Write-Host ("大小: {0:N1} MB" -f ((Get-Item $apk).Length / 1MB))
} else {
  throw '没找到 APK，构建失败了'
}
