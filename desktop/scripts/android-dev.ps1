param([string]$Device = "emulator-5564")
$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path $desktopRoot ".local/android-dev"
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null

if ($Device -notmatch '^emulator-\d+$') { throw "此入口用于安卓模拟器，请明确选择 emulator-* 设备。" }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android/Sdk" }
if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME "bin/java.exe"))) {
  $javaSdk = Get-ChildItem (Join-Path $env:USERPROFILE ".jdks") -Directory -Filter "jbr-21*" | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $javaSdk) { throw "未找到 Java 21，请配置 JAVA_HOME。" }
  $env:JAVA_HOME = $javaSdk.FullName
}
if (-not $env:NDK_HOME) { $env:NDK_HOME = Join-Path $env:ANDROID_HOME "ndk/26.3.11579264" }
if (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = "4" }
$env:CARGO_TARGET_DIR = Join-Path $desktopRoot "src-tauri/target"
$adb = Join-Path $env:ANDROID_HOME "platform-tools/adb.exe"
if ((& $adb -s $Device get-state 2>$null) -ne "device") { throw "请先启动模拟器 $Device。" }
& $adb -s $Device reverse tcp:1422 tcp:1422
if ($LASTEXITCODE -ne 0) { throw "模拟器开发端口映射失败。" }

$node = (Get-Command node).Source
$listener = Get-NetTCPConnection -LocalPort 1422 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  $source = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:1422/src/App.tsx").Content
  if (-not $source.Contains(($desktopRoot -replace '\\','/') + "/src/App.tsx")) { throw "1422 已由其他工作区使用，未停止该服务。" }
} else {
  $vite = Join-Path $desktopRoot "node_modules/vite/bin/vite.js"
  Start-Process -FilePath $node -ArgumentList @("`"$vite`"", "--config", "vite.android.config.ts") -WorkingDirectory $desktopRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateRoot "vite.log") -RedirectStandardError (Join-Path $stateRoot "vite.err.log") | Out-Null
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { $ready = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:1422/@vite/client").StatusCode -eq 200 } catch {}
    if ($ready) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw "安卓界面服务未启动，请查看 .local/android-dev/vite.err.log。" }
}

$architectures = @{
  "x86_64" = @("x86_64-linux-android", "X86_64", "x86_64")
  "arm64-v8a" = @("aarch64-linux-android", "Arm64", "arm64")
}
$abi = (& $adb -s $Device shell getprop ro.product.cpu.abi).Trim()
$architecture = $architectures[$abi]
if (-not $architecture) { throw "暂不支持此模拟器架构：$abi" }
$tauriCli = Join-Path $desktopRoot "node_modules/@tauri-apps/cli/tauri.js"
$devConfig = Join-Path $desktopRoot "src-tauri/tauri.android.dev.conf.json"
$nativeLog = Join-Path $stateRoot "native.log"
$emulatorName = (& $adb -s $Device emu avd name | Select-Object -First 1).Trim()
if (-not $emulatorName -or $emulatorName -eq "OK") { throw "未取得目标模拟器名称。" }
Push-Location $desktopRoot
try {
  Write-Host "安卓界面连接当前工作区 1422 端口；正在构建开发版。"
  # Windows PowerShell treats native informational stderr as an error record.
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $node $tauriCli android dev $emulatorName --host 127.0.0.1 --no-watch --config $devConfig *> $nativeLog
    $nativeCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  if ($nativeCode -ne 0) {
    $nativeOutput = Get-Content $nativeLog -Raw
    if ($nativeOutput -notmatch 'Failed to create a symbolic link|Creation symbolic link is not allowed') { throw "安卓开发版构建失败，请查看 $nativeLog" }
    $nativeTarget = [regex]::Match(($nativeOutput -replace '\r?\n\s*',''), '(aarch64|x86_64)-linux-android[/\\]+debug[/\\]+libcraft_search_lib\.so')
    if (-not $nativeTarget.Success) { throw "无法确认 Tauri 已编译的原生架构，停止组装。" }
    $abi = if ($nativeTarget.Groups[1].Value -eq "aarch64") { "arm64-v8a" } else { "x86_64" }
    if ((& $adb -s $Device shell getprop ro.product.cpu.abilist) -notmatch [regex]::Escape($abi)) { throw "模拟器不支持本次编译的 $abi。" }
    $architecture = $architectures[$abi]
    # Windows without link privileges still uses the exact library produced by Tauri.
    $library = Join-Path $env:CARGO_TARGET_DIR "$($architecture[0])/debug/libcraft_search_lib.so"
    if (-not (Test-Path $library)) { throw "未生成开发版原生库，停止组装。" }
    $androidRoot = Join-Path $desktopRoot "src-tauri/gen/android"
    $destination = Join-Path $androidRoot "app/src/main/jniLibs/$abi"
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -LiteralPath $library -Destination (Join-Path $destination "libcraft_search_lib.so") -Force
    try {
      $ErrorActionPreference = "Continue"
      & (Join-Path $androidRoot "gradlew.bat") -p $androidRoot ":app:assemble$($architecture[1])Debug" -x ":app:rustBuild$($architecture[1])Debug" --console=plain *> (Join-Path $stateRoot "gradle.log")
      $gradleCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($gradleCode -ne 0) { throw "开发版组装失败，请查看 .local/android-dev/gradle.log。" }
    $apk = Join-Path $androidRoot "app/build/outputs/apk/$($architecture[2])/debug/app-$($architecture[2])-debug.apk"
    & $adb -s $Device install -r $apk
    if ($LASTEXITCODE -ne 0) { throw "覆盖安装开发版失败；未卸载或清除应用数据。" }
    & $adb -s $Device shell am start -W -n com.craftsearch.desktop/.MainActivity
    if ($LASTEXITCODE -ne 0) { throw "开发版启动失败。" }
  }
  Write-Host "安卓开发模式已连接 http://127.0.0.1:1422。修改界面会自动更新；原生修改后重新运行 npm run android:dev。"
} finally { Pop-Location }
