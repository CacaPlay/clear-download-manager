param(
  [ValidateSet("nsis", "msi", "both")]
  [string]$Bundle = "nsis",
  [switch]$SkipMediaRuntime,
  [switch]$SkipTests,
  [switch]$SkipRustGate
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "powershell-hash-compat.ps1")
$Package = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$Version = [string]$Package.version
$ExtensionSourceManifest = Get-Content (Join-Path $Root "extension\manifest.json") -Raw | ConvertFrom-Json
$ExtensionVersion = [string]$ExtensionSourceManifest.version
$BuildId = "CDM-$Version-UI-BETA-20260910"
$Output = Join-Path $Root "output\windows-beta"
$CargoTargetFromConfig = $null
$CargoConfigPath = Join-Path $Root ".cargo\config.toml"
if (Test-Path -LiteralPath $CargoConfigPath) {
  $CargoConfigText = Get-Content -LiteralPath $CargoConfigPath -Raw
  $TargetMatch = [regex]::Match($CargoConfigText, '(?m)^\s*target-dir\s*=\s*"([^"]+)"')
  if ($TargetMatch.Success) {
    $ConfiguredTarget = $TargetMatch.Groups[1].Value
    $CargoTargetFromConfig = if ([IO.Path]::IsPathRooted($ConfiguredTarget)) {
      [IO.Path]::GetFullPath($ConfiguredTarget)
    }
    else {
      [IO.Path]::GetFullPath((Join-Path $Root $ConfiguredTarget))
    }
  }
}
$TauriTargetRoot = if (-not [string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
  [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
}
elseif ($CargoTargetFromConfig) {
  $CargoTargetFromConfig
}
else {
  Join-Path $Root "src-tauri\target"
}
$BundleRoot = Join-Path $TauriTargetRoot "release\bundle"
$BuildStarted = Get-Date
Set-Location $Root

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @()
  )
  $PreviousPreference = $ErrorActionPreference
  $ExitCode = 1
  $ErrorActionPreference = "Continue"
  try {
    & $Command @Arguments 2>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.ToString() }
      else { Write-Host $_ }
    }
    $ExitCode = $LASTEXITCODE
  }
  finally { $ErrorActionPreference = $PreviousPreference }
  if ($ExitCode -ne 0) { throw "$Command failed with exit code $ExitCode." }
}

function Get-NativeVersion {
  param([Parameter(Mandatory = $true)][string]$Command)
  $PreviousPreference = $ErrorActionPreference
  $Lines = New-Object System.Collections.Generic.List[string]
  $ExitCode = 1
  $ErrorActionPreference = "Continue"
  try {
    & $Command --version 2>&1 | ForEach-Object { [void]$Lines.Add($_.ToString()) }
    $ExitCode = $LASTEXITCODE
  }
  finally { $ErrorActionPreference = $PreviousPreference }
  if ($ExitCode -ne 0) { throw "$Command failed with exit code $ExitCode." }
  return (($Lines -join [Environment]::NewLine).Trim())
}

& (Join-Path $PSScriptRoot "check-windows-toolchain.ps1")
if (-not $?) { throw "Windows toolchain validation failed." }

Write-Host "== Clean build CacaTools Download Manager $Version ($BuildId) ==" -ForegroundColor Cyan
Remove-Item $Output -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $BundleRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $Root "src-tauri\target\release\cacatools.exe") -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Output -Force | Out-Null

if (Test-Path (Join-Path $Root "package-lock.json")) {
  Invoke-Native "npm.cmd" @("ci", "--no-audit", "--no-fund")
}
else {
  Invoke-Native "npm.cmd" @("install", "--no-audit", "--no-fund")
}
if (-not (Test-Path (Join-Path $Root "package-lock.json"))) {
  throw "npm did not create package-lock.json. Reproducible Windows builds cannot continue."
}
Invoke-Native "npm.cmd" @("run", "check:release")
Invoke-Native "npm.cmd" @("run", "extension:build")
Invoke-Native "npm.cmd" @("run", "check:extension")
Invoke-Native "npm.cmd" @("run", "build:web")

