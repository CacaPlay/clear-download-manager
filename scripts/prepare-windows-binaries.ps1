param(
  [string]$YtDlpVersion = "2026.08.19",
  [string]$YtDlpCommit = "3a08beaf031ab68f966401ead017ac81fe8486cf",
  [string]$YtDlpLicensesSha256 = "472aefe951c7db35e1657c1d13fd337140511ed6f2b329205105ad441c5a02b7",
  [string]$FfmpegVersion = "9.0.2",
  [string]$FfmpegSourceCommit = "946fcce07b6dcd0331c8cc609192aeff5e1924f8",
  [string]$Aria2Version = "1.37.0",
  [string]$Aria2SourceCommit = "02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a",
  [string]$Aria2Sha256 = "67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288",
  [string]$DenoVersion = "2.9.7",
  [string]$DenoSha256 = "a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238"
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "powershell-hash-compat.ps1")
$BinDir = Join-Path $Root "src-tauri\resources\bin"
$LicenseDir = Join-Path $Root "src-tauri\resources\licenses"
$FullCommitPattern = '^[a-fA-F0-9]{40}$'
if ($YtDlpCommit -notmatch $FullCommitPattern -or $FfmpegSourceCommit -notmatch $FullCommitPattern -or $Aria2SourceCommit -notmatch $FullCommitPattern -or
    $YtDlpCommit -ne "3a08beaf031ab68f966401ead017ac81fe8486cf" -or
    $FfmpegSourceCommit -ne "946fcce07b6dcd0331c8cc609192aeff5e1924f8" -or
    $Aria2SourceCommit -ne "02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a") {
  throw "The pinned full 40-character upstream commits for yt-dlp, aria2, and FFmpeg are required."
}
$Work = Join-Path $env:TEMP ("cdm-media-runtime-{0}" -f [guid]::NewGuid().ToString("N"))
$CacheDir = Join-Path $Root "output\runtime-cache"
$GitHubReleaseCache = @{}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Path $Work, $BinDir, $LicenseDir, $CacheDir -Force | Out-Null

function Invoke-DownloadFile {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [hashtable]$Headers = @{},
    [int]$Attempts = 4
  )
  $Temporary = "$OutFile.partial"
  for ($Attempt = 1; $Attempt -le $Attempts; $Attempt++) {
    try {
      Remove-Item $Temporary -Force -ErrorAction SilentlyContinue
      Write-Host "Downloading $Uri (attempt $Attempt/$Attempts)..."
      Invoke-WebRequest -Uri $Uri -OutFile $Temporary -Headers $Headers -UseBasicParsing -TimeoutSec 240
      if (-not (Test-Path $Temporary) -or (Get-Item $Temporary).Length -le 0) {
        throw "The downloaded file is empty."
      }
      Move-Item $Temporary $OutFile -Force
      return
    }
    catch {
      Remove-Item $Temporary -Force -ErrorAction SilentlyContinue
      if ($Attempt -ge $Attempts) { throw }
      $Delay = [Math]::Min(20, [Math]::Pow(2, $Attempt))
      Write-Host "Download failed: $($_.Exception.Message). Retrying in $Delay seconds..." -ForegroundColor Yellow
      Start-Sleep -Seconds $Delay
    }
  }
}

function Get-GitHubAssetSha256 {
  param(
    [Parameter(Mandatory = $true)][string]$ReleaseApi,
    [Parameter(Mandatory = $true)][string]$AssetName,
    [hashtable]$Headers = @{}
  )
  try {
    if ($script:GitHubReleaseCache.ContainsKey($ReleaseApi)) {
      $Release = $script:GitHubReleaseCache[$ReleaseApi]
    }
    else {
      $Release = Invoke-RestMethod -Uri $ReleaseApi -Headers $Headers -Method Get -TimeoutSec 45
      $script:GitHubReleaseCache[$ReleaseApi] = $Release
    }
    $Asset = $Release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
    if (-not $Asset) {
      Write-Host "INFO: GitHub API did not list $AssetName; the pinned SHA-256 remains mandatory." -ForegroundColor Yellow
      return $null
    }
    $Digest = [string]$Asset.digest
    if ($Digest -match '^sha256:([a-fA-F0-9]{64})$') {
      return $Matches[1].ToLowerInvariant()
    }
    Write-Host "INFO: GitHub API has no SHA-256 digest for $AssetName; using the pinned digest." -ForegroundColor Yellow
    return $null
  }
  catch {
    Write-Host "INFO: GitHub asset metadata could not be checked: $($_.Exception.Message). The pinned digest remains mandatory." -ForegroundColor Yellow
    return $null
  }
}

