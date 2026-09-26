[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $SourcesDirectory,

  [Parameter(Mandatory = $true)]
  [string] $OutputPath,

  [string] $TarExe = 'C:\msys64\usr\bin\tar.exe',

  [string] $CygpathExe = 'C:\msys64\usr\bin\cygpath.exe'
)

$ErrorActionPreference = 'Stop'
$toolRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $toolRoot '..\..'))
$sourcesRoot = (Resolve-Path -LiteralPath $SourcesDirectory).Path
$outputFull = [IO.Path]::GetFullPath($OutputPath)
$outputParent = [IO.Path]::GetDirectoryName($outputFull)
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
  throw "Output parent directory does not exist: $outputParent"
}
if ($outputFull.StartsWith(($repoRoot + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Candidate archive must be created outside the repository.'
}
if (Test-Path -LiteralPath $outputFull) { throw "Output already exists: $outputFull" }
if (-not (Test-Path -LiteralPath $TarExe -PathType Leaf)) { throw "GNU tar is missing: $TarExe" }
if (-not (Test-Path -LiteralPath $CygpathExe -PathType Leaf)) { throw "MSYS2 cygpath is missing: $CygpathExe" }

function ConvertTo-MsysPath {
  param([Parameter(Mandatory = $true)][string] $Path)

  $converted = (& $CygpathExe -u $Path | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "cygpath failed to convert path: $Path" }
  if ([string]::IsNullOrWhiteSpace($converted)) { throw "cygpath returned an empty path for: $Path" }
  return $converted
}

$manifest = Get-Content -LiteralPath (Join-Path $toolRoot 'source-inputs.json') -Raw | ConvertFrom-Json
$stage = "$outputFull.staging"
if (Test-Path -LiteralPath $stage) { throw "Staging directory already exists: $stage" }
$packageRoot = New-Item -ItemType Directory -Path $stage
$null = New-Item -ItemType Directory -Path (Join-Path $packageRoot 'sources')
$toolPackageDir = Join-Path $packageRoot 'tools\ffmpeg-safe-lean'
$null = New-Item -ItemType Directory -Force -Path $toolPackageDir
$testPackageDir = Join-Path $toolPackageDir 'tests'
$null = New-Item -ItemType Directory -Path $testPackageDir

$fileList = @(
  'README.md',
  'LICENSE-INVENTORY.md',
  'source-inputs.json',
  'toolchain.lock.json',
  'build-options.json'
)
foreach ($relative in $fileList) {
  Copy-Item -LiteralPath (Join-Path $toolRoot $relative) -Destination $packageRoot
}
foreach ($relative in @('build-safe-lean.sh', 'prepare-toolchain-wheels.ps1', 'verify-sha256.sh', 'verify-toolchain.py')) {
  Copy-Item -LiteralPath (Join-Path $toolRoot $relative) -Destination $toolPackageDir
}
Copy-Item -LiteralPath (Join-Path $toolRoot 'tests\build-tooling.test.mjs') -Destination $testPackageDir

foreach ($component in $manifest.components) {
  $sourceFile = Join-Path $sourcesRoot $component.archive.name
  if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { throw "Missing source archive: $($component.archive.name)" }
  $item = Get-Item -LiteralPath $sourceFile
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Source archive cannot be a reparse point: $($component.archive.name)" }
  $actual = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $component.archive.sha256) { throw "Source archive SHA-256 mismatch: $($component.archive.name)" }
  Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $packageRoot 'sources')
}

$files = Get-ChildItem -LiteralPath $packageRoot -Recurse -File | Sort-Object FullName
$sumLines = foreach ($file in $files) {
  $relative = [IO.Path]::GetRelativePath($packageRoot.FullName, $file.FullName).Replace('\', '/')
  $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $relative"
}
Set-Content -LiteralPath (Join-Path $packageRoot 'SHA256SUMS.txt') -Value $sumLines -Encoding ascii
$contentRecords = foreach ($file in (Get-ChildItem -LiteralPath $packageRoot -Recurse -File | Sort-Object FullName)) {
  $relative = [IO.Path]::GetRelativePath($packageRoot.FullName, $file.FullName).Replace('\', '/')
  [ordered]@{ path = $relative; bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
}
[ordered]@{ schemaVersion = 1; archiveName = [IO.Path]::GetFileName($outputFull); files = $contentRecords } |
  ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $packageRoot 'PACKAGE-CONTENTS.json') -Encoding utf8

$previousXz = $env:XZ_OPT
try {
  $env:XZ_OPT = '-9e'
  $tarOutputPath = ConvertTo-MsysPath -Path $outputFull
  $tarPackagePath = ConvertTo-MsysPath -Path $packageRoot.FullName
  & $TarExe --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner `
    --format=posix --pax-option=delete=atime,delete=ctime `
    -J --create --file $tarOutputPath --directory $tarPackagePath '.'
  if ($LASTEXITCODE -ne 0) { throw "GNU tar failed with exit code $LASTEXITCODE" }
}
finally {
  if ($null -eq $previousXz) { Remove-Item Env:\XZ_OPT -ErrorAction SilentlyContinue }
  else { $env:XZ_OPT = $previousXz }
}

$archiveHash = (Get-FileHash -LiteralPath $outputFull -Algorithm SHA256).Hash.ToLowerInvariant()
$archiveSize = (Get-Item -LiteralPath $outputFull).Length
"Created: $outputFull"
"Bytes: $archiveSize"
"SHA-256: $archiveHash"
