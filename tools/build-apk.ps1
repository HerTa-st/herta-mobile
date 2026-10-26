<#
  打一个 debug APK。

  为什么要这个脚本而不是一句 gradlew：这个工作区的沙箱不许写 `G:\gradle-home`
  （gradle 默认的 GRADLE_USER_HOME），所以把依赖缓存搬进仓库本地，构建才跑得动。
  换台机器时：GRADLE_HOME 指向任意一份解压好的 gradle（9.2.x 验过），
  缓存会自己按需下载到 .gradle-home。
#>
param(
  [string]$GradleHome = "$PSScriptRoot\..\.gradle-dist\gradle-9.2.1",
  [switch]$SkipWeb
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\.."
$app = Join-Path $root 'apps\phone'

if (-not $SkipWeb) {
  Write-Host '[1/3] 构建 web'
  Push-Location $root
  $env:npm_config_cache = Join-Path $root '.npm-cache'
  npm run build:phone
  Pop-Location
}

Write-Host '[2/3] 同步进 android 工程'
Push-Location $app
node (Join-Path $root 'node_modules\@capacitor\cli\bin\capacitor') sync android
Pop-Location

Write-Host '[3/3] 打包'
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