function Ensure-VerifiedCache {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][scriptblock]$Download
  )
  $Expected = $ExpectedSha256.Trim().ToLowerInvariant()
  if (Test-Path $Path) {
    $Cached = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Cached -eq $Expected) {
      Write-Host "Using verified cache: $Path" -ForegroundColor DarkGreen
      return
    }
    Remove-Item $Path -Force
  }
  & $Download
  $Actual = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) {
    Remove-Item $Path -Force -ErrorAction SilentlyContinue
    throw "SHA-256 mismatch. Expected: $Expected; received: $Actual"
  }
}

# Elimina una copia residual del runtime retirado para impedir que se incluya
# accidentalmente al empaquetar una carpeta de binarios reutilizada.
Get-ChildItem $BinDir -Filter 'spotdl*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force

$ReleaseBase = "https://github.com/yt-dlp/yt-dlp/releases/download/$YtDlpVersion"
$YtDlpReleaseApi = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/tags/$YtDlpVersion"
$YtDlpHeaders = @{
  "User-Agent" = "CDM-Desktop-Build"
  "Accept" = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2026-03-10"
}
$YtDlpUrl = "$ReleaseBase/yt-dlp.exe"
$YtDlpChecksumsUrl = "$ReleaseBase/SHA2-256SUMS"
$YtDlpLicensesUrl = "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$YtDlpCommit/THIRD_PARTY_LICENSES.txt"
$YtDlpPath = Join-Path $BinDir "yt-dlp.exe"
$YtDlpDownload = Join-Path $CacheDir "yt-dlp-$YtDlpVersion.exe"
$YtDlpChecksums = Join-Path $Work "SHA2-256SUMS"
$YtDlpLicensesDownload = Join-Path $CacheDir "yt-dlp-$YtDlpVersion-THIRD_PARTY_LICENSES.txt"

Write-Host "Resolving yt-dlp $YtDlpVersion from the official release..."
Invoke-DownloadFile -Uri $YtDlpChecksumsUrl -OutFile $YtDlpChecksums
$YtDlpExpectedLine = Get-Content $YtDlpChecksums |
  Where-Object { $_ -match "\syt-dlp\.exe$" } |
  Select-Object -First 1
if (-not $YtDlpExpectedLine) {
  throw "The official SHA-256 for yt-dlp.exe was not found."
}
$YtDlpExpected = ($YtDlpExpectedLine -split "\s+")[0].ToLowerInvariant()
$YtDlpApiSha256 = Get-GitHubAssetSha256 -ReleaseApi $YtDlpReleaseApi -AssetName "yt-dlp.exe" -Headers $YtDlpHeaders
if ($YtDlpApiSha256 -and $YtDlpApiSha256 -ne $YtDlpExpected) {
  throw "The SHA2-256SUMS digest for yt-dlp.exe does not match the official GitHub asset digest."
}

# yt-dlp's release page links THIRD_PARTY_LICENSES.txt to the repository file
# at the immutable release commit; it is not a downloadable release asset and
# therefore cannot appear in the release assets API or SHA2-256SUMS. Download
# that exact source revision and require the pinned SHA-256 before packaging it.
$YtDlpLicensesExpected = $YtDlpLicensesSha256.Trim().ToLowerInvariant()
if ($YtDlpCommit -notmatch '^[a-fA-F0-9]{40}$') {
  throw "A full immutable yt-dlp source commit is required for THIRD_PARTY_LICENSES.txt."
}
if ($YtDlpLicensesExpected -notmatch '^[a-f0-9]{64}$') {
  throw "A trusted SHA-256 is required for yt-dlp THIRD_PARTY_LICENSES.txt."
}
Ensure-VerifiedCache -Path $YtDlpDownload -ExpectedSha256 $YtDlpExpected -Download { Invoke-DownloadFile -Uri $YtDlpUrl -OutFile $YtDlpDownload }
Ensure-VerifiedCache -Path $YtDlpLicensesDownload -ExpectedSha256 $YtDlpLicensesExpected -Download { Invoke-DownloadFile -Uri $YtDlpLicensesUrl -OutFile $YtDlpLicensesDownload }
Copy-Item $YtDlpDownload $YtDlpPath -Force
Copy-Item $YtDlpLicensesDownload (Join-Path $LicenseDir "YT-DLP-THIRD-PARTY-LICENSES.txt") -Force
$YtDlpActual = (Get-FileHash $YtDlpPath -Algorithm SHA256).Hash.ToLowerInvariant()

