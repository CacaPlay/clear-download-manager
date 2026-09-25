param(
  [switch]$SkipTests,
  [string]$OutputDirectory = "output\rust-gate"
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$RustRoot = Join-Path $Root "src-tauri"
$Output = Join-Path $Root $OutputDirectory
Set-Location $Root

Remove-Item $Output -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Output -Force | Out-Null

function Invoke-RustGate {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $LogPath = Join-Path $Output "$Name.txt"
  $Started = Get-Date
  $Lines = New-Object System.Collections.Generic.List[string]
  $PreviousPreference = $ErrorActionPreference
  $ExitCode = 1
  $ErrorActionPreference = "Continue"
  Push-Location $RustRoot
  try {
    & cargo @Arguments 2>&1 | ForEach-Object {
      $Line = $_.ToString()
      [void]$Lines.Add($Line)
      Write-Host $Line
    }
    $ExitCode = $LASTEXITCODE
  }
  catch {
    [void]$Lines.Add(($_ | Out-String))
    Write-Host ($_ | Out-String)
  }
  finally {
    Pop-Location
    $ErrorActionPreference = $PreviousPreference
  }

  @(
    "Gate: $Name"
    "ExitCode: $ExitCode"
    "Started: $($Started.ToUniversalTime().ToString('o'))"
    "Finished: $((Get-Date).ToUniversalTime().ToString('o'))"
    "Arguments: cargo $($Arguments -join ' ')"
    ""
    ($Lines -join [Environment]::NewLine)
  ) | Set-Content $LogPath -Encoding UTF8

  return [pscustomobject]@{
    name = $Name
    exitCode = $ExitCode
    passed = ($ExitCode -eq 0)
    log = $LogPath
  }
}

if (-not (Test-Path (Join-Path $RustRoot "Cargo.lock"))) {
  Write-Host "Generating Cargo.lock for reproducible native builds..."
  $LockResult = Invoke-RustGate "cargo-generate-lockfile" @("generate-lockfile")
  if (-not $LockResult.passed) {
    throw "Cargo.lock could not be generated. Review $($LockResult.log)."
  }
}
if (-not (Test-Path (Join-Path $RustRoot "Cargo.lock"))) {
  throw "Cargo did not create Cargo.lock. Reproducible Windows builds cannot continue."
}

Write-Host "== Clear Download Manager 0.95.0 precompile audit ==" -ForegroundColor Cyan
& npm.cmd run check:0.25.1:precompile
if ($LASTEXITCODE -ne 0 -or -not $?) {
  throw "The precompile audit failed. Correct the source before running Cargo."
}

Write-Host "== Unified Rust gate: fmt + check + Clippy + tests ==" -ForegroundColor Cyan
$Results = New-Object System.Collections.Generic.List[object]
[void]$Results.Add((Invoke-RustGate "cargo-fmt" @("fmt", "--all", "--", "--check")))
[void]$Results.Add((Invoke-RustGate "cargo-check" @("check", "--locked", "--all-targets")))
[void]$Results.Add((Invoke-RustGate "cargo-clippy" @("clippy", "--locked", "--all-targets", "--", "-D", "warnings")))
if (-not $SkipTests) {
  [void]$Results.Add((Invoke-RustGate "cargo-test" @("test", "--locked", "--lib")))
}

# Windows PowerShell 5.1 can fail with "Argument types do not match" when
# an array subexpression wraps System.Collections.Generic.List[object] directly.
# Materialize a real object[] before building the ordered summary hashtable.
$GateArray = $Results.ToArray()
$Failures = @($GateArray | Where-Object { -not $_.passed })
$AllPassed = ($Failures.Count -eq 0)

$Summary = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  rustRoot = $RustRoot
  skippedTests = [bool]$SkipTests
  passed = $AllPassed
  gates = $GateArray
}
$SummaryPath = Join-Path $Output "rust-gate-summary.json"
$Summary | ConvertTo-Json -Depth 5 | Set-Content $SummaryPath -Encoding UTF8

if ($Failures.Count -gt 0) {
  Write-Host "" 
  Write-Host "RUST GATE FAILED: $($Failures.Count) stage(s) failed." -ForegroundColor Red
  foreach ($Failure in $Failures) {
    Write-Host " - $($Failure.name): exit $($Failure.exitCode) · $($Failure.log)" -ForegroundColor Red
  }
  Write-Host "All Rust stages were attempted. Review $SummaryPath for the complete result." -ForegroundColor Yellow
  throw "The unified Rust gate failed. Review $SummaryPath."
}

Write-Host "OK: fmt, cargo check, Clippy and Rust tests passed." -ForegroundColor Green
Write-Host "Report: $SummaryPath"