$SourceManifestHash = (Get-FileHash (Join-Path $Root "MANIFEST.sha256") -Algorithm SHA256).Hash.ToLowerInvariant()
$RequiredWebResources = @(
  "app-ui\subwindow.css"
)
foreach ($RelativeResource in $RequiredWebResources) {
  if (-not (Test-Path (Join-Path $Root "dist\$RelativeResource"))) {
    throw "The packaged web resource is missing from dist: $RelativeResource"
  }
}
$WebHashes = [ordered]@{
  index = (Get-FileHash (Join-Path $Root "dist\index.html") -Algorithm SHA256).Hash.ToLowerInvariant()
  javascript = (Get-FileHash (Join-Path $Root "dist\app-ui\main.js") -Algorithm SHA256).Hash.ToLowerInvariant()
  css = (Get-FileHash (Join-Path $Root "dist\app-ui\styles.css") -Algorithm SHA256).Hash.ToLowerInvariant()
  subwindowCss = (Get-FileHash (Join-Path $Root "dist\app-ui\subwindow.css") -Algorithm SHA256).Hash.ToLowerInvariant()
}

if (-not $SkipRustGate) {
  $RustGateArgs = @()
  if ($SkipTests) { $RustGateArgs += "-SkipTests" }
  & (Join-Path $PSScriptRoot "rust-gate-windows.ps1") @RustGateArgs
  if ($LASTEXITCODE -ne 0 -or -not $?) {
    throw "The unified Rust gate failed. Review output\rust-gate."
  }
}

if (-not $SkipMediaRuntime) {
  Invoke-Native "npm.cmd" @("run", "prepare:windows-binaries")
  Invoke-Native "npm.cmd" @("run", "verify:binaries")
}

# Keep the aggregate notices in the bundled resources aligned with the exact
# runtime license files that ship in this Windows package.
Invoke-Native "npm.cmd" @("run", "prepare:third-party-notices")

# The native host is shipped inside the Tauri resources and must be rebuilt
# from the checked-in source for every Windows package. A stale host binary
# can still answer ping while silently routing the published extension to an
# older protocol/app implementation.
$NativeHostProject = Join-Path $Root "extension\native-host"
$NativeHostTargetRoot = Join-Path ([IO.Path]::GetDirectoryName($TauriTargetRoot)) (([IO.Path]::GetFileName($TauriTargetRoot)) + "-native-host")
$NativeHostArtifact = Join-Path $NativeHostTargetRoot "release\cacatools-native-host.exe"
$NativeHostResource = Join-Path $Root "src-tauri\resources\extension\cacatools-native-host.exe"
Push-Location $NativeHostProject
$PreviousCargoTargetDirectory = $env:CARGO_TARGET_DIR
try {
  $env:CARGO_TARGET_DIR = $NativeHostTargetRoot
  Invoke-Native "cargo.exe" @("build", "--release", "--locked")
} finally {
  $env:CARGO_TARGET_DIR = $PreviousCargoTargetDirectory
  Pop-Location
}
if (-not (Test-Path -LiteralPath $NativeHostArtifact)) {
  throw "The native messaging host build completed without creating $NativeHostArtifact."
}
Copy-Item -LiteralPath $NativeHostArtifact -Destination $NativeHostResource -Force
Write-Host "OK: rebuilt and bundled Native Messaging host from extension/native-host." -ForegroundColor Green

$ExtensionZip = Join-Path $Root ("Clear-Download-Manager-Chrome-Extension-{0}.zip" -f $ExtensionVersion)
$ExtensionManifestPath = Join-Path $Root "extension-dist\manifest.json"
if (-not (Test-Path -LiteralPath $ExtensionZip) -or -not (Test-Path -LiteralPath $ExtensionManifestPath)) {
  throw "The synchronized extension package is missing after extension:build."
}
$ExtensionManifest = Get-Content -LiteralPath $ExtensionManifestPath -Raw | ConvertFrom-Json
if ([string]$ExtensionManifest.version -ne $ExtensionVersion) {
  throw "The extension package version does not match its source manifest: $($ExtensionManifest.version) != $ExtensionVersion."
}
$ExtensionConfigPath = Join-Path $Root "src-tauri\resources\extension\extension-config.json"
if (-not (Test-Path -LiteralPath $ExtensionConfigPath)) {
  throw "The bundled extension configuration is missing: $ExtensionConfigPath"
}
$ExtensionConfig = Get-Content -LiteralPath $ExtensionConfigPath -Raw | ConvertFrom-Json
$PublishedExtensionId = [string]$ExtensionConfig.chromiumExtensionIds[0]
if ([string]::IsNullOrWhiteSpace($PublishedExtensionId)) {
  throw "The bundled extension configuration has no Chromium extension ID."
}
$ExtensionZipHash = (Get-FileHash $ExtensionZip -Algorithm SHA256).Hash.ToLowerInvariant()
$ExtensionOutput = Join-Path $Output (Split-Path $ExtensionZip -Leaf)
Copy-Item -LiteralPath $ExtensionZip -Destination $ExtensionOutput -Force
Write-Host "OK: synchronized extension package $($ExtensionManifest.version) ($ExtensionZipHash)." -ForegroundColor Green

