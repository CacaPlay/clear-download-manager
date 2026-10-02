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
$PublishedId = 'aonppfnabjnicjjeoofkfjofolfibggp'
$Hosts = @(
  [pscustomobject]@{
    Name = 'lat.cacaplay.cleardownloadmanager'
    File = 'clear-download-manager-native-host.exe'
  },
  [pscustomobject]@{
    Name = 'lat.cacaplay.cacatools.downloadmanager'
    File = 'cacatools-native-host.exe'
  }
)

function Write-Utf8NoBom {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

$RequestedId = $ChromiumExtensionId.Trim().ToLowerInvariant()
$AllowedIds = @($PublishedId)
if ($RequestedId -ne $PublishedId) { $AllowedIds += $RequestedId }

$AppPath = (Resolve-Path -LiteralPath $AppExecutable).Path
if ([IO.Path]::GetFileName($AppPath) -cne 'clear-download-manager.exe') {
  throw 'AppExecutable debe apuntar a clear-download-manager.exe instalado.'
}

# Both manifests target the same upgraded application. The legacy host name
# remains registered for browser extensions installed before v1.0.0.
$HostDirectory = Join-Path $env:LOCALAPPDATA 'CacaTools\DownloadManager\ExtensionBridge\hosts'
New-Item -ItemType Directory -Force -Path $HostDirectory | Out-Null
$Resources = Join-Path (Split-Path -Parent $AppPath) 'resources\extension'
foreach ($HostSpec in $Hosts) {
  $Executable = Join-Path $Resources $HostSpec.File
  if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
    throw "No se encontró el Native Messaging host junto a la aplicación: $Executable"
  }
  $Executable = (Resolve-Path -LiteralPath $Executable).Path
  $ManifestPath = Join-Path $HostDirectory "$($HostSpec.Name).chromium.json"
  $Manifest = [ordered]@{
    name = $HostSpec.Name
    description = 'Puente local para Clear Download Manager'
    path = $Executable
    type = 'stdio'
    allowed_origins = @($AllowedIds | ForEach-Object { "chrome-extension://$_/" })
  }
  Write-Utf8NoBom -Path $ManifestPath -Content (($Manifest | ConvertTo-Json -Depth 6) + [Environment]::NewLine)
}

$RegistryRoots = [ordered]@{
  Chrome = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts'
  Edge = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
  Chromium = 'HKCU:\Software\Chromium\NativeMessagingHosts'
  Brave = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
}
$Selected = if ($Browsers -contains 'All') { @($RegistryRoots.Keys) } else { $Browsers }
foreach ($Browser in $Selected) {
  foreach ($HostSpec in $Hosts) {
    $Key = Join-Path $RegistryRoots[$Browser] $HostSpec.Name
    $ManifestPath = Join-Path $HostDirectory "$($HostSpec.Name).chromium.json"
    New-Item -Path $Key -Force | Out-Null
    Set-Item -Path $Key -Value $ManifestPath
    Write-Host "OK: $Browser -> $($HostSpec.Name)"
  }
}

Write-Host ''
Write-Host 'Hosts registrados: lat.cacaplay.cleardownloadmanager (principal) y lat.cacaplay.cacatools.downloadmanager (compatibilidad v1.0.0).' -ForegroundColor Green
Write-Host "Extensiones permitidas: $($AllowedIds -join ', ')"
Write-Host 'El ID publicado fijo siempre se conserva. No se usan comodines.'
