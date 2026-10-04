Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:GITHUB_REF -ne 'refs/heads/main') {
  throw 'Component releases can only be dispatched from main.'
}

$semverPattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
foreach ($name in @('MEDIA_TOOLS_VERSION', 'TORRENT_ENGINE_VERSION')) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value) -or $value -notmatch $semverPattern) {
    throw "$name must be a valid semantic version."
  }
}

if ([string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID) -or $env:GITHUB_RUN_ID -notmatch '^\d{1,20}$' -or
    [string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ATTEMPT) -or $env:GITHUB_RUN_ATTEMPT -notmatch '^\d{1,8}$') {
  throw 'GitHub run identity is missing or invalid.'
}

$releaseTag = "components-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
$catalogBranch = "component-catalog-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
$repository = $env:GITHUB_REPOSITORY
if ([string]::IsNullOrWhiteSpace($repository) -or $repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw 'GitHub repository identity is missing or invalid.'
}

function Assert-EndpointAbsent([string]$Endpoint, [string]$Label) {
  $response = @(& gh api $Endpoint 2>&1)
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) { throw "$Label already exists; refusing to overwrite it." }
  $message = $response -join "`n"
  if ($message -notmatch '(?i)HTTP 404|Not Found \(HTTP 404\)') {
    throw "Could not confirm that $Label is absent: $message"
  }
}

Assert-EndpointAbsent "repos/$repository/git/ref/tags/$releaseTag" "tag $releaseTag"
Assert-EndpointAbsent "repos/$repository/releases/tags/$releaseTag" "release $releaseTag"
Assert-EndpointAbsent "repos/$repository/git/ref/heads/$catalogBranch" "branch $catalogBranch"

$pullNumbers = @(& gh api --paginate "repos/$repository/pulls?state=open&base=main&per_page=100" --jq '.[].number' 2>&1)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect open pull requests before component publication.' }
foreach ($number in $pullNumbers) {
  if ([string]::IsNullOrWhiteSpace([string]$number)) { continue }
  $files = @(& gh api --paginate "repos/$repository/pulls/$number/files?per_page=100" --jq '.[].filename' 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect files in open PR #$number." }
  if ($files -contains 'distribution/components/component-catalog-v1.json') {
    throw "Open PR #$number already changes the stable component catalog; merge or close it before another release."
  }
}

$catalogPath = Join-Path $PSScriptRoot '..\distribution\components\component-catalog-v1.json'
$catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
try { $sequence = [UInt64]$catalog.payload.sequence } catch { throw 'The stable signed catalog sequence is missing or invalid.' }
if ($sequence -eq 0 -or $sequence -eq [UInt64]::MaxValue) {
  throw 'The stable signed catalog sequence cannot be safely incremented.'
}
$nextSequence = [UInt64]($sequence + 1)

$outputs = @(
  "release_tag=$releaseTag",
  "catalog_sequence=$nextSequence",
  "media_tools_version=$env:MEDIA_TOOLS_VERSION",
  "torrent_engine_version=$env:TORRENT_ENGINE_VERSION"
) -join "`n"
[System.IO.File]::AppendAllText($env:GITHUB_OUTPUT, "$outputs`n", [System.Text.UTF8Encoding]::new($false))
