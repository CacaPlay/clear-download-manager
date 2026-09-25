param(
  [ValidateSet("nsis", "msi", "both")]
  [string]$Bundle = "nsis"
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Package = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$Version = [string]$Package.version
$LogDir = Join-Path $Root "output\first-native-build"
$Log = Join-Path $LogDir ("build-transcript-{0}.txt" -f $PID)
$TranscriptStarted = $false
$ExitCode = 0
Remove-Item $LogDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Set-Location $Root
try {
  Start-Transcript -Path $Log -Force | Out-Null
  $TranscriptStarted = $true
  Write-Host "== CacaTools Download Manager $Version - clean native Windows build =="
  & (Join-Path $PSScriptRoot "build-windows-beta.ps1") -Bundle $Bundle
  if ($LASTEXITCODE -ne 0 -or -not $?) { throw "The Windows build pipeline returned an error." }
  $WindowsBetaOutput = Join-Path $Root "output\windows-beta"
  if (-not (Test-Path $WindowsBetaOutput)) { throw "The build finished without creating output\windows-beta." }
  if (-not (Test-Path (Join-Path $WindowsBetaOutput "build-report.json"))) {
    throw "The build finished without a verified build-report.json."
  }
  Copy-Item (Join-Path $WindowsBetaOutput "*") $LogDir -Recurse -Force
  Write-Host "OK: verified installer candidate generated in $LogDir" -ForegroundColor Green
}
catch {
  $ExitCode = 1
  Write-Host "BUILD ERROR: $($_.Exception.Message)" -ForegroundColor Red
  if ($TranscriptStarted) { try { Stop-Transcript | Out-Null; $TranscriptStarted = $false } catch {} }
  try { & (Join-Path $PSScriptRoot "collect-windows-diagnostics.ps1") -OutputDirectory "output\native-diagnostics" }
  catch { Write-Host "WARNING: diagnostics collection also failed: $($_.Exception.Message)" -ForegroundColor Yellow }
  Write-Host "The build failed. Share output\native-diagnostics.zip and output\first-native-build\build-transcript.txt."
}
finally { if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch {} } }
exit $ExitCode
