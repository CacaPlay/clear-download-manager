param(
  [string]$OutputFile = 'Clear Download Manager QA v1.0.0.exe',
  [switch]$EnableV1ExtensionBridge
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ConfigPath = Join-Path $ProjectRoot 'src-tauri\tauri.qa.conf.json'
$CargoPath = Join-Path $ProjectRoot 'src-tauri\Cargo.toml'
$CatalogKeyPath = Join-Path $ProjectRoot 'src-tauri\src\components\catalog_key.rs'
$DistributionPath = Join-Path $ProjectRoot 'src-tauri\src\components\distribution.rs'
$BuildScriptPath = Join-Path $ProjectRoot 'src-tauri\build.rs'
$OutputRoot = Join-Path $ProjectRoot 'artifacts\qa-redesign'
$TargetRoot = Join-Path $OutputRoot 'cargo-target'
$FrontendDist = Join-Path $OutputRoot 'dist-optimized'
$OutputFile = [string]$OutputFile.Trim()
if ([string]::IsNullOrWhiteSpace($OutputFile) -or [IO.Path]::GetFileName($OutputFile) -cne $OutputFile -or [IO.Path]::GetExtension($OutputFile) -cne '.exe') { throw 'QA output must be a standalone .exe filename without a directory.' }
if ($OutputFile -ceq 'Clear Download Manager QA.exe') { throw 'The approved baseline executable is immutable; choose a new output filename.' }
$OutputExe = Join-Path $OutputRoot $OutputFile
$BaselineExe = Join-Path $OutputRoot 'Clear Download Manager QA.exe'
$BaselineHash = if (Test-Path -LiteralPath $BaselineExe) { (Get-FileHash -LiteralPath $BaselineExe -Algorithm SHA256).Hash } else { $null }

$ExpectedIdentifier = 'lat.cacaplay.cleardownloadmanager.qa'
$ExpectedEndpoint = 'http://127.0.0.1:49301/component-catalog-v1.json'
$ExpectedKeyId = 'component-catalog-qa-20260927'
$ExpectedFingerprint = '7910b5251d799b5160471f860db7de4bd478dea5280e5ebd7a63a1ec2a655313'

$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ($Config.identifier -cne $ExpectedIdentifier) { throw 'QA build rejected: unexpected application identifier.' }
if ($Config.productName -cne 'Clear Download Manager QA') { throw 'QA build rejected: unexpected product name.' }
if ($Config.bundle.active -ne $false -or $Config.bundle.createUpdaterArtifacts -ne $false) {
  throw 'QA build rejected: this path must produce an unbundled executable only.'
}
if ($Config.plugins.updater.pubkey -cne '' -or @($Config.plugins.updater.endpoints).Count -ne 0) {
  throw 'QA build rejected: updater configuration must contain no key or endpoint.'
}

$CargoText = Get-Content -LiteralPath $CargoPath -Raw
if ($CargoText -notmatch '(?m)^qa-component-manager\s*=\s*\[\]\s*$') {
  throw 'QA build rejected: the QA feature is not declared as a standalone feature.'
}
if ($CargoText -match '(?ms)^default\s*=\s*\[[^\]]*qa-component-manager') {
  throw 'QA build rejected: the QA feature must never be enabled by default.'
}
if ($EnableV1ExtensionBridge -and $CargoText -notmatch '(?m)^qa-extension-bridge\s*=\s*\["qa-component-manager"\]\s*$') {
  throw 'QA build rejected: the opt-in V1 extension bridge feature is missing or no longer isolated.'
}
$QaFeatures = if ($EnableV1ExtensionBridge) { 'qa-component-manager,qa-extension-bridge' } else { 'qa-component-manager' }
if ($CargoText -notmatch 'github-updater\s*=\s*\["dep:tauri-plugin-updater"\]') {
  throw 'QA build rejected: production updater feature wiring changed; review the isolation plan.'
}
$KeyText = Get-Content -LiteralPath $CatalogKeyPath -Raw
$DistributionText = Get-Content -LiteralPath $DistributionPath -Raw
$BuildText = Get-Content -LiteralPath $BuildScriptPath -Raw
if ($KeyText -notmatch [regex]::Escape($ExpectedKeyId) -or
    $DistributionText -notmatch [regex]::Escape($ExpectedEndpoint) -or
    $BuildText -notmatch [regex]::Escape($ExpectedIdentifier) -or
    $BuildText -notmatch 'CARGO_FEATURE_GITHUB_UPDATER') {
  throw 'QA build rejected: the Rust trust, endpoint, or build-time identity guard is missing.'
}

$KeyMatch = [regex]::Match($KeyText, '(?s)#\[cfg\(feature = "qa-component-manager"\)\]\s*pub\(crate\) const PUBLIC_KEY_BASE64: &str = "([^"]+)";')
if (-not $KeyMatch.Success) { throw 'QA build rejected: the QA public key is missing.' }
$PublicKeyBytes = [Convert]::FromBase64String($KeyMatch.Groups[1].Value)
$ShaProvider = [System.Security.Cryptography.SHA256]::Create()
try { $Sha = $ShaProvider.ComputeHash($PublicKeyBytes) }
finally { $ShaProvider.Dispose() }
$Fingerprint = ([BitConverter]::ToString($Sha)).Replace('-', '').ToLowerInvariant()
if ($Fingerprint -cne $ExpectedFingerprint) { throw 'QA build rejected: the QA key fingerprint does not match the prepared catalog.' }

New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
$env:CARGO_TARGET_DIR = $TargetRoot
$env:npm_config_cache = Join-Path $OutputRoot 'npm-cache'
$env:CDM_QA_EXPECTED_IDENTIFIER = $ExpectedIdentifier
$env:CDM_QA_EXPECTED_COMPONENT_ENDPOINT = $ExpectedEndpoint
$env:CDM_QA_EXPECTED_COMPONENT_KEY_ID = $ExpectedKeyId
$QaCatalogPath = Join-Path $OutputRoot 'qa-harness\component-catalog-v1.json'
if (Test-Path -LiteralPath $QaCatalogPath) {
  $env:CDM_QA_CATALOG_PATH = $QaCatalogPath
} else {
  Remove-Item Env:CDM_QA_CATALOG_PATH -ErrorAction SilentlyContinue
}
$env:CDM_WEB_DIST_DIR = $FrontendDist

Push-Location $ProjectRoot
try {
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules'))) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
  }

  & cargo.exe test --manifest-path src-tauri/Cargo.toml --no-default-features --features $QaFeatures --lib qa_
  if ($LASTEXITCODE -ne 0) { throw "QA isolation tests failed with exit code $LASTEXITCODE." }
  & cargo.exe test --manifest-path src-tauri/Cargo.toml --no-default-features --features $QaFeatures --lib prepared_qa_catalog_signature_is_valid_when_catalog_path_is_supplied
  if ($LASTEXITCODE -ne 0) { throw "The prepared QA catalog signature test failed with exit code $LASTEXITCODE." }

  & npx.cmd --no-install tauri build --no-bundle --config src-tauri/tauri.qa.conf.json --features $QaFeatures -- --no-default-features
  if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE." }

  $BuiltExe = Join-Path $TargetRoot 'release\clear-download-manager.exe'
  if (-not (Test-Path -LiteralPath $BuiltExe)) { throw 'The standalone QA executable was not produced.' }
  try {
    Copy-Item -LiteralPath $BuiltExe -Destination $OutputExe -Force
  } catch {
    $Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutputBaseName = [IO.Path]::GetFileNameWithoutExtension($OutputFile)
    $FallbackFileName = "$OutputBaseName - $Timestamp.exe"
    $Suffix = 1
    while (Test-Path -LiteralPath (Join-Path $OutputRoot $FallbackFileName)) {
      $FallbackFileName = "$OutputBaseName - $Timestamp-$Suffix.exe"
      $Suffix++
    }
    $OutputExe = Join-Path $OutputRoot $FallbackFileName
    Copy-Item -LiteralPath $BuiltExe -Destination $OutputExe
  }
  if ($BaselineHash -and (Get-FileHash -LiteralPath $BaselineExe -Algorithm SHA256).Hash -cne $BaselineHash) {
    throw 'The approved baseline executable changed during the QA build.'
  }
  $ArtifactHash = (Get-FileHash -LiteralPath $OutputExe -Algorithm SHA256).Hash.ToLowerInvariant()
  $Artifact = Get-Item -LiteralPath $OutputExe
  $ExtensionBridgeStatus = if ($EnableV1ExtensionBridge) { 'V1 QA bridge enabled' } else { 'Disabled' }
  [pscustomobject]@{
    Path = $OutputExe
    Bytes = $Artifact.Length
    Sha256 = $ArtifactHash
    ApplicationIdentifier = $ExpectedIdentifier
    ComponentCatalogEndpoint = $ExpectedEndpoint
    CatalogKeyId = $ExpectedKeyId
    CatalogKeyFingerprint = $Fingerprint
    ExtensionBridge = $ExtensionBridgeStatus
    Updater = 'Disabled in this local components/UI QA executable'
  } | Format-List
}
finally {
  Pop-Location
  Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:npm_config_cache -ErrorAction SilentlyContinue
  Remove-Item Env:CDM_QA_EXPECTED_IDENTIFIER -ErrorAction SilentlyContinue
  Remove-Item Env:CDM_QA_EXPECTED_COMPONENT_ENDPOINT -ErrorAction SilentlyContinue
  Remove-Item Env:CDM_QA_EXPECTED_COMPONENT_KEY_ID -ErrorAction SilentlyContinue
  Remove-Item Env:CDM_QA_CATALOG_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:CDM_WEB_DIST_DIR -ErrorAction SilentlyContinue
}
