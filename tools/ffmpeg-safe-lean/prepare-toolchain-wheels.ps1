[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $WheelDirectory,

  [Parameter(Mandatory = $true)]
  [string] $ToolchainDirectory,

  [string] $PythonExecutable = 'C:\msys64\ucrt64\bin\python.exe'
)

$ErrorActionPreference = 'Stop'
$toolRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$lockPath = Join-Path $toolRoot 'toolchain.lock.json'
if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
  $lockPath = Join-Path $toolRoot '..\..\toolchain.lock.json'
}
if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
  throw 'toolchain.lock.json is missing from the tool directory and package root.'
}
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
$wheelRoot = (Resolve-Path -LiteralPath $WheelDirectory).Path
$toolchainFull = [IO.Path]::GetFullPath($ToolchainDirectory)
if (-not (Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) {
  throw "Pinned MSYS2 Python executable is missing: $PythonExecutable"
}
if (Test-Path -LiteralPath $toolchainFull) {
  throw "Toolchain destination already exists; use a new empty directory: $toolchainFull"
}
if ($lock.pythonWheels.Count -ne 2) {
  throw 'The toolchain lock must contain exactly the pinned Meson and Ninja wheels.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$sitePackages = Join-Path $toolchainFull 'site-packages'
$binDirectory = Join-Path $toolchainFull 'bin'
$null = New-Item -ItemType Directory -Force -Path $sitePackages
$null = New-Item -ItemType Directory -Force -Path $binDirectory

foreach ($wheel in $lock.pythonWheels) {
  if ($wheel.name -notmatch '^(meson-1\.12\.1-py3-none-any|ninja-1\.13\.2-py3-none-win_amd64)\.whl$') {
    throw "Unexpected Python wheel in the toolchain lock: $($wheel.name)"
  }
  if ($wheel.url -notmatch '^https://files\.pythonhosted\.org/' -or $wheel.sha256 -notmatch '^[a-f0-9]{64}$') {
    throw "Python wheel URL or SHA-256 is invalid: $($wheel.name)"
  }
  $wheelPath = Join-Path $wheelRoot $wheel.name
  if (-not (Test-Path -LiteralPath $wheelPath -PathType Leaf)) {
    Invoke-WebRequest -Uri $wheel.url -OutFile $wheelPath
  }
  $file = Get-Item -LiteralPath $wheelPath
  if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Pinned wheel cannot be a reparse point: $($wheel.name)"
  }
  if ($file.Length -ne [int64] $wheel.bytes) {
    throw "Pinned wheel byte count mismatch: $($wheel.name)"
  }
  $actual = (Get-FileHash -LiteralPath $wheelPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $wheel.sha256) {
    throw "Pinned wheel SHA-256 mismatch: $($wheel.name)"
  }
  [System.IO.Compression.ZipFile]::ExtractToDirectory($wheelPath, $sitePackages)
  "Verified wheel: $($wheel.name) ($actual)"
}

$ninjaSource = Join-Path $sitePackages 'ninja-1.13.2.data\scripts\ninja.exe'
$ninjaDestination = Join-Path $binDirectory 'ninja.exe'
if (-not (Test-Path -LiteralPath $ninjaSource -PathType Leaf)) {
  throw 'Pinned Ninja wheel does not contain ninja-1.13.2.data/scripts/ninja.exe.'
}
Copy-Item -LiteralPath $ninjaSource -Destination $ninjaDestination

$previousPythonPath = $env:PYTHONPATH
try {
  $env:PYTHONPATH = $sitePackages
  $mesonVersion = (& $PythonExecutable -m mesonbuild.mesonmain --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $mesonVersion -ne '1.12.1') {
    throw "Pinned Meson verification failed; expected 1.12.1, got '$mesonVersion'."
  }
  $ninjaVersion = (& $ninjaDestination --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $ninjaVersion -notmatch '^1\.13\.2(?:\.|$)') {
    throw "Pinned Ninja verification failed; expected 1.13.2, got '$ninjaVersion'."
  }
}
finally {
  if ($null -eq $previousPythonPath) { Remove-Item Env:\PYTHONPATH -ErrorAction SilentlyContinue }
  else { $env:PYTHONPATH = $previousPythonPath }
}

"Toolchain wheel directory: $toolchainFull"
"Meson: $mesonVersion"
"Ninja: $ninjaVersion"
"UCRT64 Python: $PythonExecutable"
