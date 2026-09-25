[CmdletBinding()]
param(
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ChromiumExtensionId = 'aonppfnabjnicjjeoofkfjofolfibggp',

  [Parameter(Mandatory = $true)]
  [string]$AppExecutable,

  [ValidateSet('Chrome', 'Edge', 'Chromium', 'Brave', 'All')]
  [string[]]$Browsers = @('All')
)

$ErrorActionPreference = 'Stop'
$HostName = 'lat.cacaplay.cacatools.downloadmanager'
$PublishedId = 'aonppfnabjnicjjeoofkfjofolfibggp'

function Write-Utf8NoBom {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

$RequestedId = $ChromiumExtensionId.Trim().ToLowerInvariant()
$AllowedIds = @($PublishedId)
if ($RequestedId -ne $PublishedId) { $AllowedIds += $RequestedId }

$AppPath = (Resolve-Path -LiteralPath $AppExecutable).Path
if (-not $AppPath.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'AppExecutable debe apuntar a cacatools-desktop.exe instalado.'
}

# Chrome launches the Native Messaging host directly. It must never launch the
# desktop UI executable, which does not implement the stdio framing protocol.
$Executable = Join-Path (Split-Path -Parent $AppPath) 'resources\extension\cacatools-native-host.exe'
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "No se encontró el Native Messaging host junto a la aplicación: $Executable"
}
$Executable = (Resolve-Path -LiteralPath $Executable).Path

$HostDirectory = Join-Path $env:LOCALAPPDATA 'CacaTools\DownloadManager\ExtensionBridge\hosts'
New-Item -ItemType Directory -Force -Path $HostDirectory | Out-Null
$ManifestPath = Join-Path $HostDirectory "$HostName.chromium.json"
$Manifest = [ordered]@{
  name = $HostName
  description = 'Puente local para Clear Download Manager'
  path = $Executable
  type = 'stdio'
  allowed_origins = @($AllowedIds | ForEach-Object { "chrome-extension://$_/" })
}
Write-Utf8NoBom -Path $ManifestPath -Content (($Manifest | ConvertTo-Json -Depth 6) + [Environment]::NewLine)

$RegistryRoots = [ordered]@{
  Chrome = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts'
  Edge = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
  Chromium = 'HKCU:\Software\Chromium\NativeMessagingHosts'
  Brave = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
}
$Selected = if ($Browsers -contains 'All') { @($RegistryRoots.Keys) } else { $Browsers }
foreach ($Browser in $Selected) {
  $Key = Join-Path $RegistryRoots[$Browser] $HostName
  New-Item -Path $Key -Force | Out-Null
  Set-Item -Path $Key -Value $ManifestPath
  Write-Host "OK: $Browser -> $ManifestPath"
}

Write-Host ''
Write-Host "Host: $HostName" -ForegroundColor Green
Write-Host "Extensiones permitidas: $($AllowedIds -join ', ')"
Write-Host 'El ID publicado fijo siempre se conserva. No se usan comodines.'
