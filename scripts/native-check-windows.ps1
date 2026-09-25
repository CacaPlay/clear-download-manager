param(
  [switch]$PrepareMediaRuntime,
  [switch]$SkipTests
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
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
      if ($_ -is [System.Management.Automation.ErrorRecord]) {
        Write-Host $_.ToString()
      }
      else {
        Write-Host $_
      }
    }
    $ExitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $PreviousPreference
  }

  if ($ExitCode -ne 0) {
    throw "$Command failed with exit code $ExitCode."
  }
}

& (Join-Path $PSScriptRoot "check-windows-toolchain.ps1")
if (-not $?) { throw "Windows toolchain validation failed." }

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

$RustGateArgs = @()
if ($SkipTests) { $RustGateArgs += "-SkipTests" }
& (Join-Path $PSScriptRoot "rust-gate-windows.ps1") @RustGateArgs
if ($LASTEXITCODE -ne 0 -or -not $?) {
  throw "The unified Rust gate failed. Review output\rust-gate."
}

if ($PrepareMediaRuntime) {
  Invoke-Native "npm" @("run", "prepare:windows-binaries")
  Invoke-Native "npm" @("run", "verify:binaries")
}

Write-Host "OK: CacaTools Download Manager native validation completed." -ForegroundColor Green
