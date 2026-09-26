[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,
  [string]$MsysRoot = $(if ($env:MSYS2_ROOT) { $env:MSYS2_ROOT } else { 'C:\msys64' })
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$SourceArchiveName = 'ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz'
$SourceArchivePath = Join-Path $Root "third-party-source\ffmpeg\$SourceArchiveName"
$ExpectedSourceArchiveSha256 = 'b2891ffafd30bf26e7db0a6d68c1f98844fa02977919a895da561d297208cf58'
$ExpectedSourceArchiveBytes = 20504148L
$ExpectedFfmpegSha256 = 'e88ac9e6896275df773cde74e48a88312c3c76814956682440a0f8e52c35b74f'
$ExpectedFfmpegBytes = 31374848L
$ExpectedFfprobeSha256 = '787482513fe1031d2b8ec400aae34204f6f18d1ea9cc27d8b0643e5d3772c6c3'
$ExpectedFfprobeBytes = 31156736L
$ExpectedBuildInputsSha256 = '235df607cd1631110221e6272b9f35347ba32391ec304f600fdba2f3b517f8f0'
$BuildInputsPath = Join-Path $Root 'third-party-source\reviews\ffmpeg-9.0.2-safe-lean-build-inputs.json'
$ExpectedReviewSha256 = 'c09b218561033019939b2b076fca72cee253f743ec583467044b0d796fe1e0c9'
$ReviewPath = Join-Path $Root 'third-party-source\reviews\ffmpeg-9.0.2-safe-lean-distributor-review.md'
$FinalOutput = [IO.Path]::GetFullPath($OutputDirectory)

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-PinnedFile([string]$Path, [long]$ExpectedBytes, [string]$ExpectedSha256, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
  $file = Get-Item -LiteralPath $Path
  if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label must be a regular file, not a reparse point." }
  if ($ExpectedBytes -gt 0 -and $file.Length -ne $ExpectedBytes) { throw "$Label byte count mismatch: expected $ExpectedBytes, got $($file.Length)." }
  $actual = Get-Sha256 $Path
  if ($actual -ne $ExpectedSha256) { throw "$Label SHA-256 mismatch: expected $ExpectedSha256, got $actual." }
}

function ConvertTo-BashSingleQuoted([string]$Value) {
  return "'" + $Value.Replace("'", "'\''") + "'"
}

function Get-MsysPath([string]$Path, [string]$Cygpath) {
  $converted = & $Cygpath -u $Path
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$converted)) {
    throw "MSYS2 could not convert this path: $Path"
  }
  return ([string]$converted).Trim()
}

Assert-PinnedFile $SourceArchivePath $ExpectedSourceArchiveBytes $ExpectedSourceArchiveSha256 'SAFE LEAN corresponding-source archive'
Assert-PinnedFile $BuildInputsPath 0 $ExpectedBuildInputsSha256 'SAFE LEAN build-input record'
Assert-PinnedFile $ReviewPath 0 $ExpectedReviewSha256 'SAFE LEAN distributor review record'
if (Test-Path -LiteralPath $FinalOutput) { throw "Output directory already exists; use a new empty path: $FinalOutput" }

$Bash = Join-Path $MsysRoot 'usr\bin\bash.exe'
$Tar = Join-Path $MsysRoot 'usr\bin\tar.exe'
$Cygpath = Join-Path $MsysRoot 'usr\bin\cygpath.exe'
$Python = Join-Path $MsysRoot 'ucrt64\bin\python.exe'
foreach ($required in @($Bash, $Tar, $Cygpath, $Python)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "SAFE LEAN requires the pinned MSYS2 UCRT64 toolchain; missing: $required" }
}

$Work = Join-Path $env:TEMP ('cdm-safe-lean-runtime-' + [guid]::NewGuid().ToString('N'))
$PackageDirectory = Join-Path $Work 'corresponding-source'
$WheelDirectory = Join-Path $Work 'wheels'
$ToolchainDirectory = Join-Path $Work 'toolchain'
$BuildDirectory = Join-Path $Work 'build'
$BuiltOutputDirectory = Join-Path $Work 'built-output'
$BuildLog = Join-Path $Work 'build.log'
$LicensePath = Join-Path $Work 'COPYING.GPLv3'
$Succeeded = $false

