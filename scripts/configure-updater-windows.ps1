[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9_.-]+$')]
  [string]$GitHubOwner,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9_.-]+$')]
  [string]$GitHubRepository,

  [string]$PrivateKeyPath = (Join-Path $HOME '.tauri\cacatools-download-manager.key'),
  [switch]$SkipKeyGeneration
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$TauriConfigPath = Join-Path $Root 'src-tauri\tauri.conf.json'
$RuntimeConfigPath = Join-Path $Root 'src-tauri\resources\updater\updater-config.json'


function Write-Utf8NoBom {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Add-OrSetProperty {
  param([object]$Object, [string]$Name, $Value)
  if ($Object.PSObject.Properties.Name -contains $Name) {
    $Object.$Name = $Value
  } else {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  }
}

if (-not (Test-Path $TauriConfigPath)) {
  throw "No se encontro $TauriConfigPath"
}

$KeyDirectory = Split-Path -Parent $PrivateKeyPath
New-Item -ItemType Directory -Force -Path $KeyDirectory | Out-Null

$PublicKeyCandidates = @(
  "$PrivateKeyPath.pub",
  [IO.Path]::ChangeExtension($PrivateKeyPath, 'pub'),
  "$PrivateKeyPath.public"
) | Select-Object -Unique
$PublicKeyPath = $PublicKeyCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $PublicKeyPath -and -not $SkipKeyGeneration) {
  Write-Host "Generando par de claves Tauri fuera del proyecto..." -ForegroundColor Cyan
  Push-Location $Root
  try {
    & npm run tauri signer generate -- -w $PrivateKeyPath
    if ($LASTEXITCODE -ne 0) { throw "tauri signer generate termino con codigo $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  $PublicKeyPath = $PublicKeyCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $PublicKeyPath) {
  throw "No se encontro la clave publica. Se esperaba una de estas rutas: $($PublicKeyCandidates -join ', ')"
}
if (-not (Test-Path $PrivateKeyPath)) {
  throw "No se encontro la clave privada en $PrivateKeyPath"
}

$PublicKey = (Get-Content -LiteralPath $PublicKeyPath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($PublicKey)) { throw 'La clave publica esta vacia.' }

$Repository = "$GitHubOwner/$GitHubRepository"
$Endpoint = "https://github.com/$Repository/releases/latest/download/latest.json"
$Config = Get-Content -LiteralPath $TauriConfigPath -Raw | ConvertFrom-Json

Add-OrSetProperty -Object $Config.bundle -Name 'createUpdaterArtifacts' -Value $true
if (-not ($Config.PSObject.Properties.Name -contains 'plugins')) {
  Add-OrSetProperty -Object $Config -Name 'plugins' -Value ([pscustomobject]@{})
}
$UpdaterPlugin = [pscustomobject]@{
  pubkey = $PublicKey
  endpoints = @($Endpoint)
  windows = [pscustomobject]@{ installMode = 'passive' }
}
Add-OrSetProperty -Object $Config.plugins -Name 'updater' -Value $UpdaterPlugin
Write-Utf8NoBom -Path $TauriConfigPath -Content (($Config | ConvertTo-Json -Depth 30) + [Environment]::NewLine)

$RuntimeConfig = [ordered]@{
  enabled = $true
  channel = 'stable'
  provider = 'github-releases'
  endpoint = $Endpoint
  repository = $Repository
  configured_at = (Get-Date).ToUniversalTime().ToString('o')
}
Write-Utf8NoBom -Path $RuntimeConfigPath -Content (($RuntimeConfig | ConvertTo-Json -Depth 8) + [Environment]::NewLine)

Write-Host ''
Write-Host 'Actualizador configurado.' -ForegroundColor Green
Write-Host "Repositorio: $Repository"
Write-Host "Endpoint:   $Endpoint"
Write-Host "Publica:    $PublicKeyPath"
Write-Host "Privada:    $PrivateKeyPath" -ForegroundColor Yellow
Write-Host ''
Write-Host 'IMPORTANTE: guarda la clave privada y su contrasena fuera del proyecto.' -ForegroundColor Yellow
Write-Host 'Antes de compilar una version publicable ejecuta en la misma consola:'
Write-Host "  `$env:TAURI_SIGNING_PRIVATE_KEY='$PrivateKeyPath'"
Write-Host "  `$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<tu-contrasena-si-la-usaste>'"
Write-Host 'Luego ejecuta COMPILAR_CACATOOLS_WINDOWS.cmd.'

Write-Host ''
Write-Host 'Actualizando el manifiesto oficial porque la configuración de producción cambió conscientemente...' -ForegroundColor Cyan
Push-Location $Root
try {
  & node scripts/generate-source-manifest.mjs
  if ($LASTEXITCODE -ne 0) { throw "No se pudo regenerar MANIFEST.sha256 (codigo $LASTEXITCODE)." }
} finally {
  Pop-Location
}
