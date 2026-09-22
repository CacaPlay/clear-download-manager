param(
  [string]$YtDlpVersion = "2026.08.19",
  [string]$YtDlpCommit = "3a08beaf031ab68f966401ead017ac81fe8486cf",
  [string]$YtDlpLicensesSha256 = "472aefe951c7db35e1657c1d13fd337140511ed6f2b329205105ad441c5a02b7",
  [string]$FfmpegVersion = "9.0.2",
  [string]$FfmpegSha256 = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
  [string]$FfmpegSourceCommit = "946fcce07b",
  [string]$Aria2Version = "1.37.0",
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

# Spotify está desactivado temporalmente en 0.24.2. No se descarga, verifica ni
# ejecuta spotDL durante la preparación. Se elimina cualquier copia residual
# para que el instalador no la incluya accidentalmente.
Get-ChildItem $BinDir -Filter 'spotdl*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force
Write-Host "Spotify/spotDL disabled: runtime omitted from this build." -ForegroundColor DarkYellow

$ReleaseBase = "https://github.com/yt-dlp/yt-dlp/releases/download/$YtDlpVersion"
$YtDlpReleaseApi = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/tags/$YtDlpVersion"
$YtDlpHeaders = @{
  "User-Agent" = "CacaTools-Desktop-Build"
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
$Aria2Headers = @{ "User-Agent" = "CacaTools-Desktop-Build"; "Accept" = "application/vnd.github+json" }
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

$FfmpegAssetName = "ffmpeg-$FfmpegVersion-essentials_build.zip"
$FfmpegReleaseApi = "https://api.github.com/repos/GyanD/codexffmpeg/releases/tags/$FfmpegVersion"
$FfmpegHeaders = @{ "User-Agent" = "CacaTools-Desktop-Build"; "Accept" = "application/vnd.github+json" }
$FfmpegExpected = $FfmpegSha256.Trim().ToLowerInvariant()
if (-not $FfmpegExpected) {
  throw "A trusted SHA-256 is required for FFmpeg."
}
$FfmpegApiSha256 = Get-GitHubAssetSha256 -ReleaseApi $FfmpegReleaseApi -AssetName $FfmpegAssetName -Headers $FfmpegHeaders
if ($FfmpegApiSha256 -and $FfmpegApiSha256 -ne $FfmpegExpected) {
  throw "The pinned FFmpeg SHA-256 does not match the official GitHub asset digest."
}
$FfmpegUrl = "https://github.com/GyanD/codexffmpeg/releases/download/$FfmpegVersion/$FfmpegAssetName"
$FfmpegZip = Join-Path $CacheDir "ffmpeg-$FfmpegVersion-essentials.zip"
Write-Host "Preparing FFmpeg $FfmpegVersion..."
Ensure-VerifiedCache -Path $FfmpegZip -ExpectedSha256 $FfmpegExpected -Download { Invoke-DownloadFile -Uri $FfmpegUrl -OutFile $FfmpegZip }
$FfmpegActual = (Get-FileHash $FfmpegZip -Algorithm SHA256).Hash.ToLowerInvariant()

$Extracted = Join-Path $Work "ffmpeg"
Expand-Archive -Path $FfmpegZip -DestinationPath $Extracted -Force
$FfmpegExe = Get-ChildItem $Extracted -Recurse -Filter ffmpeg.exe | Select-Object -First 1
$FfprobeExe = Get-ChildItem $Extracted -Recurse -Filter ffprobe.exe | Select-Object -First 1
if (-not $FfmpegExe -or -not $FfprobeExe) {
  throw "The downloaded archive does not contain ffmpeg.exe and ffprobe.exe."
}
Copy-Item $FfmpegExe.FullName (Join-Path $BinDir "ffmpeg.exe") -Force
Copy-Item $FfprobeExe.FullName (Join-Path $BinDir "ffprobe.exe") -Force
$FfmpegLicense = Get-ChildItem $Extracted -Recurse -File |
  Where-Object { $_.Name -match "^(LICENSE|COPYING)(\.txt)?$" } |
  Sort-Object FullName |
  Select-Object -First 1
if (-not $FfmpegLicense) {
  throw "The verified FFmpeg archive does not contain a license file."
}
Copy-Item $FfmpegLicense.FullName (Join-Path $LicenseDir "FFMPEG-LICENSE.txt") -Force
$FfmpegReadme = Get-ChildItem $Extracted -Recurse -File |
  Where-Object { $_.Name -match "^README(\.txt|\.md)?$" } |
  Sort-Object FullName |
  Select-Object -First 1
if ($FfmpegReadme) { Copy-Item $FfmpegReadme.FullName (Join-Path $LicenseDir "FFMPEG-BUILD-README.txt") -Force }

$FfmpegPath = Join-Path $BinDir "ffmpeg.exe"
$FfprobePath = Join-Path $BinDir "ffprobe.exe"

$DenoAssetName = "deno-x86_64-pc-windows-msvc.zip"
$DenoReleaseApi = "https://api.github.com/repos/denoland/deno/releases/tags/v$DenoVersion"
$DenoHeaders = @{ "User-Agent" = "CacaTools-Desktop-Build"; "Accept" = "application/vnd.github+json" }
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

$Manifest = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  ytDlp = [ordered]@{
    version = $YtDlpVersionActual
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
  spotify = [ordered]@{ enabled = $false; runtime = 'omitted' }
  aria2 = [ordered]@{
    version = $Aria2VersionActual
    source = $Aria2Url
    releaseApi = $Aria2ReleaseApi
    officialAssetSha256 = $Aria2ApiSha256
    archiveSha256 = $Aria2Actual
    executableSha256 = (Get-FileHash $Aria2Path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  ffmpeg = [ordered]@{
    version = $FfmpegVersionActual
    ffprobeVersion = $FfprobeVersionActual
    source = $FfmpegUrl
    releaseApi = $FfmpegReleaseApi
    officialAssetSha256 = $FfmpegApiSha256
    sourceCommit = $FfmpegSourceCommit
    archiveSha256 = $FfmpegActual
    ffmpegSha256 = (Get-FileHash $FfmpegPath -Algorithm SHA256).Hash.ToLowerInvariant()
    ffprobeSha256 = (Get-FileHash $FfprobePath -Algorithm SHA256).Hash.ToLowerInvariant()
    licenseSha256 = (Get-FileHash (Join-Path $LicenseDir "FFMPEG-LICENSE.txt") -Algorithm SHA256).Hash.ToLowerInvariant()
    buildConfiguration = $FfmpegBuildConfig
  }
}
$Manifest | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $BinDir "runtime-manifest.json") -Encoding UTF8

@"
CacaTools Download Manager includes yt-dlp as a local component.
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
"@ | Set-Content (Join-Path $LicenseDir "YT-DLP-NOTICE.txt") -Encoding UTF8

@"
CacaTools Download Manager includes aria2c as a local download engine.
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
CacaTools Download Manager uses FFmpeg and FFprobe as external executables to combine and convert audio and video.
Build: $FfmpegVersionActual
Binary source: $FfmpegUrl
Source commit reported by the provider: $FfmpegSourceCommit
Archive SHA-256: $FfmpegActual

Before public distribution, keep this notice and provide the applicable source code and build configuration required by the license of the distributed binary.

Configuration reported by ffmpeg -buildconf:
$FfmpegBuildConfig
"@ | Set-Content (Join-Path $LicenseDir "FFMPEG-NOTICE.txt") -Encoding UTF8

@"
CacaTools Download Manager includes Deno as the bundled JavaScript runtime used by yt-dlp EJS challenges.
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
Write-Host "Spotify/spotDL: disabled"
Write-Host "aria2c: $Aria2VersionActual"
Write-Host "FFmpeg: $FfmpegVersionActual"
Remove-Item -LiteralPath $Work -Recurse -Force
