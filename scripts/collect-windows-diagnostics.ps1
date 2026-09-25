param(
  [string]$OutputDirectory = "output\native-diagnostics"
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Out = Join-Path $Root $OutputDirectory
Remove-Item $Out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Out -Force | Out-Null

function Capture-Text {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )

  $Path = Join-Path $Out "$Name.txt"
  try {
    & $Command | Out-String | Set-Content $Path -Encoding UTF8
  }
  catch {
    $_ | Out-String | Set-Content $Path -Encoding UTF8
  }
}

function Capture-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = $Root
  )

  $Path = Join-Path $Out "$Name.txt"
  $PreviousPreference = $ErrorActionPreference
  $Lines = New-Object System.Collections.Generic.List[string]
  $ExitCode = 1
  $ErrorActionPreference = "Continue"
  Push-Location $WorkingDirectory
  try {
    & $Command @Arguments 2>&1 | ForEach-Object {
      [void]$Lines.Add($_.ToString())
    }
    $ExitCode = $LASTEXITCODE
  }
  catch {
    [void]$Lines.Add(($_ | Out-String))
  }
  finally {
    Pop-Location
    $ErrorActionPreference = $PreviousPreference
  }

  @(
    "ExitCode: $ExitCode"
    ""
    ($Lines -join [Environment]::NewLine)
  ) | Set-Content $Path -Encoding UTF8
}

Capture-Text "environment" {
  "OS: $([System.Environment]::OSVersion.VersionString)"
  "Arch: $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"
  "PowerShell: $($PSVersionTable.PSVersion)"
  "Node: $(node --version)"
  "NPM: $(npm --version)"
  "Rust: $(rustc --version)"
  "Cargo: $(cargo --version)"
}


Capture-Text "lock-files" {
  "package-lock.json: $(Test-Path (Join-Path $Root 'package-lock.json'))"
  "src-tauri\Cargo.lock: $(Test-Path (Join-Path $Root 'src-tauri\Cargo.lock'))"
}

Capture-Native "npm-check" "npm" @("run", "check") $Root
Capture-Native "cargo-fmt" "cargo" @("fmt", "--all", "--", "--check") (Join-Path $Root "src-tauri")
Capture-Native "cargo-check" "cargo" @("check", "--locked", "--all-targets") (Join-Path $Root "src-tauri")
Capture-Native "cargo-clippy" "cargo" @("clippy", "--locked", "--all-targets", "--", "-D", "warnings") (Join-Path $Root "src-tauri")
Capture-Native "cargo-test" "cargo" @("test", "--locked", "--lib") (Join-Path $Root "src-tauri")
Capture-Native "tauri-info" "npx" @("--no-install", "tauri", "info") $Root


$RustGateOutput = Join-Path $Root "output\rust-gate"
if (Test-Path $RustGateOutput) {
  $RustGateCopy = Join-Path $Out "rust-gate"
  Copy-Item $RustGateOutput $RustGateCopy -Recurse -Force
}

Get-ChildItem Env: |
  Where-Object { $_.Name -notmatch 'TOKEN|KEY|SECRET|PASSWORD|PASS|COOKIE|AUTH' } |
  Sort-Object Name |
  Format-Table -AutoSize | Out-String |
  Set-Content (Join-Path $Out "environment-safe.txt") -Encoding UTF8

$Zip = "$Out.zip"
Remove-Item $Zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$Out\*" -DestinationPath $Zip -CompressionLevel Optimal
Write-Host "Diagnostics created without sensitive environment variables: $Zip"
