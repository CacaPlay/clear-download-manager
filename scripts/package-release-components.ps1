param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string]$RuntimeDirectory = 'src-tauri/resources/bin',
  [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')][string]$MediaToolsVersion = '1.0.0',
  [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')][string]$TorrentEngineVersion = '1.0.0'
)

$ErrorActionPreference = 'Stop'
$expected = @(
  "media-tools-$MediaToolsVersion.cdmcomponent",
  "torrent-engine-$TorrentEngineVersion.cdmcomponent"
)
$out = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($out) | Out-Null
foreach ($name in $expected) {
  if (Test-Path -LiteralPath (Join-Path $out $name)) {
    throw "Refusing to rebuild or overwrite a release component package: $name"
  }
}

$results = @(& (Join-Path $PSScriptRoot 'package-local-components.ps1') -OutputDirectory $out -RuntimeDirectory $RuntimeDirectory -MediaToolsVersion $MediaToolsVersion -TorrentEngineVersion $TorrentEngineVersion)
foreach ($name in $expected) {
  $matches = @(Get-ChildItem -LiteralPath $out -File -Filter $name)
  if ($matches.Count -ne 1 -or $matches[0].Length -le 0) {
    throw "Release package output is missing or ambiguous: $name"
  }
}
if ($results.Count -ne 2) { throw "Expected two package build results, got $($results.Count)." }
$results
