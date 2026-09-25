param(
  [string]$Executable = "$env:LOCALAPPDATA\CacaTools\CacaTools.exe",
  [int]$Seconds = 8
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Executable)) {
  throw "CacaTools.exe was not found at: $Executable"
}
if ($Seconds -lt 4) { $Seconds = 4 }

$Executable = (Resolve-Path $Executable).Path
$SmokeRoot = Join-Path $env:TEMP ("cacatools-startup-smoke-" + [Guid]::NewGuid().ToString("N"))
$SmokeAppData = Join-Path $SmokeRoot "AppData\Roaming"
$SmokeLocalAppData = Join-Path $SmokeRoot "AppData\Local"
$SmokeDataDir = Join-Path $SmokeRoot "CacaToolsData"
$SmokeDownloadsDir = Join-Path $SmokeRoot "Downloads"
$ExpectedDatabase = Join-Path $SmokeDataDir "cacatools.sqlite3"
$SmokeStdOut = Join-Path $SmokeRoot "stdout.txt"
$SmokeStdErr = Join-Path $SmokeRoot "stderr.txt"
New-Item -ItemType Directory -Path $SmokeAppData, $SmokeLocalAppData -Force | Out-Null

$PreviousAppData = $env:APPDATA
$PreviousLocalAppData = $env:LOCALAPPDATA
$PreviousCacaToolsDataDir = [Environment]::GetEnvironmentVariable("CACATOOLS_DATA_DIR", "Process")
$PreviousCacaToolsDownloadsDir = [Environment]::GetEnvironmentVariable("CACATOOLS_DOWNLOADS_DIR", "Process")
$PreviousRustBacktrace = [Environment]::GetEnvironmentVariable("RUST_BACKTRACE", "Process")
$Process = $null
try {
  # Tauri resolves Windows known folders through the shell rather than only
  # through APPDATA/LOCALAPPDATA. Explicit application overrides guarantee
  # that the smoke test cannot reopen the user's real queue or downloads.
  $env:APPDATA = $SmokeAppData
  $env:LOCALAPPDATA = $SmokeLocalAppData
  $env:CACATOOLS_DATA_DIR = $SmokeDataDir
  $env:CACATOOLS_DOWNLOADS_DIR = $SmokeDownloadsDir
  $env:RUST_BACKTRACE = "1"
  $Process = Start-Process -FilePath $Executable -PassThru `
    -RedirectStandardOutput $SmokeStdOut `
    -RedirectStandardError $SmokeStdErr
  $ProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.Id)" -ErrorAction SilentlyContinue
  $LaunchedPath = [string]$ProcessInfo.ExecutablePath
  if (-not $LaunchedPath -or ((Resolve-Path -LiteralPath $LaunchedPath).Path -ne $Executable)) {
    throw "The smoke process path does not match the requested executable. Requested: $Executable; launched: $LaunchedPath"
  }
  Write-Host "OK: exact executable path verified: $LaunchedPath"
  $env:APPDATA = $PreviousAppData
  $env:LOCALAPPDATA = $PreviousLocalAppData
  if ($null -eq $PreviousCacaToolsDataDir) { Remove-Item Env:CACATOOLS_DATA_DIR -ErrorAction SilentlyContinue }
  else { $env:CACATOOLS_DATA_DIR = $PreviousCacaToolsDataDir }
  if ($null -eq $PreviousCacaToolsDownloadsDir) { Remove-Item Env:CACATOOLS_DOWNLOADS_DIR -ErrorAction SilentlyContinue }
  else { $env:CACATOOLS_DOWNLOADS_DIR = $PreviousCacaToolsDownloadsDir }
  if ($null -eq $PreviousRustBacktrace) { Remove-Item Env:RUST_BACKTRACE -ErrorAction SilentlyContinue }
  else { $env:RUST_BACKTRACE = $PreviousRustBacktrace }

  $Deadline = (Get-Date).AddSeconds($Seconds)
  $HasWindow = $false
  while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Milliseconds 500
    $Process.Refresh()
    if ($Process.HasExited) {
      $CrashDetails = @()
      if (Test-Path $SmokeStdErr) { $CrashDetails += (Get-Content -LiteralPath $SmokeStdErr -Raw -ErrorAction SilentlyContinue).Trim() }
      if (Test-Path $SmokeStdOut) { $CrashDetails += (Get-Content -LiteralPath $SmokeStdOut -Raw -ErrorAction SilentlyContinue).Trim() }
      $CrashText = ($CrashDetails | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine
      if (-not [string]::IsNullOrWhiteSpace($CrashText)) {
        throw "CacaTools exited during the isolated smoke test with code $($Process.ExitCode).`n$CrashText"
      }
      throw "CacaTools exited during the isolated smoke test with code $($Process.ExitCode)."
    }
    if ($Process.MainWindowHandle -ne 0) { $HasWindow = $true }
  }

  if (-not $HasWindow) {
    throw "CacaTools remained running but did not create a visible main window during the smoke test."
  }

  if (-not (Test-Path $ExpectedDatabase -PathType Leaf)) {
    throw "CacaTools opened a window but did not create its isolated SQLite database."
  }
  if (-not (Test-Path $SmokeDownloadsDir -PathType Container)) {
    throw "CacaTools opened a window but did not initialize its isolated downloads directory."
  }

  Write-Host "OK: isolated CacaTools window is running. PID $($Process.Id); memory $([math]::Round($Process.WorkingSet64 / 1MB, 1)) MB"
  Write-Host "OK: isolated SQLite database and downloads directory initialized in a disposable test root."
}
finally {
  $env:APPDATA = $PreviousAppData
  $env:LOCALAPPDATA = $PreviousLocalAppData
  if ($null -eq $PreviousCacaToolsDataDir) { Remove-Item Env:CACATOOLS_DATA_DIR -ErrorAction SilentlyContinue }
  else { $env:CACATOOLS_DATA_DIR = $PreviousCacaToolsDataDir }
  if ($null -eq $PreviousCacaToolsDownloadsDir) { Remove-Item Env:CACATOOLS_DOWNLOADS_DIR -ErrorAction SilentlyContinue }
  else { $env:CACATOOLS_DOWNLOADS_DIR = $PreviousCacaToolsDownloadsDir }
  if ($null -eq $PreviousRustBacktrace) { Remove-Item Env:RUST_BACKTRACE -ErrorAction SilentlyContinue }
  else { $env:RUST_BACKTRACE = $PreviousRustBacktrace }
  if ($Process -and -not $Process.HasExited) {
    & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
  }
  Remove-Item $SmokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "OK: process tree closed and isolated smoke data removed."
