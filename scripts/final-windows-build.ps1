param(
  [ValidateSet("nsis", "msi", "both")]
  [string]$Bundle = "nsis",
  [switch]$InstallMissing
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "powershell-hash-compat.ps1")
$Output = Join-Path $Root "output\final-windows-build"
$Transcript = Join-Path $Output ("final-build-transcript-{0}.txt" -f $PID)
$TranscriptStarted = $false
$ExitCode = 0
Set-Location $Root

Remove-Item $Output -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Output -Force | Out-Null

try {
  Start-Transcript -Path $Transcript -Force | Out-Null
  $TranscriptStarted = $true

  if ($InstallMissing) {
    & (Join-Path $PSScriptRoot "bootstrap-windows.ps1") -InstallMissing
  }
  else {
    & (Join-Path $PSScriptRoot "bootstrap-windows.ps1")
  }
  if ($LASTEXITCODE -ne 0 -or -not $?) { throw "The Windows build environment is not ready." }

  & (Join-Path $PSScriptRoot "first-native-build.ps1") -Bundle $Bundle
  if ($LASTEXITCODE -ne 0 -or -not $?) { throw "The native build did not complete." }

  $Candidate = Join-Path $Root "output\first-native-build"
  if (-not (Test-Path $Candidate)) { throw "The verified build output was not created." }
  $CandidateReportPath = Join-Path $Candidate "build-report.json"
  if (-not (Test-Path $CandidateReportPath)) { throw "The verified build report was not created." }
  $CandidateReport = Get-Content $CandidateReportPath -Raw | ConvertFrom-Json
  $CurrentSourceManifestHash = (Get-FileHash (Join-Path $Root "MANIFEST.sha256") -Algorithm SHA256).Hash.ToLowerInvariant()
  if ([string]$CandidateReport.sourceManifestSha256 -ne $CurrentSourceManifestHash) {
    throw "The installer was not built from the current verified source manifest."
  }
  Copy-Item (Join-Path $Candidate "*") $Output -Recurse -Force

  $LockSummary = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    packageLock = Test-Path (Join-Path $Root "package-lock.json")
    cargoLock = Test-Path (Join-Path $Root "src-tauri\Cargo.lock")
    note = "Keep both lock files with the source after the first successful build."
  }
  $LockSummary | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $Output "lock-files.json") -Encoding UTF8

  $SourceLocks = Join-Path $Output "source-locks"
  New-Item -ItemType Directory -Path $SourceLocks -Force | Out-Null
  Copy-Item (Join-Path $Root "package-lock.json") (Join-Path $SourceLocks "package-lock.json") -Force
  Copy-Item (Join-Path $Root "src-tauri\Cargo.lock") (Join-Path $SourceLocks "Cargo.lock") -Force

  # Include the same reproducible UI evidence used during the source gate.
  # These images are not installer assets; they are a visual handoff for the user.
  $ScreenshotOutput = Join-Path $Output "screenshots"
  New-Item -ItemType Directory -Path $ScreenshotOutput -Force | Out-Null
  $ScreenshotFiles = @(
    "docs\screenshots\phase22\command-dark-1920x1080.png",
    "docs\screenshots\phase22\command-light-1920x1080.png",
    "docs\screenshots\phase22\zen-dark-1920x1080.png",
    "docs\screenshots\phase22\zen-light-1920x1080.png",
    "docs\screenshots\phase22\zen-light-2560x1440.png",
    "docs\screenshots\phase22\playlist-selection-reduced.png",
    "docs\screenshots\phase22\playlist-queue-reduced.png",
    "docs\screenshots\phase22\internal-workspace-1920x1080.png",
    "docs\screenshots\phase20-workspaces\command-light-video-1260x820.png",
    "docs\screenshots\phase20-workspaces\search-live-nonblocking-1180x780.png"
  )
  $ScreenshotHashes = New-Object System.Collections.Generic.List[string]
  foreach ($RelativeScreenshot in $ScreenshotFiles) {
    $SourceScreenshot = Join-Path $Root $RelativeScreenshot
    if (-not (Test-Path $SourceScreenshot)) {
      Write-Warning "Optional validated screenshot is not present in the clean source: $RelativeScreenshot"
      continue
    }
    $DestinationScreenshot = Join-Path $ScreenshotOutput ([IO.Path]::GetFileName($SourceScreenshot))
    Copy-Item $SourceScreenshot $DestinationScreenshot -Force
    $Digest = (Get-FileHash $DestinationScreenshot -Algorithm SHA256).Hash.ToLowerInvariant()
    [void]$ScreenshotHashes.Add("$Digest  $([IO.Path]::GetFileName($DestinationScreenshot))")
  }
  $ScreenshotHashes | Set-Content (Join-Path $ScreenshotOutput "screenshots.sha256") -Encoding ASCII

  # Preserve the source-linked validation evidence beside the installer.
  $ValidationOutput = Join-Path $Output "validation-reports"
  New-Item -ItemType Directory -Path $ValidationOutput -Force | Out-Null
  $ValidationHashes = New-Object System.Collections.Generic.List[string]
  $ValidationReports = @(Get-ChildItem (Join-Path $Root "docs\tests") -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -eq '.json' } | Sort-Object Name)
  if ($ValidationReports.Count -eq 0) { throw "The current validation report set is empty." }
  foreach ($ValidationReport in $ValidationReports) {
    $DestinationReport = Join-Path $ValidationOutput $ValidationReport.Name
    Copy-Item $ValidationReport.FullName $DestinationReport -Force
    $Digest = (Get-FileHash $DestinationReport -Algorithm SHA256).Hash.ToLowerInvariant()
    [void]$ValidationHashes.Add("$Digest  $($ValidationReport.Name)")
  }
  $ValidationHashes | Set-Content (Join-Path $ValidationOutput "validation-reports.sha256") -Encoding ASCII

  $PreferredInstaller = Get-ChildItem $Output -File | Where-Object Extension -eq '.exe' | Select-Object -First 1
  if (-not $PreferredInstaller) { $PreferredInstaller = Get-ChildItem $Output -File | Where-Object Extension -eq '.msi' | Select-Object -First 1 }
  if (-not $PreferredInstaller) { throw "The final output does not contain an NSIS or MSI installer." }
  $InstallerKind = if ($PreferredInstaller.Extension -eq '.exe') { 'NSIS' } else { 'MSI' }
  @"