$Aria2AssetName = "aria2-$Aria2Version-win-64bit-build1.zip"
$Aria2ReleaseApi = "https://api.github.com/repos/aria2/aria2/releases/tags/release-$Aria2Version"
$Aria2Headers = @{ "User-Agent" = "CDM-Desktop-Build"; "Accept" = "application/vnd.github+json" }
$Aria2Expected = $Aria2Sha256.Trim().ToLowerInvariant()
if (-not $Aria2Expected) {
  throw "A trusted SHA-256 is required for aria2."
}
$Aria2ApiSha256 = Get-GitHubAssetSha256 -ReleaseApi $Aria2ReleaseApi -AssetName $Aria2AssetName -Headers $Aria2Headers
if ($Aria2ApiSha256 -and $Aria2ApiSha256 -ne $Aria2Expected) {
  throw "The pinned aria2 SHA-256 does not match the official GitHub asset digest."
}
$Aria2Url = "https://github.com/aria2/aria2/releases/download/release-$Aria2Version/$Aria2AssetName"
Write-Host "Preparing aria2 $Aria2Version from the pinned official release asset..."
$Aria2Zip = Join-Path $CacheDir "aria2-$Aria2Version-win64.zip"
Ensure-VerifiedCache -Path $Aria2Zip -ExpectedSha256 $Aria2Expected -Download { Invoke-DownloadFile -Uri $Aria2Url -OutFile $Aria2Zip -Headers $Aria2Headers }
$Aria2Actual = (Get-FileHash $Aria2Zip -Algorithm SHA256).Hash.ToLowerInvariant()
$Aria2Extracted = Join-Path $Work "aria2"
Expand-Archive -Path $Aria2Zip -DestinationPath $Aria2Extracted -Force
$Aria2Exe = Get-ChildItem $Aria2Extracted -Recurse -Filter aria2c.exe | Select-Object -First 1
if (-not $Aria2Exe) {
  throw "The verified aria2 archive does not contain aria2c.exe."
}
$Aria2Path = Join-Path $BinDir "aria2c.exe"
Copy-Item $Aria2Exe.FullName $Aria2Path -Force
$Aria2Copying = Get-ChildItem $Aria2Extracted -Recurse -File |
  Where-Object { $_.Name -in @("COPYING", "COPYING.txt") } |
  Select-Object -First 1
if (-not $Aria2Copying) { throw "The verified aria2 archive does not contain its COPYING license text." }
Copy-Item $Aria2Copying.FullName (Join-Path $LicenseDir "ARIA2-COPYING.txt") -Force
$Aria2OpenSslLicense = Get-ChildItem $Aria2Extracted -Recurse -File |
  Where-Object { $_.Name -eq "LICENSE.OpenSSL" } |
  Select-Object -First 1
if (-not $Aria2OpenSslLicense) { throw "The verified aria2 archive does not contain its upstream LICENSE.OpenSSL notice." }
Copy-Item $Aria2OpenSslLicense.FullName (Join-Path $LicenseDir "ARIA2-OPENSSL-LICENSE.txt") -Force