try {
  New-Item -ItemType Directory -Path $Work, $PackageDirectory, $WheelDirectory | Out-Null
  $archivePosix = Get-MsysPath $SourceArchivePath $Cygpath
  $packagePosix = Get-MsysPath $PackageDirectory $Cygpath
  $rootTarCommand = "export PATH='/ucrt64/bin:/usr/bin'; tar -xJf $(ConvertTo-BashSingleQuoted $archivePosix) -C $(ConvertTo-BashSingleQuoted $packagePosix)"
  & $Bash -lc $rootTarCommand
  if ($LASTEXITCODE -ne 0) { throw 'Could not extract the pinned SAFE LEAN corresponding-source archive.' }

  $packageBuildScript = Join-Path $PackageDirectory 'tools\ffmpeg-safe-lean\build-safe-lean.sh'
  $packageWheelScript = Join-Path $PackageDirectory 'tools\ffmpeg-safe-lean\prepare-toolchain-wheels.ps1'
  $packageSources = Join-Path $PackageDirectory 'sources'
  foreach ($required in @($packageBuildScript, $packageWheelScript, $packageSources)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Pinned corresponding-source package is incomplete: $required" }
  }

  & $packageWheelScript -WheelDirectory $WheelDirectory -ToolchainDirectory $ToolchainDirectory -PythonExecutable $Python
  if ($LASTEXITCODE -ne 0) { throw 'The pinned Meson/Ninja wheel preparation failed.' }

  $toolchainPosix = Get-MsysPath $ToolchainDirectory $Cygpath
  $buildScriptPosix = Get-MsysPath $packageBuildScript $Cygpath
  $sourcesPosix = Get-MsysPath $packageSources $Cygpath
  $buildPosix = Get-MsysPath $BuildDirectory $Cygpath
  $builtOutputPosix = Get-MsysPath $BuiltOutputDirectory $Cygpath
  $licensePosix = Get-MsysPath $LicensePath $Cygpath
  $buildCommand = @(
    "export PATH=$(ConvertTo-BashSingleQuoted "$toolchainPosix/bin"):/ucrt64/bin:/usr/bin",
    "export PYTHONPATH=$(ConvertTo-BashSingleQuoted "$toolchainPosix/site-packages")",
    "bash $(ConvertTo-BashSingleQuoted $buildScriptPosix) --sources $(ConvertTo-BashSingleQuoted $sourcesPosix) --build-dir $(ConvertTo-BashSingleQuoted $buildPosix) --output-dir $(ConvertTo-BashSingleQuoted $builtOutputPosix)",
    "tar -xOzf $(ConvertTo-BashSingleQuoted "$(Get-MsysPath (Join-Path $packageSources 'ffmpeg-946fcce.tar.gz') $Cygpath)") --wildcards $(ConvertTo-BashSingleQuoted '*/COPYING.GPLv3') > $(ConvertTo-BashSingleQuoted $licensePosix)"
  ) -join "`n"
  $oldPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $Bash -lc $buildCommand *> $BuildLog
    $buildExitCode = $LASTEXITCODE
  }
  finally { $ErrorActionPreference = $oldPreference }
  if ($buildExitCode -ne 0) {
    if (Test-Path -LiteralPath $BuildLog) { Get-Content -LiteralPath $BuildLog -Tail 100 }
    throw "The pinned SAFE LEAN build failed with exit code $buildExitCode. Diagnostic files are preserved at $Work"
  }

  $ffmpegPath = Join-Path $BuiltOutputDirectory 'ffmpeg.exe'
  $ffprobePath = Join-Path $BuiltOutputDirectory 'ffprobe.exe'
  Assert-PinnedFile $ffmpegPath $ExpectedFfmpegBytes $ExpectedFfmpegSha256 'Canonical SAFE LEAN ffmpeg.exe'
  Assert-PinnedFile $ffprobePath $ExpectedFfprobeBytes $ExpectedFfprobeSha256 'Canonical SAFE LEAN ffprobe.exe'
  if (-not (Test-Path -LiteralPath $LicensePath -PathType Leaf) -or (Get-Item -LiteralPath $LicensePath).Length -lt 1000) {
    throw 'The pinned FFmpeg source archive did not yield its COPYING.GPLv3 text.'
  }
  if (-not (Select-String -LiteralPath $LicensePath -Pattern 'GNU GENERAL PUBLIC LICENSE' -Quiet)) {
    throw 'The extracted FFmpeg license text is not the expected GPL license.'
  }

  $buildConfigPath = Join-Path $BuiltOutputDirectory 'build-config.json'
  if (-not (Test-Path -LiteralPath $buildConfigPath -PathType Leaf)) { throw 'SAFE LEAN build-config.json is missing.' }
  $buildConfig = Get-Content -LiteralPath $buildConfigPath -Raw | ConvertFrom-Json
  if ($buildConfig.effectiveBuildLicense -ne 'GPL-3.0-or-later' -or
      $buildConfig.outputs.'ffmpeg.exe' -ne $ExpectedFfmpegSha256 -or
      $buildConfig.outputs.'ffprobe.exe' -ne $ExpectedFfprobeSha256) {
    throw 'SAFE LEAN build configuration does not match the approved GPL profile and canonical executable hashes.'
  }

  $buildReadme = @"
