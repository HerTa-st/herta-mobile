<#
  跑黑塔币页的浏览器冒烟验收（无头 Edge）。

  分两件事：
    1. 起本地 mock 接口（8787，COIN_MOCK_NOW 钉在 2026-10-29 10:15:30，盘中状态可复现）；
    2. 起 Vite dev server（5199，DEV 模式下页面会自动连 mock），跑 tools/coin-smoke.mjs。

  注意：无头 Edge 需要创建命名管道（Mojo IPC），DSH 沙箱下会被拒绝。
  要么在普通 PowerShell 里跑这个脚本，要么在 DSH 里用完全访问权限跑 `node tools/coin-smoke.mjs`。
#>
param(
  [string]$Port = '5199'
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\.."
$env:npm_config_cache = Join-Path $root '.npm-cache'
$env:COIN_MOCK_NOW = '2026-10-29T10:15:30+08:00'
$env:COIN_SMOKE_URL = "http://127.0.0.1:$Port/"

$mock = $null
$vite = $null
try {
  Write-Host '[1/3] 起 mock 接口 127.0.0.1:8787'
  $mock = Start-Process -FilePath node -ArgumentList 'fc/coin-api/dev-server.mjs' -WorkingDirectory $root -PassThru -WindowStyle Hidden

  Write-Host "[2/3] 起 Vite dev server 127.0.0.1:$Port"
  $vite = Start-Process -FilePath node -ArgumentList @(
    'node_modules/vite/bin/vite.js', '--port', $Port, '--strictPort', '--host', '127.0.0.1'
  ) -WorkingDirectory (Join-Path $root 'apps\phone') -PassThru -WindowStyle Hidden

  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    try {
      $ok = (Invoke-WebRequest "http://127.0.0.1:8787/api/daily" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200
      if ($ok) { break }
    } catch { Start-Sleep -Milliseconds 300 }
  }
  while ((Get-Date) -lt $deadline) {
    try {
      $ok = (Invoke-WebRequest $env:COIN_SMOKE_URL -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200
      if ($ok) { break }
    } catch { Start-Sleep -Milliseconds 300 }
  }

  Write-Host '[3/3] 跑浏览器验收'
  Push-Location $root
  node tools/coin-smoke.mjs
  $code = $LASTEXITCODE
  Pop-Location
} finally {
  if ($vite) { Stop-Process -Id $vite.Id -Force -ErrorAction SilentlyContinue }
  if ($mock) { Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue }
}

exit $code
