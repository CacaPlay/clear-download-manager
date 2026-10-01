param(
  [Parameter(Mandatory = $true)][string]$ReleaseTag,
  [Parameter(Mandatory = $true)][UInt64]$Sequence,
  [Parameter(Mandatory = $true)][string]$KeyId,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$YtDlpSourceArchive,
  [string]$RuntimeDirectory = 'src-tauri/resources/bin'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$runtimeRoot = [System.IO.Path]::GetFullPath((Join-Path $root $RuntimeDirectory))
$sourceManifestPath = Join-Path $root 'third-party-source/corresponding-source.json'
$licenseRoot = Join-Path $root 'src-tauri/resources/licenses'
$catalogPayloadPath = Join-Path $output 'component-catalog-payload.json'

if ($Sequence -eq 0 -or $ReleaseTag -notmatch '^[A-Za-z0-9._+-]{1,64}$' -or
    $KeyId -notmatch '^[A-Za-z0-9._+-]{1,64}$') {
  throw 'Release tag, positive sequence, and key ID must be safe catalog tokens.'
}
if (Test-Path -LiteralPath $output) {
  $existing = @(Get-ChildItem -LiteralPath $output -Force)
  if ($existing.Count -gt 0) { throw "Refusing to overwrite a non-empty release asset directory: $output" }
} else {
  [System.IO.Directory]::CreateDirectory($output) | Out-Null
}

function Get-Sha256([string]$Path) {
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-ExactFile([string]$Directory, [string]$Name) {
  $matches = @(Get-ChildItem -LiteralPath $Directory -File -Filter $Name -ErrorAction SilentlyContinue)
  if ($matches.Count -ne 1 -or $matches[0].Length -le 0) { throw "Missing or ambiguous exact release input: $Name" }
  return $matches[0]
}

function Get-PackageManifest([string]$PackagePath) {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($PackagePath)
  try {
    $entries = @($archive.Entries | Where-Object FullName -eq 'component.json')
    if ($entries.Count -ne 1) { throw "Package must contain exactly one component.json: $PackagePath" }
    $reader = [System.IO.StreamReader]::new($entries[0].Open(), [System.Text.Encoding]::UTF8)
    try { return $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  } finally { $archive.Dispose() }
}

function Copy-VerifiedAsset([string]$SourcePath, [string]$AssetName, [UInt64]$ExpectedBytes, [string]$ExpectedHash) {
  $source = Get-Item -LiteralPath $SourcePath -ErrorAction Stop
  if ($source.Length -ne $ExpectedBytes -or (Get-Sha256 $source.FullName) -ne $ExpectedHash.ToLowerInvariant()) {
    throw "Source asset failed exact bytes/SHA-256 verification: $AssetName"
  }
  $target = Join-Path $output $AssetName
  if (Test-Path -LiteralPath $target) { throw "Duplicate release asset name: $AssetName" }
  Copy-Item -LiteralPath $source.FullName -Destination $target
  return [pscustomobject]@{ Name = $AssetName; Path = $target; Bytes = [UInt64]$source.Length; Sha256 = (Get-Sha256 $target) }
}

$sourceManifest = Get-Content -LiteralPath $sourceManifestPath -Raw | ConvertFrom-Json
$packageOutput = Join-Path $env:TEMP ("cdm-component-package-stage-{0}" -f [guid]::NewGuid().ToString('N'))
try {
  [System.IO.Directory]::CreateDirectory($packageOutput) | Out-Null
$packageBuild = @(& (Join-Path $PSScriptRoot 'package-release-components.ps1') -OutputDirectory $packageOutput -RuntimeDirectory $runtimeRoot)
if ($packageBuild.Count -ne 2) { throw 'Expected exact media-tools and torrent-engine package build results.' }

$packageRecords = @{}
foreach ($name in @('media-tools-1.0.0.cdmcomponent','torrent-engine-1.0.0.cdmcomponent')) {
  $file = Get-ExactFile $packageOutput $name
  $manifest = Get-PackageManifest $file.FullName
  $expectedId = if ($name.StartsWith('media-tools-')) { 'media-tools' } else { 'torrent-engine' }
  if ($manifest.id -ne $expectedId -or $manifest.version -ne '1.0.0') { throw "Package identity/version mismatch: $name" }
  $packageRecords[$expectedId] = [pscustomobject]@{
    id = $manifest.id
    version = $manifest.version
    releaseTag = $ReleaseTag
    assetName = $name
    packageUrl = "https://github.com/CacaPlay/clear-download-manager/releases/download/$ReleaseTag/$name"
    packageBytes = [UInt64]$file.Length
    packageSha256 = Get-Sha256 $file.FullName
    capabilities = @($manifest.capabilities)
    minimumCdmVersion = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    files = @($manifest.files)
  }
  $target = Join-Path $output $name
  if (Test-Path -LiteralPath $target) { throw "Duplicate package release asset: $name" }
  Copy-Item -LiteralPath $file.FullName -Destination $target
}

$requiredSourceAssets = @{}
$sourceMappings = @{
  aria2 = @{ id='aria2'; notice='ARIA2-NOTICE.txt'; spdx='GPL-2.0-or-later' }
  ffmpeg = @{ id='ffmpeg'; notice='FFMPEG-NOTICE.txt'; spdx='GPL-3.0-or-later' }
  'yt-dlp' = @{ id='yt-dlp'; notice='YT-DLP-NOTICE.txt'; spdx='GPL-3.0-or-later' }
}
$sourceMetadata = @{}
foreach ($runtimeId in @('aria2','ffmpeg','yt-dlp')) {
  $record = @($sourceManifest.runtimes | Where-Object id -eq $runtimeId)
  if ($record.Count -ne 1 -or $record[0].distributionApproval.status -ne 'APPROVED') { throw "Corresponding-source distribution approval is not approved: $runtimeId" }
  $source = $record[0]
  $approvalRecordPath = Join-Path $root $source.distributionApproval.approvalRecordPath
  if (-not (Test-Path -LiteralPath $approvalRecordPath -PathType Leaf) -or (Get-Sha256 $approvalRecordPath) -ne $source.distributionApproval.approvalRecordSha256) {
    throw "Distributor approval record is missing or stale: $runtimeId"
  }
  if ($runtimeId -eq 'yt-dlp') {
    $sourcePath = [System.IO.Path]::GetFullPath($YtDlpSourceArchive)
    $expectedSource = $source
  } else {
    $expectedSource = $source
    $sourcePath = Join-Path $root $source.sourceArchivePath
  }
  $sourceBytesField = $source.PSObject.Properties['sourceArchiveBytes']
  $expectedSourceBytes = if ($null -ne $sourceBytesField) {
    [UInt64]$sourceBytesField.Value
  } else {
    [UInt64](Get-Item -LiteralPath $sourcePath -ErrorAction Stop).Length
  }
  $asset = Copy-VerifiedAsset $sourcePath $source.releaseAssetName $expectedSourceBytes $source.releaseAssetSha256
  $requiredSourceAssets[$runtimeId] = [pscustomobject]@{
    runtimeId = $runtimeId
    sourceCommit = $source.sourceCommit
    assetName = $asset.Name
    assetUrl = "https://github.com/CacaPlay/clear-download-manager/releases/download/$ReleaseTag/$($asset.Name)"
    bytes = $asset.Bytes
    sha256 = $asset.Sha256
    license = $source.license
    distributionApproval = 'APPROVED'
  }
  $sourceMetadata[$runtimeId] = $source
}

$noticeRecords = @{}
foreach ($runtimeId in @('aria2','ffmpeg','yt-dlp','deno')) {
  if ($runtimeId -eq 'deno') {
    $noticeName = 'DENO-NOTICE.txt'; $spdx = 'MIT'
  } else {
    $noticeName = $sourceMappings[$runtimeId].notice; $spdx = $sourceMappings[$runtimeId].spdx
  }
  $noticePath = Join-Path $licenseRoot $noticeName
  $notice = Get-Item -LiteralPath $noticePath -ErrorAction Stop
  if ($notice.Length -le 0) { throw "Notice file is empty: $noticeName" }
  $target = Join-Path $output $noticeName
  if (Test-Path -LiteralPath $target) { throw "Duplicate notice release asset: $noticeName" }
  Copy-Item -LiteralPath $noticePath -Destination $target
  $noticeRecords[$runtimeId] = [pscustomobject]@{
    runtimeId = $runtimeId
    spdx = $spdx
    noticeFile = $noticeName
    noticeSha256 = Get-Sha256 $target
  }
}

$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
foreach ($record in @($packageRecords.Values)) {
  if ($record.id -eq 'media-tools') {
    $record | Add-Member -NotePropertyName correspondingSources -NotePropertyValue @($requiredSourceAssets.ffmpeg, $requiredSourceAssets.'yt-dlp')
    $record | Add-Member -NotePropertyName licenseNotices -NotePropertyValue @($noticeRecords.'yt-dlp', $noticeRecords.ffmpeg, $noticeRecords.deno)
  } else {
    $record | Add-Member -NotePropertyName correspondingSources -NotePropertyValue @($requiredSourceAssets.aria2)
    $record | Add-Member -NotePropertyName licenseNotices -NotePropertyValue @($noticeRecords.aria2)
  }
}
$payload = [ordered]@{
  schemaVersion = 2
  catalogVersion = '1'
  sequence = $Sequence
  keyId = $KeyId
  issuedAt = $now
  expiresAt = $now + (30 * 24 * 60 * 60)
  components = @($packageRecords['media-tools'], $packageRecords['torrent-engine'])
}
$json = ConvertTo-Json -InputObject $payload -Depth 30
[System.IO.File]::WriteAllText($catalogPayloadPath, $json, [System.Text.UTF8Encoding]::new($false))
$assets = @(Get-ChildItem -LiteralPath $output -File | Sort-Object Name | ForEach-Object {
  [pscustomobject]@{ name=$_.Name; bytes=$_.Length; sha256=(Get-Sha256 $_.FullName) }
})
[pscustomobject]@{ releaseTag=$ReleaseTag; catalogPayload=$catalogPayloadPath; assets=$assets }
} finally {
  if (Test-Path -LiteralPath $packageOutput -PathType Container) {
    $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $stagePath = [System.IO.Path]::GetFullPath($packageOutput)
    $stageParent = [System.IO.Path]::GetDirectoryName($stagePath).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $stageName = [System.IO.Path]::GetFileName($stagePath)
    if ([StringComparer]::OrdinalIgnoreCase.Equals($stageParent, $tempRoot) -and $stageName -match '^cdm-component-package-stage-[0-9a-f]{32}$') {
      Remove-Item -LiteralPath $stagePath -Recurse -Force
    } else {
      throw 'Refusing to remove a package staging path outside the generated temporary directory.'
    }
  }
}
