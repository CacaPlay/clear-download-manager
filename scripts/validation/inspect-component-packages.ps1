param(
  [Parameter(Mandatory = $true)][string]$PackageDirectory,
  [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')][string]$MediaToolsVersion = '1.0.0',
  [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')][string]$TorrentEngineVersion = '1.0.0',
  [string]$RuntimeManifestPath = 'src-tauri/resources/bin/runtime-manifest.json'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Sha256FromStream([System.IO.Stream]$Stream) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($algorithm.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Get-VersionToken([string]$Text, [int]$Index) {
  $parts = $Text -split '\s+'
  if ($parts.Count -le $Index -or $parts[$Index] -notmatch '^[A-Za-z0-9._+-]{1,64}$') {
    throw "Runtime version metadata is invalid: $Text"
  }
  return $parts[$Index]
}

function Assert-ExactProperties($Object, [string[]]$ExpectedNames, [string]$Context) {
  $actualNames = @($Object.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
  $expectedNames = @($ExpectedNames | Sort-Object -CaseSensitive)
  if (@(Compare-Object -CaseSensitive -ReferenceObject $expectedNames -DifferenceObject $actualNames).Count -ne 0) {
    throw "Unexpected JSON properties in $Context"
  }
}

function Assert-ExactOrderedStrings([string[]]$Actual, [string[]]$Expected, [string]$Context) {
  if ($Actual.Count -ne $Expected.Count) { throw "Unexpected value count in $Context" }
  for ($index = 0; $index -lt $Expected.Count; $index++) {
    if (-not [StringComparer]::Ordinal.Equals($Actual[$index], $Expected[$index])) {
      throw "Unexpected value in $Context"
    }
  }
}
$packageRoot = [System.IO.Path]::GetFullPath($PackageDirectory)
$manifestPath = [System.IO.Path]::GetFullPath($RuntimeManifestPath)
if (-not (Test-Path -LiteralPath $packageRoot -PathType Container)) { throw "Component package directory does not exist: $packageRoot" }
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Runtime manifest does not exist: $manifestPath" }
if (((Get-Item -LiteralPath $packageRoot).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Component package directory must not be a reparse point.' }

$runtimeText = [System.IO.File]::ReadAllText($manifestPath).TrimStart([char]0xFEFF)
$runtime = $runtimeText | ConvertFrom-Json
$mediaFiles = @(
  [pscustomobject]@{ artifact='yt-dlp'; name='yt-dlp.exe'; version=[string]$runtime.ytDlp.version; sha256=[string]$runtime.ytDlp.sha256 },
  [pscustomobject]@{ artifact='ffmpeg'; name='ffmpeg.exe'; version=(Get-VersionToken ([string]$runtime.ffmpeg.version) 2); sha256=[string]$runtime.ffmpeg.ffmpegSha256 },
  [pscustomobject]@{ artifact='ffprobe'; name='ffprobe.exe'; version=(Get-VersionToken ([string]$runtime.ffmpeg.ffprobeVersion) 2); sha256=[string]$runtime.ffmpeg.ffprobeSha256 },
  [pscustomobject]@{ artifact='deno'; name='deno.exe'; version=(Get-VersionToken ([string]$runtime.deno.version) 1); sha256=[string]$runtime.deno.executableSha256 }
)
$torrentFiles = @(
  [pscustomobject]@{ artifact='aria2'; name='aria2c.exe'; version=(Get-VersionToken ([string]$runtime.aria2.version) 2); sha256=[string]$runtime.aria2.executableSha256 }
)
$expected = @(
  [pscustomobject]@{ assetName="media-tools-$MediaToolsVersion.cdmcomponent"; id='media-tools'; version=$MediaToolsVersion; capabilities=@('media-extraction','media-merge','media-probe','media-transcode','js-runtime'); files=$mediaFiles },
  [pscustomobject]@{ assetName="torrent-engine-$TorrentEngineVersion.cdmcomponent"; id='torrent-engine'; version=$TorrentEngineVersion; capabilities=@('bittorrent'); files=$torrentFiles }
)
$actualPackages = @(Get-ChildItem -LiteralPath $packageRoot -File -Filter '*.cdmcomponent')
if ($actualPackages.Count -ne $expected.Count) { throw "Expected exactly $($expected.Count) optional component package assets; found $($actualPackages.Count)." }

foreach ($required in $expected) {
  $matches = @($actualPackages | Where-Object { [StringComparer]::Ordinal.Equals($_.Name, $required.assetName) })
  if ($matches.Count -ne 1) { throw "Required exact package asset is missing: $($required.assetName)" }
  $packageFile = $matches[0]
  if (($packageFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Package asset must be a regular file: $($required.assetName)" }
  if ($packageFile.Length -le 0 -or $packageFile.Length -gt 536870912) { throw "Package size is outside the accepted range: $($required.assetName)" }

  $archive = [System.IO.Compression.ZipFile]::OpenRead($packageFile.FullName)
  try {
    $entryNames = @($archive.Entries | ForEach-Object { $_.FullName })
    if ($entryNames.Count -ne ($required.files.Count + 1) -or
        @($entryNames | Where-Object { $_ -match '[\\/]' -or [string]::IsNullOrWhiteSpace($_) }).Count -gt 0 -or
        @($entryNames | Select-Object -Unique).Count -ne $entryNames.Count) {
      throw "Package contains an unexpected, nested, or duplicate entry: $($required.assetName)"
    }
    $expectedNames = @('component.json') + @($required.files | ForEach-Object { $_.name })
    if (@(Compare-Object -CaseSensitive -ReferenceObject $expectedNames -DifferenceObject $entryNames).Count -ne 0) {
      throw "Package entries do not match the exact component file contract: $($required.assetName)"
    }
    $manifestEntry = $archive.GetEntry('component.json')
    if (-not $manifestEntry -or $manifestEntry.Length -gt 65536) { throw "Component manifest is missing or too large: $($required.assetName)" }
    $manifestStream = $manifestEntry.Open()
    try {
      $reader = [System.IO.StreamReader]::new($manifestStream, [System.Text.Encoding]::UTF8, $true)
      try { $componentManifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    } finally { $manifestStream.Dispose() }

    Assert-ExactProperties $componentManifest @('schemaVersion','id','version','capabilities','dependencies','files') $required.assetName
    if ($componentManifest.schemaVersion -ne 1 -or $componentManifest.id -cne $required.id -or
        $componentManifest.version -cne $required.version -or @($componentManifest.dependencies).Count -ne 0) {
      throw "Component identity, schema, version, or dependencies do not match: $($required.assetName)"
    }
    Assert-ExactOrderedStrings @($componentManifest.capabilities) $required.capabilities ($required.assetName + ' capabilities')
    if (@(Compare-Object -CaseSensitive -ReferenceObject $required.capabilities -DifferenceObject @($componentManifest.capabilities)).Count -ne 0) {
      throw "Component capabilities do not match: $($required.assetName)"
    }
    $listedFiles = @($componentManifest.files)
    if ($listedFiles.Count -ne $required.files.Count) { throw "Component manifest file count does not match: $($required.assetName)" }

    foreach ($listedFile in $listedFiles) { Assert-ExactProperties $listedFile @('artifact','name','version','sha256','size') ($required.assetName + ' file manifest') }

    foreach ($pin in $required.files) {
      $listed = @($listedFiles | Where-Object { $_.name -ceq $pin.name })
      if ($listed.Count -ne 1 -or $listed[0].artifact -cne $pin.artifact -or
          $listed[0].version -cne $pin.version -or $listed[0].sha256 -cne $pin.sha256.ToLowerInvariant() -or
          $listed[0].size -le 0) {
        throw "Component manifest pin does not match runtime-manifest.json: $($pin.name)"
      }
      $entry = $archive.GetEntry($pin.name)
      if (-not $entry -or $entry.Length -ne [long]$listed[0].size) { throw "Runtime size does not match the component manifest: $($pin.name)" }
      $entryStream = $entry.Open()
      try { $actualHash = Get-Sha256FromStream $entryStream } finally { $entryStream.Dispose() }
      if ($actualHash -ne $pin.sha256.ToLowerInvariant()) { throw "Runtime SHA-256 does not match runtime-manifest.json: $($pin.name)" }
    }
  } finally { $archive.Dispose() }

  $packageHashStream = [System.IO.File]::OpenRead($packageFile.FullName)
  try { $packageHash = Get-Sha256FromStream $packageHashStream } finally { $packageHashStream.Dispose() }
  Write-Output ("PASS: {0} bytes={1} sha256={2}" -f $required.assetName, $packageFile.Length, $packageHash)
}

if ($runtime.ffmpeg.profile -ne 'SAFE LEAN' -or $runtime.ffmpeg.approvedCandidateKey -ne 'ffmpegSafeLeanCandidate') {
  throw 'Optional package pins must use the approved SAFE LEAN FFmpeg profile.'
}
if ($runtime.ytDlp.effectiveLicense -ne 'GPL-3.0-or-later') { throw 'yt-dlp effective license metadata must remain GPL-3.0-or-later.' }
Write-Output 'PASS: exact Media Tools and Torrent Engine package contents, runtime versions, hashes, and sizes.'
