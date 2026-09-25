[CmdletBinding()]
param(
  [switch]$RequireClean,
  [string]$ExpectedHead = '',
  [string]$BuildIdentityPath = '',
  [string]$ExePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (git rev-parse --show-toplevel).Trim()
$Root = [IO.Path]::GetFullPath($Root)
$WorkspacePath = Join-Path $Root '.cdm\workspace.json'
if (-not (Test-Path -LiteralPath $WorkspacePath -PathType Leaf)) { throw "Missing workspace contract: $WorkspacePath" }
$Workspace = Get-Content -LiteralPath $WorkspacePath -Raw | ConvertFrom-Json
$Remote = (git config --get remote.origin.url).Trim()
$Branch = (git branch --show-current).Trim()
$Head = (git rev-parse HEAD).Trim()
$CommonDirRaw = (git rev-parse --git-common-dir).Trim()
$CommonDir = if ([IO.Path]::IsPathRooted($CommonDirRaw)) { [IO.Path]::GetFullPath($CommonDirRaw) } else { [IO.Path]::GetFullPath((Join-Path $Root $CommonDirRaw)) }
$Status = (git status --porcelain | Out-String).Trim()
$Package = Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$CargoText = Get-Content -LiteralPath (Join-Path $Root 'src-tauri\Cargo.toml') -Raw
$Tauri = Get-Content -LiteralPath (Join-Path $Root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$Version = [string]$Package.version
$CargoVersion = ([regex]::Match($CargoText, '(?m)^version\s*=\s*"([^"]+)"')).Groups[1].Value
$Checks = [ordered]@{
  repo_id = ([string]$Workspace.repo_id -eq 'clear-download-manager-source')
  remote = ($Remote -eq [string]$Workspace.canonical_remote)
  branch = ($Branch -eq [string]$Workspace.branch)
  package_version = ($Version -eq [string]$Workspace.app_version)
  cargo_version = ($CargoVersion -eq $Version)
  tauri_version = ([string]$Tauri.version -eq $Version)
}
if ($RequireClean) { $Checks.clean = [string]::IsNullOrWhiteSpace($Status) }
if ($ExpectedHead) { $Checks.expected_head = ($Head.StartsWith($ExpectedHead, [StringComparison]::OrdinalIgnoreCase)) }
foreach ($Check in $Checks.GetEnumerator()) { if (-not $Check.Value) { throw "CDM execution guard failed: $($Check.Key)" } }

if (-not [string]::IsNullOrWhiteSpace($BuildIdentityPath)) {
  $IdentityFile = if ([IO.Path]::IsPathRooted($BuildIdentityPath)) { $BuildIdentityPath } else { Join-Path $Root $BuildIdentityPath }
  if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) { throw "BUILD-IDENTITY.json not found: $IdentityFile" }
  $Identity = Get-Content -LiteralPath $IdentityFile -Raw | ConvertFrom-Json
  foreach ($Field in @($Workspace.build_identity.required_fields)) {
    $Property = $Identity.PSObject.Properties[$Field]
    if ($null -eq $Property -or [string]::IsNullOrWhiteSpace([string]$Property.Value)) { throw "BUILD-IDENTITY.json missing required field: $Field" }
  }
  if ([string]$Identity.repo_id -ne [string]$Workspace.repo_id) { throw 'BUILD-IDENTITY.json repo_id mismatch' }
  if ([string]$Identity.commit -notmatch ('^' + [regex]::Escape($Head.Substring(0, 7)))) { throw 'BUILD-IDENTITY.json commit does not identify current HEAD' }
  if ([string]$Identity.version -ne $Version) { throw 'BUILD-IDENTITY.json version mismatch' }
  if ($Identity.artifact_sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'BUILD-IDENTITY.json artifact_sha256 must be SHA-256' }
  if ($ExePath) {
    $ResolvedExe = if ([IO.Path]::IsPathRooted($ExePath)) { $ExePath } else { Join-Path $Root $ExePath }
    if (-not (Test-Path -LiteralPath $ResolvedExe -PathType Leaf)) { throw "Review artifact not found: $ResolvedExe" }
    $ActualHash = (Get-FileHash -LiteralPath $ResolvedExe -Algorithm SHA256).Hash
    if ($ActualHash -ine [string]$Identity.artifact_sha256) { throw 'BUILD-IDENTITY.json artifact hash mismatch' }
  }
}

$StatePath = Join-Path $CommonDir 'cdm-execution-state.json'
$State = [ordered]@{
  schema = 1
  repo_id = [string]$Workspace.repo_id
  root = $Root
  branch = $Branch
  head = $Head
  version = $Version
  checked_at_utc = (Get-Date).ToUniversalTime().ToString('o')
  clean = [string]::IsNullOrWhiteSpace($Status)
}
[IO.File]::WriteAllText($StatePath, (($State | ConvertTo-Json -Depth 5) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
Write-Host "OK: CDM execution guard ($Head)" -ForegroundColor Green
