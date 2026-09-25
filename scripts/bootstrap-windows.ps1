param(
  [switch]$InstallMissing,
  [switch]$SkipWebView2
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = Split-Path -Parent $PSScriptRoot
$Output = Join-Path $Root "output\windows-environment"
New-Item -ItemType Directory -Path $Output -Force | Out-Null
Set-Location $Root

function Refresh-ProcessPath {
  $MachinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $CargoPath = Join-Path $env:USERPROFILE ".cargo\bin"
  $Parts = @($MachinePath, $UserPath, $CargoPath) | Where-Object { $_ }
  $env:Path = ($Parts -join ";")
}

function Test-Tool {
  param([Parameter(Mandatory = $true)][string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-WingetInstall {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [string]$Override = "",
    [switch]$Force
  )
  if (-not (Test-Tool "winget")) {
    throw "winget is not available. Install App Installer from Microsoft Store or install the prerequisites manually."
  }
  $Arguments = @(
    "install", "--id", $Id, "--exact", "--silent",
    "--accept-source-agreements", "--accept-package-agreements",
    "--disable-interactivity"
  )
  if ($Override) { $Arguments += @("--override", $Override) }
  if ($Force) { $Arguments += "--force" }
  Write-Host "Installing $Id..." -ForegroundColor Cyan
  & winget @Arguments
  if ($LASTEXITCODE -ne 0) { throw "winget could not install $Id (exit code $LASTEXITCODE)." }
  Refresh-ProcessPath
}

if ($env:OS -ne "Windows_NT" -or -not [Environment]::Is64BitOperatingSystem) {
  throw "This build requires 64-bit Windows."
}

Refresh-ProcessPath
$Missing = New-Object System.Collections.Generic.List[string]
if (-not (Test-Tool "node")) { [void]$Missing.Add("Node.js LTS") }
if (-not (Test-Tool "npm.cmd")) { [void]$Missing.Add("npm") }
if (-not (Test-Tool "rustup")) { [void]$Missing.Add("rustup") }
if (-not (Test-Tool "cargo")) { [void]$Missing.Add("Cargo") }

$VswhereCandidates = @(
  "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe",
  "$env:ProgramFiles\Microsoft Visual Studio\Installer\vswhere.exe"
)
$Vswhere = $VswhereCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$HasMsvc = $false
if ($Vswhere) {
  $VsInstall = (& $Vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null | Select-Object -First 1)
  $HasMsvc = [bool]$VsInstall
}
if (-not $HasMsvc) { [void]$Missing.Add("Visual Studio Build Tools with Desktop development for C++") }

if ($Missing.Count -gt 0 -and -not $InstallMissing) {
  Write-Host "Missing Windows build prerequisites:" -ForegroundColor Yellow
  $Missing | ForEach-Object { Write-Host " - $_" }
  Write-Host "Run INSTALAR_REQUISITOS_WINDOWS.cmd once, then run COMPILAR_CACATOOLS_WINDOWS.cmd." -ForegroundColor Yellow
  exit 2
}

if ($InstallMissing) {
  if (-not (Test-Tool "node") -or -not (Test-Tool "npm.cmd")) {
    Invoke-WingetInstall -Id "OpenJS.NodeJS.LTS"
  }
  if (-not (Test-Tool "rustup") -or -not (Test-Tool "cargo")) {
    Invoke-WingetInstall -Id "Rustlang.Rustup"
  }
  $Vswhere = $VswhereCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  $HasMsvc = $false
  if ($Vswhere) {
    $VsInstall = (& $Vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null | Select-Object -First 1)
    $HasMsvc = [bool]$VsInstall
  }
  if (-not $HasMsvc) {
    Invoke-WingetInstall -Id "Microsoft.VisualStudio.2022.BuildTools" -Override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" -Force
  }
  if (-not $SkipWebView2) {
    try { Invoke-WingetInstall -Id "Microsoft.EdgeWebView2Runtime" } catch { Write-Host "WebView2 installer skipped: $($_.Exception.Message)" -ForegroundColor Yellow }
  }
  Refresh-ProcessPath
}

if (-not (Test-Tool "rustup")) { throw "rustup is not available after setup." }
& rustup default stable-msvc
if ($LASTEXITCODE -ne 0) { throw "rustup could not select stable-msvc." }
& rustup target add x86_64-pc-windows-msvc
if ($LASTEXITCODE -ne 0) { throw "rustup could not install the Windows MSVC target." }
& rustup component add rustfmt clippy
if ($LASTEXITCODE -ne 0) { throw "rustup could not install rustfmt and Clippy." }
Refresh-ProcessPath

& (Join-Path $PSScriptRoot "check-windows-toolchain.ps1")
if (-not $?) { throw "The Windows toolchain check failed." }

function Get-VersionText {
  param([Parameter(Mandatory = $true)][string]$Command)
  $Previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $Lines = @(& $Command --version 2>&1 | ForEach-Object { $_.ToString() })
    if ($LASTEXITCODE -ne 0) { return "unavailable" }
    return (($Lines -join [Environment]::NewLine).Trim())
  }
  finally { $ErrorActionPreference = $Previous }
}

$Report = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  computer = $env:COMPUTERNAME
  windows = [Environment]::OSVersion.VersionString
  architecture = $env:PROCESSOR_ARCHITECTURE
  node = Get-VersionText "node"
  npm = Get-VersionText "npm.cmd"
  rustc = Get-VersionText "rustc"
  cargo = Get-VersionText "cargo"
  rustup = Get-VersionText "rustup"
  sourceDirectory = $Root
}
$Report | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Output "environment-report.json") -Encoding UTF8
Write-Host "OK: Windows build environment is ready." -ForegroundColor Green
Write-Host "Report: $Output\environment-report.json"
