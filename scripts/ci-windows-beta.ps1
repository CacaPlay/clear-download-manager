param(
  [ValidateSet("nsis", "msi", "both")]
  [string]$Bundle = "nsis"
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = Split-Path -Parent $PSScriptRoot
$Package = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$Version = [string]$Package.version
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

Write-Host "== CacaTools Download Manager $Version - Windows CI build =="
Write-Host (Get-NativeVersion "node")
Write-Host (Get-NativeVersion "npm")
Write-Host (Get-NativeVersion "rustc")
Write-Host (Get-NativeVersion "cargo")

if (Test-Path (Join-Path $Root "package-lock.json")) {
  Invoke-Native "npm" @("ci", "--no-audit", "--no-fund")
}
else {
  Invoke-Native "npm" @("install", "--no-audit", "--no-fund")
}
if (-not (Test-Path (Join-Path $Root "package-lock.json"))) {
  throw "npm did not create package-lock.json. Reproducible Windows builds cannot continue."
}
Invoke-Native "npm" @("run", "check:release")
Invoke-Native "npm" @("run", "build:web")

# Run every Rust gate and collect every failure before downloading media runtimes.
& (Join-Path $PSScriptRoot "rust-gate-windows.ps1")
if ($LASTEXITCODE -ne 0 -or -not $?) {
  throw "The unified Rust gate failed. Review output\rust-gate."
}

Invoke-Native "npm" @("run", "prepare:windows-binaries")
Invoke-Native "npm" @("run", "verify:binaries")
& (Join-Path $PSScriptRoot "build-windows-beta.ps1") -Bundle $Bundle -SkipMediaRuntime -SkipTests -SkipRustGate
if ($LASTEXITCODE -ne 0 -or -not $?) { throw "build-windows-beta.ps1 returned an error." }
Write-Host "Windows CI build completed." -ForegroundColor Green
