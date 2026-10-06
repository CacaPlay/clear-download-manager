[CmdletBinding()]
param(
  [string]$ReleaseNotes = 'Mejoras de estabilidad, rendimiento e interfaz.',
  [string]$Tag,
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'powershell-hash-compat.ps1')
$TauriConfigPath = Join-Path $Root 'src-tauri\tauri.conf.json'
$UpdaterConfigPath = Join-Path $Root 'src-tauri\resources\updater\updater-config.json'
$OutputDirectory = Join-Path $Root 'output\update-release'
$CargoTargetFromConfig = $null
$CargoConfigPath = Join-Path $Root '.cargo\config.toml'
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
  Join-Path $Root 'src-tauri\target'
}
$BundleRoot = Join-Path $TauriTargetRoot 'release\bundle'

function Write-Utf8NoBom {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function ConvertTo-ReleaseAssetName {
  param([Parameter(Mandatory = $true)][string]$Name)
  # GitHub release asset uploads normalize whitespace to dots.  Use the
  # normalized name before generating latest.json so the updater URL always
  # resolves to the exact asset published by the release action.
  return [regex]::Replace($Name, '\s+', '.')
}


$TauriConfig = Get-Content -LiteralPath $TauriConfigPath -Raw | ConvertFrom-Json
$UpdaterConfig = Get-Content -LiteralPath $UpdaterConfigPath -Raw | ConvertFrom-Json
if (-not $UpdaterConfig.enabled -or [string]::IsNullOrWhiteSpace($UpdaterConfig.repository)) {
  throw 'Primero ejecuta CONFIGURAR_ACTUALIZACIONES_WINDOWS.cmd con tu usuario y repositorio de GitHub.'
}
$Version = [string]$TauriConfig.version
if ([string]::IsNullOrWhiteSpace($Tag)) { $Tag = "v$Version" }

if ($Clean -and (Test-Path $OutputDirectory)) { Remove-Item -Recurse -Force $OutputDirectory }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$SignatureFiles = Get-ChildItem -Path $BundleRoot -Recurse -File -Filter '*.sig' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like '*.nsis.zip.sig' -or $_.Name -like '*.msi.zip.sig' } |
  Sort-Object @{ Expression = { if ($_.Name -like '*.nsis.zip.sig') { 0 } elseif ($_.Name -like '*.msi.zip.sig') { 1 } else { 2 } } }, LastWriteTime -Descending
if (-not $SignatureFiles) {
  throw 'No se encontraron artefactos updater .nsis.zip.sig o .msi.zip.sig. Verifica createUpdaterArtifacts v1Compatible y la firma Tauri.'
}

$SignatureFile = $SignatureFiles | Select-Object -First 1
$ArtifactPath = $SignatureFile.FullName.Substring(0, $SignatureFile.FullName.Length - 4)
if (-not (Test-Path $ArtifactPath)) { throw "No se encontro el artefacto firmado asociado: $ArtifactPath" }
$ArtifactFile = Get-Item -LiteralPath $ArtifactPath
$ArtifactAssetName = ConvertTo-ReleaseAssetName $ArtifactFile.Name
$SignatureAssetName = ConvertTo-ReleaseAssetName $SignatureFile.Name

Copy-Item -LiteralPath $ArtifactFile.FullName -Destination (Join-Path $OutputDirectory $ArtifactAssetName) -Force
Copy-Item -LiteralPath $SignatureFile.FullName -Destination (Join-Path $OutputDirectory $SignatureAssetName) -Force

$SetupInstaller = Get-ChildItem -Path $BundleRoot -Recurse -File -Filter '*setup.exe' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $SetupInstaller) {
  throw 'No se encontro el instalador de Windows necesario para los enlaces de descarga directa.'
}
$SetupAssetName = ConvertTo-ReleaseAssetName $SetupInstaller.Name
$VersionedSetupPath = Join-Path $OutputDirectory $SetupAssetName
Copy-Item -LiteralPath $SetupInstaller.FullName -Destination $VersionedSetupPath -Force

# Keep the website download URL stable while publishing each versioned installer too.
$StableSetupPath = Join-Path $OutputDirectory 'ClearDownloadManagerSetup.exe'
Copy-Item -LiteralPath $SetupInstaller.FullName -Destination $StableSetupPath -Force

$EncodedName = [Uri]::EscapeDataString($ArtifactAssetName).Replace('%2F', '/')
$DownloadUrl = "https://github.com/$($UpdaterConfig.repository)/releases/download/$Tag/$EncodedName"
$Latest = [ordered]@{
  version = $Version
  notes = $ReleaseNotes
  pub_date = (Get-Date).ToUniversalTime().ToString('o')
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = (Get-Content -LiteralPath $SignatureFile.FullName -Raw).Trim()
      url = $DownloadUrl
    }
  }
}
Write-Utf8NoBom -Path (Join-Path $OutputDirectory 'latest.json') -Content (($Latest | ConvertTo-Json -Depth 10) + [Environment]::NewLine)

Write-Host "OK: publicacion preparada en $OutputDirectory" -ForegroundColor Green
Write-Host "Artefacto de actualizacion: $ArtifactAssetName"
Write-Host "Endpoint: https://github.com/$($UpdaterConfig.repository)/releases/latest/download/latest.json"
