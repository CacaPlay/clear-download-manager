[CmdletBinding()]
param(
  [string[]]$ChromiumExtensionIds = @('aonppfnabjnicjjeoofkfjofolfibggp'),
  [string[]]$FirefoxExtensionIds = @(),
  [ValidateSet('chrome', 'edge', 'brave', 'chromium')]
  [string[]]$Browsers = @('chrome', 'edge', 'brave', 'chromium'),
  [switch]$Disable
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Root 'src-tauri\resources\extension\extension-config.json'

function Write-Utf8NoBom {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

$Chromium = @($ChromiumExtensionIds | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
$Firefox = @($FirefoxExtensionIds | ForEach-Object { $_.Trim() } | Where-Object { $_ })

foreach ($Id in $Chromium) {
  if ($Id -notmatch '^[a-p]{32}$') {
    throw "ID Chromium no valido: $Id. Debe tener 32 caracteres entre a y p."
  }
}
foreach ($Id in $Firefox) {
  if ($Id.Length -gt 160 -or $Id -match '\s') {
    throw "ID Firefox no valido: $Id"
  }
}
if (-not $Disable -and $Chromium -notcontains 'aonppfnabjnicjjeoofkfjofolfibggp') {
  $Chromium = @('aonppfnabjnicjjeoofkfjofolfibggp') + @($Chromium)
}

$Config = [ordered]@{
  enabled = -not [bool]$Disable
  chromiumExtensionIds = $Chromium
  firefoxExtensionIds = $Firefox
  browsers = @($Browsers | Select-Object -Unique)
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ConfigPath) | Out-Null
Write-Utf8NoBom -Path $ConfigPath -Content (($Config | ConvertTo-Json -Depth 8) + [Environment]::NewLine)

Write-Host ''
if ($Disable) {
  Write-Host 'Integracion automatica de la extension deshabilitada.' -ForegroundColor Yellow
} else {
  Write-Host 'Integracion automatica de la extension configurada.' -ForegroundColor Green
  Write-Host "Chromium IDs: $($Chromium -join ', ')"
  Write-Host "Firefox IDs:  $($Firefox -join ', ')"
  Write-Host "Navegadores:  $($Browsers -join ', ')"
  Write-Host 'Al iniciar una compilacion instalada, CacaTools registrara el host en HKCU sin pedir ajustes dentro de la app.'
}

Write-Host ''
Write-Host 'Actualizando MANIFEST.sha256 porque la configuracion de produccion cambio conscientemente...' -ForegroundColor Cyan
Push-Location $Root
try {
  & node scripts/generate-source-manifest.mjs
  if ($LASTEXITCODE -ne 0) { throw "No se pudo regenerar MANIFEST.sha256 (codigo $LASTEXITCODE)." }
} finally {
  Pop-Location
}