$FfmpegSourceArchiveName = "ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz"
$FfmpegSourceArchivePath = Join-Path $Root "third-party-source\ffmpeg\$FfmpegSourceArchiveName"
$FfmpegSourceArchiveSha256 = "b2891ffafd30bf26e7db0a6d68c1f98844fa02977919a895da561d297208cf58"
$FfmpegBuildInputsPath = "third-party-source/reviews/ffmpeg-9.0.2-safe-lean-build-inputs.json"
$FfmpegBuildInputsSha256 = "235df607cd1631110221e6272b9f35347ba32391ec304f600fdba2f3b517f8f0"
$FfmpegReviewPath = "third-party-source/reviews/ffmpeg-9.0.2-safe-lean-distributor-review.md"
$FfmpegReviewSha256 = "c09b218561033019939b2b076fca72cee253f743ec583467044b0d796fe1e0c9"
$FfmpegStage = Join-Path $Work "safe-lean-ffmpeg"
Write-Host "Rebuilding canonical SAFE LEAN FFmpeg $FfmpegVersion from its pinned corresponding-source archive..."
& (Join-Path $PSScriptRoot "prepare-safe-lean-ffmpeg.ps1") -OutputDirectory $FfmpegStage
if ($LASTEXITCODE -ne 0 -or -not $?) { throw "The canonical SAFE LEAN FFmpeg build failed." }
$FfmpegPath = Join-Path $BinDir "ffmpeg.exe"
$FfprobePath = Join-Path $BinDir "ffprobe.exe"
Copy-Item (Join-Path $FfmpegStage "ffmpeg.exe") $FfmpegPath -Force
Copy-Item (Join-Path $FfmpegStage "ffprobe.exe") $FfprobePath -Force
Copy-Item (Join-Path $FfmpegStage "FFMPEG-LICENSE.txt") (Join-Path $LicenseDir "FFMPEG-LICENSE.txt") -Force
Copy-Item (Join-Path $FfmpegStage "FFMPEG-BUILD-README.txt") (Join-Path $LicenseDir "FFMPEG-BUILD-README.txt") -Force
$FfmpegActual = (Get-FileHash -LiteralPath $FfmpegSourceArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($FfmpegActual -ne $FfmpegSourceArchiveSha256) { throw "The FFmpeg corresponding-source archive SHA-256 is invalid." }
$FfmpegBuildInputsActual = (Get-FileHash -LiteralPath (Join-Path $Root $FfmpegBuildInputsPath) -Algorithm SHA256).Hash.ToLowerInvariant()
$FfmpegReviewActual = (Get-FileHash -LiteralPath (Join-Path $Root $FfmpegReviewPath) -Algorithm SHA256).Hash.ToLowerInvariant()
if ($FfmpegBuildInputsActual -ne $FfmpegBuildInputsSha256 -or $FfmpegReviewActual -ne $FfmpegReviewSha256) {
  throw "The SAFE LEAN build-input record or distributor review does not match its approved SHA-256."
}

$DenoAssetName = "deno-x86_64-pc-windows-msvc.zip"
$DenoReleaseApi = "https://api.github.com/repos/denoland/deno/releases/tags/v$DenoVersion"
$DenoHeaders = @{ "User-Agent" = "CDM-Desktop-Build"; "Accept" = "application/vnd.github+json" }
$DenoExpected = $DenoSha256.Trim().ToLowerInvariant()
if ($DenoExpected -notmatch '^[a-f0-9]{64}$') {
  throw "A trusted SHA-256 is required for Deno."
}
$DenoApiSha256 = Get-GitHubAssetSha256 -ReleaseApi $DenoReleaseApi -AssetName $DenoAssetName -Headers $DenoHeaders
if ($DenoApiSha256 -and $DenoApiSha256 -ne $DenoExpected) {
  throw "The pinned Deno SHA-256 does not match the official GitHub asset digest."
}
$DenoUrl = "https://github.com/denoland/deno/releases/download/v$DenoVersion/$DenoAssetName"
$DenoZip = Join-Path $CacheDir "deno-v$DenoVersion-win64.zip"
Write-Host "Preparing Deno $DenoVersion for yt-dlp JavaScript challenges..."
Ensure-VerifiedCache -Path $DenoZip -ExpectedSha256 $DenoExpected -Download { Invoke-DownloadFile -Uri $DenoUrl -OutFile $DenoZip -Headers $DenoHeaders }
$DenoActual = (Get-FileHash $DenoZip -Algorithm SHA256).Hash.ToLowerInvariant()
$DenoExtracted = Join-Path $Work "deno"
Expand-Archive -Path $DenoZip -DestinationPath $DenoExtracted -Force
$DenoExe = Get-ChildItem $DenoExtracted -Recurse -Filter deno.exe | Select-Object -First 1
if (-not $DenoExe) {
  throw "The verified Deno archive does not contain deno.exe."
}
$DenoPath = Join-Path $BinDir "deno.exe"
Copy-Item $DenoExe.FullName $DenoPath -Force
$DenoVersionOutput = & $DenoPath --version
if ($LASTEXITCODE -ne 0) { throw "Deno failed with exit code $LASTEXITCODE." }
$DenoVersionActual = (($DenoVersionOutput | Select-Object -First 1) | Out-String).Trim()
if ($DenoVersionActual -notmatch "deno $([regex]::Escape($DenoVersion))(\s|$)") {
  throw "Deno version mismatch. Expected $DenoVersion, received: $DenoVersionActual"
}

$YtDlpVersionOutput = & $YtDlpPath --version
if ($LASTEXITCODE -ne 0) { throw "yt-dlp failed with exit code $LASTEXITCODE." }
$YtDlpVersionActual = (($YtDlpVersionOutput | Select-Object -First 1) | Out-String).Trim()

$Aria2VersionOutput = & $Aria2Path --version
if ($LASTEXITCODE -ne 0) { throw "aria2c failed with exit code $LASTEXITCODE." }
$Aria2VersionActual = (($Aria2VersionOutput | Select-Object -First 1) | Out-String).Trim()

$FfmpegVersionOutput = & $FfmpegPath -version
if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed with exit code $LASTEXITCODE." }
$FfmpegVersionActual = (($FfmpegVersionOutput | Select-Object -First 1) | Out-String).Trim()
if ($FfmpegVersionActual -notmatch "9\.0\.2") { throw "SAFE LEAN FFmpeg version mismatch: $FfmpegVersionActual" }

$FfprobeVersionOutput = & $FfprobePath -version
if ($LASTEXITCODE -ne 0) { throw "ffprobe failed with exit code $LASTEXITCODE." }
$FfprobeVersionActual = (($FfprobeVersionOutput | Select-Object -First 1) | Out-String).Trim()

# FFmpeg writes part of -buildconf to stderr even when it succeeds.
# Windows PowerShell 5.1 can convert that normal stderr output into a
# NativeCommandError when ErrorActionPreference is Stop. Capture both
# streams through Start-Process instead of invoking the executable directly.
$FfmpegBuildStdout = Join-Path $Work "ffmpeg-buildconf.stdout.txt"
$FfmpegBuildStderr = Join-Path $Work "ffmpeg-buildconf.stderr.txt"
$FfmpegBuildProcess = Start-Process `
  -FilePath $FfmpegPath `
  -ArgumentList "-buildconf" `
  -NoNewWindow `
  -Wait `
  -PassThru `
  -RedirectStandardOutput $FfmpegBuildStdout `
  -RedirectStandardError $FfmpegBuildStderr
if ($FfmpegBuildProcess.ExitCode -ne 0) {
  throw "ffmpeg -buildconf failed with exit code $($FfmpegBuildProcess.ExitCode)."
}
$FfmpegBuildConfigParts = @()
if (Test-Path $FfmpegBuildStdout) {
  $FfmpegBuildConfigParts += Get-Content $FfmpegBuildStdout -Raw
}
if (Test-Path $FfmpegBuildStderr) {
  $FfmpegBuildConfigParts += Get-Content $FfmpegBuildStderr -Raw
}
$FfmpegBuildConfig = (($FfmpegBuildConfigParts -join [Environment]::NewLine)).Trim()
if (-not $FfmpegBuildConfig) {
  throw "ffmpeg -buildconf returned no configuration output."
}
$FfmpegExecutableSha256 = (Get-FileHash -LiteralPath $FfmpegPath -Algorithm SHA256).Hash.ToLowerInvariant()
$FfprobeExecutableSha256 = (Get-FileHash -LiteralPath $FfprobePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($FfmpegExecutableSha256 -ne "e88ac9e6896275df773cde74e48a88312c3c76814956682440a0f8e52c35b74f" -or
    $FfprobeExecutableSha256 -ne "787482513fe1031d2b8ec400aae34204f6f18d1ea9cc27d8b0643e5d3772c6c3") {
  throw "Prepared FFmpeg/FFprobe do not match the distributor-approved SAFE LEAN pair."
}

$FfmpegSourceArchiveRelativePath = "third-party-source/ffmpeg/$FfmpegSourceArchiveName"
$FfmpegLicenseSha256 = (Get-FileHash -LiteralPath (Join-Path $LicenseDir "FFMPEG-LICENSE.txt") -Algorithm SHA256).Hash.ToLowerInvariant()
$FfmpegRuntimeRecord = [ordered]@{
  profile = "SAFE LEAN"
  approvedCandidateKey = "ffmpegSafeLeanCandidate"
  version = $FfmpegVersionActual
  ffprobeVersion = $FfprobeVersionActual
  sourceRepository = "https://github.com/FFmpeg/FFmpeg"
  sourceVersion = "n$FfmpegVersion"
  sourceCommit = $FfmpegSourceCommit.ToLowerInvariant()
  source = $FfmpegSourceArchiveRelativePath
  license = "GPL-3.0-or-later"
  effectiveLicense = "GPL-3.0-or-later"
  sourceArchiveName = $FfmpegSourceArchiveName
  sourceArchivePath = $FfmpegSourceArchiveRelativePath
  sourceArchiveSha256 = $FfmpegActual
  buildInputsPath = $FfmpegBuildInputsPath
  buildInputsSha256 = $FfmpegBuildInputsActual
  buildConfigurationEvidence = $FfmpegBuildInputsPath
  distributionApprovalRecordPath = $FfmpegReviewPath
  distributionApprovalSha256 = $FfmpegReviewActual
  ffmpegSha256 = $FfmpegExecutableSha256
  ffprobeSha256 = $FfprobeExecutableSha256
  licenseSha256 = $FfmpegLicenseSha256
  buildConfiguration = $FfmpegBuildConfig
}

$Manifest = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  ytDlp = [ordered]@{
    version = $YtDlpVersionActual
    sourceRepository = "https://github.com/yt-dlp/yt-dlp"
    sourceVersion = $YtDlpVersion
    sourceCommit = $YtDlpCommit.ToLowerInvariant()
    effectiveLicense = "GPL-3.0-or-later"
    source = $YtDlpUrl
    releaseApi = $YtDlpReleaseApi
    checksumsSource = $YtDlpChecksumsUrl
    officialAssetSha256 = $YtDlpApiSha256
    sha256 = $YtDlpActual
    thirdPartyLicensesSource = $YtDlpLicensesUrl
    thirdPartyLicensesSourceCommit = $YtDlpCommit
    thirdPartyLicensesPinnedSha256 = $YtDlpLicensesExpected
    thirdPartyLicensesSha256 = (Get-FileHash (Join-Path $LicenseDir "YT-DLP-THIRD-PARTY-LICENSES.txt") -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  deno = [ordered]@{
    version = $DenoVersionActual
    source = $DenoUrl
    releaseApi = $DenoReleaseApi
    archiveSha256 = $DenoActual
    executableSha256 = (Get-FileHash $DenoPath -Algorithm SHA256).Hash.ToLowerInvariant()
    jsRuntime = "deno"
  }
  spotify = [ordered]@{
    enabled = $false
    runtime = "omitted"
  }
  aria2 = [ordered]@{
    version = $Aria2VersionActual
    sourceRepository = "https://github.com/aria2/aria2"
    sourceVersion = "release-$Aria2Version"
    sourceCommit = $Aria2SourceCommit.ToLowerInvariant()
    source = $Aria2Url
    releaseApi = $Aria2ReleaseApi
    officialAssetSha256 = $Aria2ApiSha256
    archiveSha256 = $Aria2Actual
    executableSha256 = (Get-FileHash $Aria2Path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  ffmpeg = $FfmpegRuntimeRecord
  ffmpegSafeLeanCandidate = $FfmpegRuntimeRecord
}
$Manifest | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $BinDir "runtime-manifest.json") -Encoding UTF8

@"
Clear Download Manager provides yt-dlp in the optional Media Tools component.
Version: $YtDlpVersionActual
Official source: $YtDlpUrl
Official checksums: $YtDlpChecksumsUrl
SHA-256: $YtDlpActual
Official release metadata: $YtDlpReleaseApi
Third-party licenses source commit: $YtDlpCommit
Third-party licenses source: $YtDlpLicensesUrl
Third-party licenses pinned SHA-256: $YtDlpLicensesExpected
The verified source file is included as YT-DLP-THIRD-PARTY-LICENSES.txt.
yt-dlp itself is distributed under The Unlicense: https://github.com/yt-dlp/yt-dlp/blob/$YtDlpVersion/LICENSE.

The standalone Windows executable is a combined PyInstaller distribution and does not have the same effective license as the yt-dlp source repository. The README at the exact release tag describes the bundled executable as GPL-3.0-or-later; the pinned THIRD_PARTY_LICENSES.txt identifies Mutagen as GPL-2.0-or-later. See https://github.com/yt-dlp/yt-dlp/blob/$YtDlpVersion/README.md#licensing and the included YT-DLP-THIRD-PARTY-LICENSES.txt.

Clear records yt-dlp.exe as GPL-3.0-or-later for release gating. Corresponding source/build inputs or a reviewed alternative remain PENDING. Do not distribute the binary until the GPL source gate passes.
"@ | Set-Content (Join-Path $LicenseDir "YT-DLP-NOTICE.txt") -Encoding UTF8

@"
Clear Download Manager provides aria2c in the optional Torrent Engine component.
Version output: $Aria2VersionActual
Official release asset: $Aria2Url
Archive SHA-256: $Aria2Actual
Executable SHA-256: $((Get-FileHash $Aria2Path -Algorithm SHA256).Hash.ToLowerInvariant())

aria2 is distributed under GPL-2.0-or-later. Keep this notice and the verified release COPYING text as
ARIA2-COPYING.txt. The same release includes LICENSE.OpenSSL, preserved as ARIA2-OPENSSL-LICENSE.txt;
it contains the upstream OpenSSL linking-exception notice and license text. Keep the corresponding-source
offer or source distribution required for the exact binary shipped.
Official source repository: https://github.com/aria2/aria2
Release source tag: release-$Aria2Version
"@ | Set-Content (Join-Path $LicenseDir "ARIA2-NOTICE.txt") -Encoding UTF8

@"
Clear Download Manager provides FFmpeg and FFprobe in the optional Media Tools component to combine and convert audio and video.
Build: $FfmpegVersionActual (SAFE LEAN; GPL-3.0-or-later)
Corresponding-source archive: $FfmpegSourceArchiveName
Corresponding-source SHA-256: $FfmpegActual
Source commit: $FfmpegSourceCommit
ffmpeg.exe SHA-256: $FfmpegExecutableSha256
ffprobe.exe SHA-256: $FfprobeExecutableSha256
Build-input record: $FfmpegBuildInputsPath (SHA-256 $FfmpegBuildInputsActual)
Distributor review: $FfmpegReviewPath (SHA-256 $FfmpegReviewActual)

The exact corresponding source archive and build inputs accompany the source and release assets. The source archive contains the pinned FFmpeg, x264, LAME, and dav1d source archives and the build tooling. The canonical binaries were rebuilt from that package and their hashes are checked before packaging.

Configuration reported by ffmpeg -buildconf:
$FfmpegBuildConfig
"@ | Set-Content (Join-Path $LicenseDir "FFMPEG-NOTICE.txt") -Encoding UTF8

@"
Clear Download Manager provides Deno in the optional Media Tools component as the JavaScript runtime used by yt-dlp EJS challenges.
Version output: $DenoVersionActual
Official release asset: $DenoUrl
Archive SHA-256: $DenoActual
Executable SHA-256: $((Get-FileHash $DenoPath -Algorithm SHA256).Hash.ToLowerInvariant())
Official release metadata: $DenoReleaseApi
Deno source and license: https://github.com/denoland/deno
"@ | Set-Content (Join-Path $LicenseDir "DENO-NOTICE.txt") -Encoding UTF8

Write-Host "Download and media runtimes verified and prepared in $BinDir" -ForegroundColor Green
Write-Host "yt-dlp: $YtDlpVersionActual"
Write-Host "Deno: $DenoVersionActual"
Write-Host "aria2c: $Aria2VersionActual"
Write-Host "FFmpeg: $FfmpegVersionActual"
Remove-Item -LiteralPath $Work -Recurse -Force
