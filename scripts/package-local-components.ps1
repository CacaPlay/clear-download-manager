param(
  [string]$OutputDirectory = 'output/component-packages',
  [string]$RuntimeDirectory = 'src-tauri/resources/bin',
  [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')][string]$MediaToolsVersion = '1.0.0',
  [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')][string]$TorrentEngineVersion = '1.0.0'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$runtimeManifestPath = Join-Path $RuntimeDirectory 'runtime-manifest.json'
if (-not (Test-Path -LiteralPath $runtimeManifestPath -PathType Leaf)) {
  throw "Runtime inventory not found: $runtimeManifestPath. Run prepare:windows-binaries first."
}
$manifestText = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $runtimeManifestPath).Path).TrimStart([char]0xFEFF)
$runtime = $manifestText | ConvertFrom-Json
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null

function Get-Field($Object, [string]$Name) {
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
    throw "Runtime manifest is missing $Name."
  }
  return [string]$property.Value
}

function Get-Sha256([string]$Path) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $inputStream = [System.IO.File]::OpenRead($Path)
    try {
      return [BitConverter]::ToString($algorithm.ComputeHash($inputStream)).Replace('-', '').ToLowerInvariant()
    } finally {
      $inputStream.Dispose()
    }
  } finally {
    $algorithm.Dispose()
  }
}

function Get-VersionToken([string]$Value, [int]$Index) {
  $parts = $Value -split '\s+'
  if ($parts.Count -le $Index -or $parts[$Index] -notmatch '^[A-Za-z0-9._+-]{1,64}$') {
    throw "Runtime version text is invalid: $Value"
  }
  return $parts[$Index]
}

function New-ComponentPackage([string]$Id, [string]$Version, [string[]]$Capabilities, [object[]]$Artifacts) {
  $files = @()
  [long]$installedBytes = 0
  foreach ($artifact in $Artifacts) {
    $filePath = Join-Path $RuntimeDirectory $artifact.name
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
      throw "Required runtime file is missing: $filePath. Run prepare:windows-binaries first."
    }
    $actualHash = Get-Sha256 $filePath
    if ($actualHash -ne $artifact.sha256.ToLowerInvariant()) {
      throw "Runtime SHA-256 does not match the pinned inventory: $($artifact.name)"
    }
    $item = Get-Item -LiteralPath $filePath
    if ($item.Length -le 0) { throw "Runtime file is empty: $($artifact.name)" }
    $files += [ordered]@{
      artifact = $artifact.artifact
      name = $artifact.name
      version = $artifact.version
      sha256 = $actualHash
      size = [long]$item.Length
    }
    $installedBytes += [long]$item.Length
  }
  $componentManifest = [ordered]@{
    schemaVersion = 1
    id = $Id
    version = $Version
    capabilities = $Capabilities
    dependencies = @()
    files = $files
  }
  $manifestBytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($componentManifest | ConvertTo-Json -Depth 8 -Compress))
  $packagePath = Join-Path $outputRoot "$Id-$Version.cdmcomponent"
  if (Test-Path -LiteralPath $packagePath) {
    throw "Refusing to overwrite an existing local package: $packagePath"
  }
  $stream = [System.IO.File]::Open($packagePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try {
    $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
    try {
      $entry = $archive.CreateEntry('component.json', [System.IO.Compression.CompressionLevel]::Optimal)
      $entryStream = $entry.Open()
      try { $entryStream.Write($manifestBytes, 0, $manifestBytes.Length) } finally { $entryStream.Dispose() }
      foreach ($artifact in $Artifacts) {
        $entry = $archive.CreateEntry($artifact.name, [System.IO.Compression.CompressionLevel]::Optimal)
        $entryStream = $entry.Open()
        try {
          $sourceStream = [System.IO.File]::OpenRead((Join-Path $RuntimeDirectory $artifact.name))
          try { $sourceStream.CopyTo($entryStream) } finally { $sourceStream.Dispose() }
        } finally { $entryStream.Dispose() }
      }
    } finally { $archive.Dispose() }
  } finally { $stream.Dispose() }
  $packageInfo = Get-Item -LiteralPath $packagePath
$packageHash = Get-Sha256 $packagePath
  [pscustomobject]@{ Id = $Id; Path = $packageInfo.FullName; CompressedBytes = $packageInfo.Length; Sha256 = $packageHash; InstalledBytes = $installedBytes }
}

$mediaArtifacts = @(
  [pscustomobject]@{ artifact='yt-dlp'; name='yt-dlp.exe'; version=(Get-Field $runtime.ytDlp 'version'); sha256=(Get-Field $runtime.ytDlp 'sha256') },
  [pscustomobject]@{ artifact='ffmpeg'; name='ffmpeg.exe'; version=(Get-VersionToken (Get-Field $runtime.ffmpeg 'version') 2); sha256=(Get-Field $runtime.ffmpeg 'ffmpegSha256') },
  [pscustomobject]@{ artifact='ffprobe'; name='ffprobe.exe'; version=(Get-VersionToken (Get-Field $runtime.ffmpeg 'ffprobeVersion') 2); sha256=(Get-Field $runtime.ffmpeg 'ffprobeSha256') },
  [pscustomobject]@{ artifact='deno'; name='deno.exe'; version=(Get-VersionToken (Get-Field $runtime.deno 'version') 1); sha256=(Get-Field $runtime.deno 'executableSha256') }
)
$torrentArtifacts = @(
  [pscustomobject]@{ artifact='aria2'; name='aria2c.exe'; version=(Get-VersionToken (Get-Field $runtime.aria2 'version') 2); sha256=(Get-Field $runtime.aria2 'executableSha256') }
)

New-ComponentPackage 'media-tools' $MediaToolsVersion @('media-extraction','media-merge','media-probe','media-transcode','js-runtime') $mediaArtifacts
New-ComponentPackage 'torrent-engine' $TorrentEngineVersion @('bittorrent') $torrentArtifacts
