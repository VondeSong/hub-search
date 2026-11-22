param(
  [int]$Port = 4173,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$Server = Join-Path $PSScriptRoot 'preview-server.cjs'
$ServerArgs = @($Server, $Port)
if (-not $NoOpen) { $ServerArgs += '--open' }
Write-Host "按 Ctrl+C 停止本地原型服务。"
node @ServerArgs
exit $LASTEXITCODE
