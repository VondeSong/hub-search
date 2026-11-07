param([string]$ResultDirectory = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $projectRoot 'src-tauri\tests\windows-tdl\Cargo.toml'
$targetRoot = Join-Path $projectRoot 'src-tauri\target'
if ([string]::IsNullOrWhiteSpace($ResultDirectory)) {
    $ResultDirectory = Join-Path $projectRoot 'task-state\tdl-gui-regression'
}
$ResultDirectory = [IO.Path]::GetFullPath($ResultDirectory)
New-Item -ItemType Directory -Path $ResultDirectory -Force | Out-Null
& cargo build --manifest-path $manifest --target-dir $targetRoot --offline
if ($LASTEXITCODE -ne 0) { throw 'GUI transport fixture failed to build.' }
$helper = Join-Path $targetRoot 'debug\hub-tdl-gui-transport-test.exe'
$resultPath = Join-Path $ResultDirectory ('gui-transport-' + [Guid]::NewGuid().ToString('N') + '.json')
$testProcess = Start-Process -FilePath $helper -ArgumentList ('"' + $resultPath + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
if (-not $testProcess.WaitForExit(20000)) {
    # Stop only the process instance owned by this test, not other Hub/tdl runs.
    $testProcess.Kill()
    $testProcess.WaitForExit()
    throw 'GUI transport timed out, including terminal cleanup.'
}
if ($testProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $resultPath)) {
    throw 'GUI transport fixture did not return a result.'
}
$result = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($check in @('ready', 'unicodeOutput', 'inputAccepted', 'childSuccess', 'closed')) {
    if ($result.$check -ne $true) { throw "GUI transport check failed: $check" }
}
Write-Output 'PASS: Windows GUI terminal output, Unicode input, child exit and cleanup.'
Write-Output $resultPath