CLEAR DOWNLOAD MANAGER WINDOWS BUILD COMPLETED

1. Install this $InstallerKind package: $($PreferredInstaller.Name)
2. Keep build-report.json and the .sha256 file beside the installer.
3. The source manifest used for this installer is recorded in build-report.json.
4. Do not delete package-lock.json or src-tauri\Cargo.lock after this build.
5. UI reference images and their SHA-256 file are in the screenshots folder.
6. Source-linked validation reports and hashes are in validation-reports; visual reference images are included when present in the clean source.
7. If the installed app closes immediately, run scripts\collect-windows-diagnostics.ps1.
"@ | Set-Content (Join-Path $Output "BUILD_COMPLETED.txt") -Encoding UTF8

  Write-Host "OK: final Windows artifacts are in $Output" -ForegroundColor Green
  Get-ChildItem $Output | Sort-Object Name | Format-Table Name, Length, LastWriteTime
}
catch {
  $ExitCode = 1
  Write-Host "FINAL BUILD ERROR: $($_.Exception.Message)" -ForegroundColor Red
  if ($TranscriptStarted) { try { Stop-Transcript | Out-Null; $TranscriptStarted = $false } catch {} }
  try { & (Join-Path $PSScriptRoot "collect-windows-diagnostics.ps1") -OutputDirectory "output\native-diagnostics" } catch {}
  Write-Host "Review output\final-windows-build\final-build-transcript.txt and output\native-diagnostics.zip." -ForegroundColor Yellow
}
finally {
  if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
}
exit $ExitCode
