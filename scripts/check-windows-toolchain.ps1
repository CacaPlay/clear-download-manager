Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$Root = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))

function Assert-BuildLocation {
  if ($PSVersionTable.PSVersion -lt [Version]"5.1") {
    throw "PowerShell 5.1 or newer is required."
  }
  if ($Root.StartsWith("\\")) {
    throw "Compile from a local NTFS drive, not a UNC or network path. Move the project to C:\CacaTools."
  }
  if ($Root.Length -gt 140) {
    throw "The project path is too long ($($Root.Length) characters). Move the source to C:\CacaTools before compiling."
  }
  if ($Root -match "\\(OneDrive|Dropbox|Google Drive)(\\|$)") {
    Write-Host "WARNING: the project is inside a synchronized folder. Move it to C:\CacaTools to avoid locked build files." -ForegroundColor Yellow
  }

  $DriveRoot = [System.IO.Path]::GetPathRoot($Root)
  $DriveName = $DriveRoot.TrimEnd('\').TrimEnd(':')
  $Drive = Get-PSDrive -Name $DriveName -ErrorAction SilentlyContinue
  if (-not $Drive) {
    throw "The local drive for the project could not be inspected."
  }
  $MinimumFreeBytes = 12GB
  if ([int64]$Drive.Free -lt $MinimumFreeBytes) {
    $FreeGiB = [Math]::Round(([double]$Drive.Free / 1GB), 2)
    throw "At least 12 GiB of free disk space is required. Available on ${DriveRoot}: $FreeGiB GiB."
  }

  $TempRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($env:TEMP))
  if ($TempRoot -and $TempRoot -ne $DriveRoot) {
    $TempDriveName = $TempRoot.TrimEnd('\').TrimEnd(':')
    $TempDrive = Get-PSDrive -Name $TempDriveName -ErrorAction SilentlyContinue
    if (-not $TempDrive -or [int64]$TempDrive.Free -lt 4GB) {
      $TempFreeGiB = if ($TempDrive) { [Math]::Round(([double]$TempDrive.Free / 1GB), 2) } else { 0 }
      throw "The Windows temporary drive needs at least 4 GiB free. Available on ${TempRoot}: $TempFreeGiB GiB."
    }
    Write-Host "OK: $([Math]::Round(([double]$TempDrive.Free / 1GB), 2)) GiB free on temporary drive $TempRoot"
  }

  $LongPaths = Get-ItemPropertyValue `
    -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
    -Name "LongPathsEnabled" `
    -ErrorAction SilentlyContinue
  if ($LongPaths -ne 1) {
    Write-Host "INFO: Windows long paths are disabled. The short C:\CacaTools path remains supported." -ForegroundColor Yellow
  }

  Write-Host "OK: build source path $Root"
  Write-Host "OK: $([Math]::Round(([double]$Drive.Free / 1GB), 2)) GiB free on $DriveRoot"
}

function Assert-Command {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Help
  )
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is not available. $Help"
  }
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @()
  )
  $PreviousPreference = $ErrorActionPreference
  $Lines = New-Object System.Collections.Generic.List[string]
  $ExitCode = 1
  $ErrorActionPreference = "Continue"
  try {
    & $Command @Arguments 2>&1 | ForEach-Object { [void]$Lines.Add($_.ToString()) }
    $ExitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $PreviousPreference
  }
  if ($ExitCode -ne 0) {
    throw "$Command $($Arguments -join ' ') failed with exit code $ExitCode."
  }
  return (($Lines -join [Environment]::NewLine).Trim())
}

if ($env:OS -ne "Windows_NT") {
  throw "This script must run on 64-bit Windows 10 or Windows 11."
}
Assert-BuildLocation
if (-not [Environment]::Is64BitOperatingSystem) {
  throw "CacaTools requires 64-bit Windows."
}

Assert-Command "node" "Install Node.js LTS."
Assert-Command "npm.cmd" "Node.js must include npm."
Assert-Command "rustup" "Install Rust through rustup."
Assert-Command "cargo" "Install Rust through rustup."
Assert-Command "rustc" "Install Rust through rustup."
Assert-Command "rustfmt" "Run: rustup component add rustfmt"
Assert-Command "cargo-clippy" "Run: rustup component add clippy"

