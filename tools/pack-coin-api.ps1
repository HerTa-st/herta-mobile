<#
.SYNOPSIS
 把 fc/coin-api 打成可直接上传 FC 的部署包。

.DESCRIPTION
 只收 index.js / coin-core.js / seeds.js / news-pool.js / market-v2.js / oss-state.js / package.json
 这七个文件（根目录平铺，不带外层目录、不带 test/ 和 dev-server.mjs）。
 少一个就报错退出——seeds.js 漏掉的话密钥接口直接 500，事后很难看出来。

.EXAMPLE
 & tools/pack-coin-api.ps1
#>
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'fc/coin-api'
$zip  = Join-Path $root 'coin-api-deploy.zip'

$files = @('index.js', 'coin-core.js', 'seeds.js', 'news-pool.js', 'market-v2.js', 'oss-state.js', 'package.json')

$missing = $files | Where-Object { -not (Test-Path (Join-Path $src $_)) }
if ($missing) {
  Write-Host ('缺文件：' + ($missing -join ', ')) -ForegroundColor Red
  exit 1
}

if (Test-Path $zip) { Remove-Item $zip -Force }

Push-Location $src
try {
  Compress-Archive -Path $files -DestinationPath $zip -Force
} finally {
  Pop-Location
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$entries = [System.IO.Compression.ZipFile]::OpenRead($zip).Entries
$names = $entries | ForEach-Object { $_.FullName }
$extra = $names | Where-Object { $files -notcontains $_ }

Write-Host ('打包完成：' + $zip)
Write-Host ('大小：' + [math]::Round((Get-Item $zip).Length / 1KB, 1) + ' KB，' + $entries.Count + ' 个文件')
$entries | Sort-Object FullName | ForEach-Object { Write-Host ('  ' + $_.FullName + '  ' + $_.Length) }

if ($extra) {
  Write-Host ('警告：zip 里有不该带的东西：' + ($extra -join ', ')) -ForegroundColor Yellow
}
