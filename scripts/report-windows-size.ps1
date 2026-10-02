[CmdletBinding()]
param(
  [string]$OutputDirectory = 'output\size-report',
  [string]$StoreNsisPath = '',
  [string]$StoreMsiPath = '',
  [string]$InstalledCoreDirectory = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "powershell-hash-compat.ps1")
$Output = Join-Path $Root $OutputDirectory
New-Item -ItemType Directory -Force -Path $Output | Out-Null

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

function File-Entry {
  param([string]$Path, [string]$Category)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $Item = Get-Item -LiteralPath $Path
  return [pscustomobject][ordered]@{
    category = $Category
    name = $Item.Name
    path = $Item.FullName
    bytes = [int64]$Item.Length
    mebibytes = [math]::Round($Item.Length / 1MB, 2)
    sha256 = (Get-FileHash -LiteralPath $Item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

$Entries = New-Object System.Collections.Generic.List[object]
$Candidates = @(
  @{ Path = (Join-Path $TauriTargetRoot 'release\cacatools-desktop.exe'); Category = 'app' },
  @{ Path = 'src-tauri\resources\bin\aria2c.exe'; Category = 'runtime' },
  @{ Path = 'src-tauri\resources\bin\yt-dlp.exe'; Category = 'runtime' },
  @{ Path = 'src-tauri\resources\bin\ffmpeg.exe'; Category = 'runtime' },
  @{ Path = 'src-tauri\resources\bin\ffprobe.exe'; Category = 'runtime' }
)
foreach ($Candidate in $Candidates) {
  $CandidatePath = if ([IO.Path]::IsPathRooted([string]$Candidate.Path)) {
    [IO.Path]::GetFullPath([string]$Candidate.Path)
  }
  else {
    Join-Path $Root $Candidate.Path
  }
  $Entry = File-Entry -Path $CandidatePath -Category $Candidate.Category
  if ($null -ne $Entry) { [void]$Entries.Add($Entry) }
}

foreach ($Candidate in @(
  @{ Path = $StoreNsisPath; Category = 'store-nsis' },
  @{ Path = $StoreMsiPath; Category = 'store-msi' }
)) {
  if ([string]::IsNullOrWhiteSpace([string]$Candidate.Path)) { continue }
  $CandidatePath = if ([IO.Path]::IsPathRooted([string]$Candidate.Path)) {
    [IO.Path]::GetFullPath([string]$Candidate.Path)
  }
  else { Join-Path $Root $Candidate.Path }
  $Entry = File-Entry -Path $CandidatePath -Category $Candidate.Category
  if ($null -ne $Entry) { [void]$Entries.Add($Entry) }
  else { throw "Specified Store installer does not exist: $CandidatePath" }
}

$InstalledCoreFiles = @()
if (-not [string]::IsNullOrWhiteSpace($InstalledCoreDirectory)) {
  $InstalledCorePath = if ([IO.Path]::IsPathRooted($InstalledCoreDirectory)) {
    [IO.Path]::GetFullPath($InstalledCoreDirectory)
  }
  else { [IO.Path]::GetFullPath((Join-Path $Root $InstalledCoreDirectory)) }
  if (-not (Test-Path -LiteralPath $InstalledCorePath -PathType Container)) {
    throw "Specified installed Core directory does not exist: $InstalledCorePath"
  }
  $InstalledCoreFiles = @(Get-ChildItem -LiteralPath $InstalledCorePath -Recurse -File)
}

$BundleRoot = Join-Path $TauriTargetRoot 'release\bundle'
if (Test-Path $BundleRoot) {
  Get-ChildItem $BundleRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.exe', '.msi', '.zip' -or $_.Name -like '*.sig' } |
    Sort-Object FullName |
    ForEach-Object {
      $Category = if ($_.Name -like '*.sig') { 'signature' } elseif ($_.Extension -eq '.zip') { 'updater' } else { 'installer' }
      $Entry = File-Entry -Path $_.FullName -Category $Category
      if ($null -ne $Entry) { [void]$Entries.Add($Entry) }
    }
}

$EntryArray = $Entries.ToArray()

function Get-CategoryByteSum {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Items,
    [Parameter(Mandatory = $true)][string]$Category
  )

  [int64]$Total = 0
  foreach ($Item in @($Items | Where-Object { $_.category -eq $Category })) {
    if ($null -ne $Item) { $Total += [int64]$Item.bytes }
  }
  return $Total
}

function Get-ByteSum {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Items,
    [Parameter(Mandatory = $true)][string]$Property
  )

  [int64]$Total = 0
  foreach ($Item in @($Items)) {
    if ($null -ne $Item) { $Total += [int64]$Item.$Property }
  }
  return $Total
}

$RuntimeBytes = Get-CategoryByteSum -Items $EntryArray -Category 'runtime'
$AppBytes = Get-CategoryByteSum -Items $EntryArray -Category 'app'
$NormalInstallerBytes = Get-CategoryByteSum -Items $EntryArray -Category 'installer'
$NormalNsisBytes = Get-ByteSum -Items @($EntryArray | Where-Object { $_.category -eq 'installer' -and $_.name -like '*.exe' }) -Property 'bytes'
$NormalMsiBytes = Get-ByteSum -Items @($EntryArray | Where-Object { $_.category -eq 'installer' -and $_.name -like '*.msi' }) -Property 'bytes'
$StoreNsisBytes = Get-CategoryByteSum -Items $EntryArray -Category 'store-nsis'
$StoreMsiBytes = Get-CategoryByteSum -Items $EntryArray -Category 'store-msi'
$InstalledCoreBytes = Get-ByteSum -Items $InstalledCoreFiles -Property 'Length'
$OptionalRuntimeNames = @('yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe', 'deno.exe', 'aria2c.exe')
$UnexpectedInstalledRuntimes = @($InstalledCoreFiles | Where-Object { $OptionalRuntimeNames -contains $_.Name } | ForEach-Object { $_.FullName })
$Report = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  version = ((Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version)
  optimization = [ordered]@{
    rustRelease = 'LTO + opt-level=s + panic=abort + strip + codegen-units=1 (Cargo stable)'
    unusedCommands = 'Tauri removeUnusedCommands=true'
    nsis = 'LZMA'
    normalWebview2 = 'downloadBootstrapper (compact normal/GitHub package)'
    storeWebview2 = 'offlineInstaller (standalone/offline Store package; approximately 127 MB added)'
    note = 'Optional media and torrent engines are separate post-install packages. Pass -StoreNsisPath, -StoreMsiPath, and -InstalledCoreDirectory to report those exact outputs.'
  }
  totals = [ordered]@{
    appBytes = $AppBytes
    runtimeBytes = $RuntimeBytes
    normalInstallerBytes = $NormalInstallerBytes
    normalNsisBytes = $NormalNsisBytes
    normalMsiBytes = $NormalMsiBytes
    storeNsisBytes = $StoreNsisBytes
    storeMsiBytes = $StoreMsiBytes
    installedCorePayloadBytes = $InstalledCoreBytes
    appMiB = [math]::Round($AppBytes / 1MB, 2)
    runtimeMiB = [math]::Round($RuntimeBytes / 1MB, 2)
    normalInstallerMiB = [math]::Round($NormalInstallerBytes / 1MB, 2)
    normalNsisMiB = [math]::Round($NormalNsisBytes / 1MB, 2)
    normalMsiMiB = [math]::Round($NormalMsiBytes / 1MB, 2)
    storeNsisMiB = [math]::Round($StoreNsisBytes / 1MB, 2)
    storeMsiMiB = [math]::Round($StoreMsiBytes / 1MB, 2)
    installedCorePayloadMiB = [math]::Round($InstalledCoreBytes / 1MB, 2)
  }
  installedCorePayload = [ordered]@{ files = $InstalledCoreFiles.Count; unexpectedOptionalRuntimeFiles = $UnexpectedInstalledRuntimes }
  files = @($EntryArray)
}
$ReportPath = Join-Path $Output 'windows-size-report.json'
[IO.File]::WriteAllText($ReportPath, (($Report | ConvertTo-Json -Depth 8) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))

Write-Host "OK: size report written to $ReportPath" -ForegroundColor Green
$EntryArray | Sort-Object -Property bytes -Descending | Format-Table -Property category, name, mebibytes
Write-Host "App: $($Report.totals.appMiB) MiB | normal NSIS/MSI: $($Report.totals.normalNsisMiB)/$($Report.totals.normalMsiMiB) MiB | Store NSIS/MSI: $($Report.totals.storeNsisMiB)/$($Report.totals.storeMsiMiB) MiB | installed Core: $($Report.totals.installedCorePayloadMiB) MiB"
if ($UnexpectedInstalledRuntimes.Count) { Write-Warning "Optional runtime files found in installed Core: $($UnexpectedInstalledRuntimes -join ', ')" }