$NodeVersion = Invoke-NativeCapture "node" @("--version")
$NodeMajor = [int]($NodeVersion.TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 20) {
  throw "Node.js 20 or newer is required. Detected: $NodeVersion"
}
$NodeArchitecture = Invoke-NativeCapture "node" @("-p", "process.arch")
if ($NodeArchitecture.Trim() -ne "x64") {
  throw "The x64 build of Node.js is required. Detected architecture: $NodeArchitecture"
}

$NpmVersion = Invoke-NativeCapture "npm.cmd" @("--version")
$RustVersion = Invoke-NativeCapture "rustc" @("--version")
$CargoVersion = Invoke-NativeCapture "cargo" @("--version")
$RustupVersion = Invoke-NativeCapture "rustup" @("--version")
$RustfmtVersion = Invoke-NativeCapture "rustfmt" @("--version")
$ClippyVersion = Invoke-NativeCapture "cargo" @("clippy", "--version")

$InstalledTargets = Invoke-NativeCapture "rustup" @("target", "list", "--installed")
if (($InstalledTargets -split "`r?`n") -notcontains "x86_64-pc-windows-msvc") {
  throw "The x86_64-pc-windows-msvc Rust target is missing. Run: rustup target add x86_64-pc-windows-msvc"
}
$ActiveToolchain = Invoke-NativeCapture "rustup" @("show", "active-toolchain")
if ($ActiveToolchain -notmatch "msvc") {
  throw "The active Rust toolchain must be MSVC. Run: rustup default stable-msvc"
}

$VswhereCandidates = @(
  "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe",
  "$env:ProgramFiles\Microsoft Visual Studio\Installer\vswhere.exe"
)
$Vswhere = $VswhereCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Vswhere) {
  throw "Visual Studio Build Tools was not found. Install Desktop development with C++ and the Windows SDK."
}

$VsPath = Invoke-NativeCapture $Vswhere @(
  "-latest", "-products", "*",
  "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
  "-property", "installationPath"
)
if (-not $VsPath) {
  throw "Visual Studio is installed, but MSVC x64/x86 is missing. Add Desktop development with C++."
}
$VsPath = ($VsPath -split "`r?`n" | Select-Object -First 1).Trim()
$ClExe = Get-ChildItem (Join-Path $VsPath "VC\Tools\MSVC") -Filter cl.exe -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "Hostx64\\x64\\cl\.exe$" } |
  Sort-Object FullName -Descending |
  Select-Object -First 1
if (-not $ClExe) {
  throw "MSVC was detected, but the x64 C++ compiler cl.exe was not found. Repair the Desktop development with C++ workload."
}

$WindowsKitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10"
$WindowsSdkInclude = Join-Path $WindowsKitsRoot "Include"
$WindowsSdkLib = Join-Path $WindowsKitsRoot "Lib"
$HasWindowsSdk = (Test-Path $WindowsSdkInclude) -and (Test-Path $WindowsSdkLib) -and
  [bool](Get-ChildItem $WindowsSdkInclude -Directory -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $HasWindowsSdk) {
  throw "The Windows 10/11 SDK was not found. Add a Windows SDK through Visual Studio Installer."
}

$WebView = Get-ChildItem "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients" -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
  Where-Object { $_.name -match "WebView2" } |
  Select-Object -First 1

Write-Host "OK: Windows x64"
Write-Host "OK: Node $NodeVersion ($NodeArchitecture), npm $NpmVersion"
Write-Host "OK: $RustVersion"
Write-Host "OK: $CargoVersion"
Write-Host "OK: $RustupVersion"
Write-Host "OK: $RustfmtVersion"
Write-Host "OK: $ClippyVersion"
Write-Host "OK: Rust target x86_64-pc-windows-msvc"
Write-Host "OK: Visual Studio Build Tools in $VsPath"
Write-Host "OK: MSVC compiler $($ClExe.FullName)"
Write-Host "OK: Windows SDK in $WindowsKitsRoot"
if ($WebView) {
  Write-Host "OK: WebView2 Runtime detected"
}
else {
  Write-Host "INFO: WebView2 was not found in the registry. The Tauri installer will use its bootstrapper."
}
