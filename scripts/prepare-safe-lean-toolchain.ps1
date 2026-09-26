[CmdletBinding()]
param(
  [string]$MsysRoot = $(if ($env:MSYS2_ROOT) { $env:MSYS2_ROOT } else { 'C:\msys64' })
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$LockPath = Join-Path $Root 'tools\ffmpeg-safe-lean\toolchain.lock.json'
if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
  throw "SAFE LEAN toolchain lock is missing: $LockPath"
}

$Lock = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
if ($Lock.schemaVersion -ne 1 -or $Lock.packageCount -ne $Lock.packages.Count -or $Lock.packages.Count -ne 57) {
  throw 'SAFE LEAN toolchain lock has an unsupported schema or package count.'
}

$MsysRoot = [IO.Path]::GetFullPath($MsysRoot)
$Bash = Join-Path $MsysRoot 'usr\bin\bash.exe'
$Cygpath = Join-Path $MsysRoot 'usr\bin\cygpath.exe'
$Python = Join-Path $MsysRoot 'ucrt64\bin\python.exe'
foreach ($Required in @($Bash, $Cygpath, (Join-Path $MsysRoot 'usr\bin\pacman.exe'))) {
  if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) {
    throw "The GitHub Windows runner does not have the required MSYS2 bootstrap executable: $Required"
  }
}

function ConvertTo-BashSingleQuoted([string]$Value) {
  return "'" + $Value.Replace("'", "'\''") + "'"
}

function Invoke-MsysBash([string]$Command, [string]$Description) {
  $PreviousPreference = $ErrorActionPreference
  $Lines = New-Object System.Collections.Generic.List[string]
  $ExitCode = 1
  $ErrorActionPreference = 'Continue'
  try {
    & $Bash -lc $Command 2>&1 | ForEach-Object { [void]$Lines.Add($_.ToString()) }
    $ExitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $PreviousPreference
  }
  if ($ExitCode -ne 0) {
    if ($Lines.Count -gt 0) { $Lines | ForEach-Object { Write-Host $_ } }
    throw "$Description failed with exit code $ExitCode."
  }
  return $Lines.ToArray()
}

$PackagesByName = @{}
$SeenFiles = @{}
foreach ($Package in $Lock.packages) {
  if ([string]$Package.name -notmatch '^[A-Za-z0-9_+-]+$' -or
      [string]$Package.version -notmatch '^[A-Za-z0-9.+:~_-]+$' -or
      [string]$Package.filename -notmatch '^[A-Za-z0-9_.+~-]+\.pkg\.tar\.zst$' -or
      [string]$Package.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or
      [long]$Package.bytes -le 0 -or
      [string]$Package.repository -notin @('msys/x86_64', 'mingw/ucrt64')) {
    throw "Invalid package record in SAFE LEAN toolchain lock: $($Package | ConvertTo-Json -Compress)"
  }
  if ($PackagesByName.ContainsKey([string]$Package.name) -or $SeenFiles.ContainsKey([string]$Package.filename)) {
    throw "Duplicate package name or filename in SAFE LEAN toolchain lock: $($Package.name)"
  }
  $ExpectedUrl = "https://repo.msys2.org/$($Package.repository)/$($Package.filename)"
  if ([string]$Package.url -cne $ExpectedUrl) {
    throw "Package URL is not the exact official MSYS2 repository path for $($Package.name)."
  }
  $PackagesByName[[string]$Package.name] = $Package
  $SeenFiles[[string]$Package.filename] = $true
}

$InstalledLines = Invoke-MsysBash 'pacman -Q' 'Reading installed MSYS2 package versions'
$Installed = @{}
foreach ($Line in $InstalledLines) {
  if ($Line -match '^([^\s]+)\s+([^\s]+)$') { $Installed[$Matches[1]] = $Matches[2] }
}

