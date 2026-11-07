$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$configuration = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot 'src-tauri\tauri.conf.json') | ConvertFrom-Json
$releaseRoot = Join-Path $projectRoot 'src-tauri\target\release'
$cargoTargetRoot = Join-Path $projectRoot 'src-tauri\target'
if (-not [string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
    if (-not [System.IO.Path]::IsPathRooted($env:CARGO_TARGET_DIR)) {
        throw 'CARGO_TARGET_DIR must be absolute when packaging a portable executable.'
    }
    $cargoTargetRoot = [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
}
$source = Join-Path $cargoTargetRoot 'release\craft-search.exe'
$portableDirectory = Join-Path $releaseRoot 'bundle\portable'
$portableName = ($configuration.productName -replace '[\\/:*?"<>|]', '_').Trim()
$target = Join-Path $portableDirectory ("{0}_{1}_x64_portable.exe" -f $portableName, $configuration.version)

if (-not (Test-Path -LiteralPath $source)) {
    throw "Production executable was not generated: $source"
}

$executableText = [System.Text.Encoding]::ASCII.GetString(
    [System.IO.File]::ReadAllBytes($source)
)
if ($executableText -notmatch 'assets/index-[A-Za-z0-9_-]+\.js') {
    throw "Refusing to package an executable without embedded frontend assets. Build with the custom-protocol feature through the Tauri CLI."
}

New-Item -ItemType Directory -Path $portableDirectory -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force
$runtimeFiles = @()
foreach ($resource in $configuration.bundle.resources.PSObject.Properties) {
    if ([System.IO.Path]::GetFileName($resource.Value) -ne $resource.Value) { throw 'Portable resources must have an explicit top-level filename.' }
    $runtimeSource = [System.IO.Path]::GetFullPath((Join-Path $projectRoot ('src-tauri\' + $resource.Name)))
    if (-not (Test-Path -LiteralPath $runtimeSource)) { throw "Required built-in memory component is missing: $runtimeSource" }
    $runtimeTarget = Join-Path $portableDirectory $resource.Value
    Copy-Item -LiteralPath $runtimeSource -Destination $runtimeTarget -Force
    $runtimeFiles += $runtimeTarget
}
$portableZip = [System.IO.Path]::ChangeExtension($target, '.zip')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipStream = [System.IO.File]::Open($portableZip, [System.IO.FileMode]::Create)
try {
    $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in (@($target) + $runtimeFiles)) {
            $entryName = if ($file -eq $target) { 'Hub.exe' } else { [System.IO.Path]::GetFileName($file) }
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file, $entryName, [System.IO.Compression.CompressionLevel]::NoCompression) | Out-Null
        }
    } finally { $archive.Dispose() }
} finally { $zipStream.Dispose() }
Write-Output $target
Write-Output $portableZip