$BundleArgs = if ($Bundle -eq "both") { "nsis,msi" } else { $Bundle }
Invoke-Native "npx.cmd" @("--no-install", "tauri", "build", "--bundles", $BundleArgs)

& (Join-Path $PSScriptRoot "report-windows-size.ps1")
if ($LASTEXITCODE -ne 0 -or -not $?) { throw "The Windows size report could not be generated." }

$RawExecutable = Join-Path $TauriTargetRoot "release\cacatools-desktop.exe"
if (-not (Test-Path $RawExecutable)) {
  $RawExecutable = Join-Path $TauriTargetRoot "release\cacatools.exe"
}
if (Test-Path $RawExecutable) {
  # A cold first launch can spend several seconds initializing WebView2 and
  # registering the optional native extension host before SQLite is created.
  # Keep the smoke deterministic without masking real startup failures.
  & (Join-Path $PSScriptRoot "smoke-test-installed-beta.ps1") -Executable $RawExecutable -Seconds 20
  if ($LASTEXITCODE -ne 0 -or -not $?) { throw "The freshly compiled executable failed the startup smoke test." }
}
else {
  throw "The native executable was not found after the Tauri build."
}

$Artifacts = @(Get-ChildItem $BundleRoot -Recurse -File | Where-Object {
  $_.Extension -in ".exe", ".msi" -and $_.LastWriteTime -ge $BuildStarted.AddMinutes(-2)
})
if ($Artifacts.Count -eq 0) { throw "The clean build finished, but no new installer was found." }

$Copied = @()
foreach ($Artifact in $Artifacts) {
  if ($Artifact.Extension -eq ".exe") { $Name = "Clear_Download_Manager_${Version}_${BuildId}_x64-setup.exe" }
  elseif ($Artifact.Extension -eq ".msi") { $Name = "Clear_Download_Manager_${Version}_${BuildId}_x64.msi" }
  else { continue }
  $Destination = Join-Path $Output $Name
  Copy-Item $Artifact.FullName $Destination -Force
  $Copied += Get-Item $Destination
}
if ($Copied.Count -eq 0) { throw "No NSIS/MSI artifact was copied." }

$Report = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  version = $Version
  buildId = $BuildId
  bundle = $Bundle
  sourceDirectory = $Root
  rust = Get-NativeVersion "rustc"
  cargo = Get-NativeVersion "cargo"
  node = Get-NativeVersion "node"
  sourceManifestSha256 = $SourceManifestHash
  webHashes = $WebHashes
  extension = [ordered]@{
    version = [string]$ExtensionManifest.version
    chromiumExtensionId = $PublishedExtensionId
    zip = (Split-Path $ExtensionOutput -Leaf)
    bytes = (Get-Item $ExtensionOutput).Length
    sha256 = $ExtensionZipHash
    nativeHostSha256 = (Get-FileHash $NativeHostResource -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  lockFiles = [ordered]@{
    npm = Test-Path (Join-Path $Root "package-lock.json")
    cargo = Test-Path (Join-Path $Root "src-tauri\Cargo.lock")
  }
  artifacts = @()
}
foreach ($Artifact in $Copied) {
  $Hash = (Get-FileHash $Artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  "$Hash  $($Artifact.Name)" | Set-Content "$($Artifact.FullName).sha256" -Encoding ASCII
  $Report.artifacts += [ordered]@{ name = $Artifact.Name; bytes = $Artifact.Length; sha256 = $Hash }
}
$Report | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Output "build-report.json") -Encoding UTF8
$PreferredInstaller = $Copied | Where-Object Extension -eq '.exe' | Select-Object -First 1
if (-not $PreferredInstaller) { $PreferredInstaller = $Copied | Where-Object Extension -eq '.msi' | Select-Object -First 1 }
if (-not $PreferredInstaller) { throw "No installable NSIS/MSI artifact is available after the build." }
$InstallerKind = if ($PreferredInstaller.Extension -eq '.exe') { 'NSIS' } else { 'MSI' }
@"
INSTALL ONLY THIS FILE ($InstallerKind):
$($PreferredInstaller.Name)

Expected visible stamp inside the app:
v$Version - $BuildId

If that stamp is absent, an older installer was opened.
"@ | Set-Content (Join-Path $Output "INSTALL_THIS_BUILD.txt") -Encoding UTF8

Write-Host "Clean beta generated in $Output" -ForegroundColor Green
Get-ChildItem $Output | Format-Table Name, Length, LastWriteTime