Clear Download Manager bundles the canonical SAFE LEAN FFmpeg 9.0.2 pair as external local tools.

Profile: SAFE LEAN
Effective license: GPL-3.0-or-later (--enable-gpl --enable-version3)
Upstream FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/946fcce07b6dcd0331c8cc609192aeff5e1924f8
Corresponding-source asset: $SourceArchiveName
Corresponding-source SHA-256: $ExpectedSourceArchiveSha256
Distributor review SHA-256: $ExpectedReviewSha256

Canonical Windows x64 outputs:
ffmpeg.exe  31,374,848 bytes  $ExpectedFfmpegSha256
ffprobe.exe 31,156,736 bytes  $ExpectedFfprobeSha256

The source package records the exact FFmpeg, x264, LAME, and dav1d source archives, their hashes, all build options, and the pinned MSYS2 UCRT64/Meson/Ninja toolchain. The package build script does not download source code or reuse prior binaries.

FFmpeg configuration includes static GPL/version 3 builds with FFmpeg, FFprobe, network and Schannel enabled; codecs include libx264, libmp3lame, and libdav1d. Exact configure and dependency flags are in build-options.json and the build script in the source package; each build generates build-config.json with its output hashes.

The complete corresponding source and notices are provided in the adjacent source archive. The source package does not include compiled outputs or compiler/runtime toolchain package binaries.
"@

  New-Item -ItemType Directory -Path (Split-Path -Parent $FinalOutput) -Force | Out-Null
  New-Item -ItemType Directory -Path $FinalOutput | Out-Null
  Copy-Item -LiteralPath $ffmpegPath -Destination (Join-Path $FinalOutput 'ffmpeg.exe')
  Copy-Item -LiteralPath $ffprobePath -Destination (Join-Path $FinalOutput 'ffprobe.exe')
  Copy-Item -LiteralPath $LicensePath -Destination (Join-Path $FinalOutput 'FFMPEG-LICENSE.txt')
  Set-Content -LiteralPath (Join-Path $FinalOutput 'FFMPEG-BUILD-README.txt') -Value $buildReadme -Encoding UTF8
  $Succeeded = $true
  Write-Host "Verified SAFE LEAN build outputs copied to $FinalOutput" -ForegroundColor Green
  Write-Host "ffmpeg.exe: $ExpectedFfmpegBytes bytes, SHA-256 $ExpectedFfmpegSha256"
  Write-Host "ffprobe.exe: $ExpectedFfprobeBytes bytes, SHA-256 $ExpectedFfprobeSha256"
}
finally {
  if ($Succeeded) {
    Remove-Item -LiteralPath $Work -Recurse -Force
  }
  else {
    Write-Warning "SAFE LEAN build workspace preserved for diagnosis: $Work"
  }
}