$Mismatched = @($Lock.packages | Where-Object { $Installed[[string]$_.name] -cne [string]$_.version })
if ($Mismatched.Count -eq 0) {
  Write-Host "MSYS2 package versions already match the SAFE LEAN lock ($($Lock.packageCount) packages)."
}
else {
  $TempBase = if (-not [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:RUNNER_TEMP } else { $env:TEMP }
  if ([string]::IsNullOrWhiteSpace($TempBase)) { throw 'A task-scoped temporary directory is unavailable.' }
  $TempBase = [IO.Path]::GetFullPath($TempBase)
  $DownloadDirectory = Join-Path $TempBase ('cdm-safe-lean-msys2-' + [guid]::NewGuid().ToString('N'))
  $DownloadDirectoryFull = [IO.Path]::GetFullPath($DownloadDirectory)
  $TempPrefix = $TempBase.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $DownloadDirectoryFull.StartsWith($TempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The SAFE LEAN package staging directory is outside the runner temporary directory.'
  }
  New-Item -ItemType Directory -Path $DownloadDirectoryFull | Out-Null

  try {
    $ValidatedArchives = New-Object System.Collections.Generic.List[string]
    foreach ($Package in $Mismatched) {
      $ArchivePath = Join-Path $DownloadDirectoryFull ([string]$Package.filename)
      $Attempt = 0
      do {
        $Attempt++
        try {
          Write-Host "Downloading pinned MSYS2 package $($Package.name) $($Package.version) ($Attempt/3)..."
          Invoke-WebRequest -Uri ([string]$Package.url) -OutFile $ArchivePath -TimeoutSec 240
          break
        }
        catch {
          Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue
          if ($Attempt -ge 3) { throw }
          Start-Sleep -Seconds ([Math]::Min(8, 2 * $Attempt))
        }
      } while ($Attempt -lt 3)

      $Downloaded = Get-Item -LiteralPath $ArchivePath
      if ($Downloaded.Length -ne [long]$Package.bytes) {
        throw "Pinned MSYS2 package size mismatch for $($Package.filename): expected $($Package.bytes), received $($Downloaded.Length)."
      }
      $ActualSha256 = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($ActualSha256 -cne ([string]$Package.sha256).ToLowerInvariant()) {
        throw "Pinned MSYS2 package SHA-256 mismatch for $($Package.filename)."
      }
      $PosixPath = (& $Cygpath -u $ArchivePath | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($PosixPath)) {
        throw "MSYS2 could not convert the validated package path: $ArchivePath"
      }
      [void]$ValidatedArchives.Add((ConvertTo-BashSingleQuoted $PosixPath))
    }

    if ($ValidatedArchives.Count -gt 0) {
      $InstallCommand = 'pacman -U --noconfirm --needed ' + [string]::Join(' ', $ValidatedArchives)
      [void](Invoke-MsysBash $InstallCommand 'Installing the validated, pinned MSYS2 package archives')
    }
  }
  finally {
    $ResolvedDownloadDirectory = [IO.Path]::GetFullPath($DownloadDirectoryFull)
    if (-not $ResolvedDownloadDirectory.StartsWith($TempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Refusing to remove a SAFE LEAN package directory outside the runner temporary directory.'
    }
    Remove-Item -LiteralPath $ResolvedDownloadDirectory -Recurse -Force
  }
}

$LockPosix = (& $Cygpath -u $LockPath | Out-String).Trim()
$VerifierPosix = (& $Cygpath -u (Join-Path $Root 'tools\ffmpeg-safe-lean\verify-toolchain.py') | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($LockPosix) -or [string]::IsNullOrWhiteSpace($VerifierPosix)) {
  throw 'MSYS2 could not convert the SAFE LEAN lock or verifier path.'
}
$VerifyCommand = "export PATH='/ucrt64/bin:/usr/bin'; /ucrt64/bin/python.exe $(ConvertTo-BashSingleQuoted $VerifierPosix) --lock $(ConvertTo-BashSingleQuoted $LockPosix)"
[void](Invoke-MsysBash $VerifyCommand 'Verifying the installed SAFE LEAN MSYS2 package lock')
Write-Host "SAFE LEAN MSYS2 toolchain ready: $($Lock.packageCount) exact packages verified." -ForegroundColor Green
