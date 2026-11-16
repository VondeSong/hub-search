param([string]$Device = "emulator-5564", [string[]]$Phases = @("journal", "tile", "cold", "postcold", "screens"), [switch]$SkipAppBuild, [string]$CleanupEditorDraftDeckId = "none")
$ErrorActionPreference = "Stop"
if ($Device -notmatch '^emulator-\d+$') { throw "请选择明确的 Android 模拟器；此入口不操作实体手机。" }
$desktop = Split-Path -Parent $PSScriptRoot
$androidProject = Join-Path $desktop "src-tauri/gen/android"
$runId = Get-Date -Format "yyyyMMdd-HHmmss"
$evidence = Join-Path $desktop ".local/mobile-flomo/emulator/$runId"
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android/Sdk" }
if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME "bin/java.exe"))) {
  $java = Get-ChildItem (Join-Path $env:USERPROFILE ".jdks") -Directory -Filter "jbr-21*" | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $java) { throw "没有可用的 Java 21。" }; $env:JAVA_HOME = $java.FullName
}
$adb = Join-Path $env:ANDROID_HOME "platform-tools/adb.exe"
if ((& $adb -s $Device get-state) -ne "device") { throw "模拟器未连接。" }
$abi = (& $adb -s $Device shell getprop ro.product.cpu.abi).Trim()
$target = switch ($abi) { "x86_64" { "X86_64" }; "arm64-v8a" { "Arm64" }; default { throw "未支持此架构。" } }
function Build-Gradle([string]$Task, [string]$Log) {
  try {
    $ErrorActionPreference = "Continue"
    & (Join-Path $androidProject "gradlew.bat") -p $androidProject $Task -x ":app:rustBuild${target}Debug" --console=plain *> (Join-Path $evidence $Log)
    $buildCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = "Stop" }
  if ($buildCode) { throw "Android 编译失败，见 $Log。" }
}
$apkTarget = if ($abi -eq "arm64-v8a") { "arm64" } else { $abi }
$appApk = Join-Path $androidProject "app/build/outputs/apk/$apkTarget/debug/app-$apkTarget-debug.apk"
if (-not $SkipAppBuild) {
  Build-Gradle ":app:assemble${target}Debug" "android-app-build.log"
  & $adb -s $Device install -r $appApk
  if ($LASTEXITCODE) { throw "当前应用覆盖安装失败；未清除 Hub 数据。" }
}
Build-Gradle ":app:assemble${target}DebugAndroidTest" "android-test-build.log"
if ($Phases -contains "cold") {
  Build-Gradle ":mobileAcceptance:assembleDebug" "cold-test-build.log"
  & $adb -s $Device install -r (Join-Path $androidProject "mobileAcceptance/build/outputs/apk/debug/mobileAcceptance-debug.apk")
  if ($LASTEXITCODE) { throw "冷启动验收程序安装失败。" }
}
$testApk = Get-ChildItem (Join-Path $androidProject "app/build/outputs/apk/androidTest") -Filter '*debug-androidTest.apk' -Recurse | Where-Object { $_.FullName -match [regex]::Escape(($abi -replace 'arm64-v8a','arm64')) } | Select-Object -First 1
if (-not $testApk) { throw "没有找到当前架构的 AndroidTest APK。" }
& $adb -s $Device install -r $testApk.FullName
if ($LASTEXITCODE) { throw "验收程序安装失败；未清除 Hub 数据。" }
$methods = @{ journal = "journalAndPrototypeRoundTrip"; feed = "journalFeedVideoAndLayout"; feedvisual = "journalFeedVisuals"; tile = "nativeTileRequestsAndWarmEntry"; draft = "prepareRichColdDraft"; restore = "restoreRichColdDraft"; cold = "actualProcessColdTileEntry"; postcold = "nativeDraftAfterColdRestart"; screens = "searchReviewEditorAndAppearance" }
$reports = @()
$draftHash = "not-set"
function Invoke-AcceptancePhase([string]$phase) {
  if (-not $methods.ContainsKey($phase)) { throw "未知检查范围：$phase" }
  $phaseFolder = Join-Path $evidence $phase
  New-Item -ItemType Directory -Force -Path $phaseFolder | Out-Null
  $testClass = "com.craftsearch.desktop.MobilePrototypeAcceptanceTest#$($methods[$phase])"
  $testRunner = "com.craftsearch.desktop.test/androidx.test.runner.AndroidJUnitRunner"
  $evidencePackage = "com.craftsearch.desktop"
  if ($phase -eq 'cold') { $testClass = 'com.craftsearch.desktop.MobileColdTileTest'; $testRunner = 'com.craftsearch.desktop.acceptance/androidx.test.runner.AndroidJUnitRunner'; $evidencePackage = 'com.craftsearch.desktop.acceptance' }
  & $adb -s $Device shell am instrument -w -r -e acceptanceRunId $runId -e acceptancePhase $phase -e cleanupEditorDraftDeckId $CleanupEditorDraftDeckId -e expectedDraftSha256 $draftHash -e class $testClass $testRunner *> (Join-Path $phaseFolder "instrumentation.log")
  $instrumentCode = $LASTEXITCODE
  try {
    $ErrorActionPreference = "Continue"
    & $adb -s $Device pull "/sdcard/Android/data/$evidencePackage/files/mobile-acceptance/$runId/$phase" (Join-Path $phaseFolder "device") *> (Join-Path $phaseFolder "pull.log")
  } finally { $ErrorActionPreference = "Stop" }
  $result = Join-Path $phaseFolder "device/result.json"
  if (-not (Test-Path $result)) { throw "未取得 $phase 设备回执，请检查 instrumentation.log。" }
  $report = Get-Content $result -Raw -Encoding UTF8 | ConvertFrom-Json
  $testLog = Get-Content (Join-Path $phaseFolder "instrumentation.log") -Raw
  if ($instrumentCode -ne 0 -or $testLog -notmatch 'OK \(1 test\)' -or $testLog -match 'FAILURES!!!' -or -not $report.completed -or $report.failure -or $report.restoreFailure) { throw "$phase 模拟器检查未全部通过，证据已保留：$evidence" }
  if ($report.runId -ne $runId) { throw "设备回执不属于本次测试。" }
  return $report
}
$prepared = $false
try {
  foreach ($phase in $Phases) {
    if ($phase -eq "cold") {
      $prepared = $true
      $fixture = Invoke-AcceptancePhase "draft"
      $reports += $fixture
      $draftHash = $fixture.draftSha256
    }
    $report = Invoke-AcceptancePhase $phase
    if ($phase -eq "tile") { $draftHash = $report.draftSha256 }
    $reports += $report
  }
} finally {
  if ($prepared) { $reports += Invoke-AcceptancePhase "restore" }
}
@{runId=$runId;device=$Device;completed=$true;reports=$reports;apkSha256=(Get-FileHash $appApk -Algorithm SHA256).Hash} | ConvertTo-Json -Depth 30 | Set-Content (Join-Path $evidence "summary.json") -Encoding UTF8
Write-Host "Evidence: $evidence"
Write-Host "模拟器实际客户端验收通过；已保留截图、逐项回执及原草稿恢复结果。"
