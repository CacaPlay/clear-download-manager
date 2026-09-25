$ErrorActionPreference = 'Stop'

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = 'Clear Download Manager'
$entry = (Get-ItemProperty -LiteralPath $runKey -Name $valueName -ErrorAction SilentlyContinue).$valueName
if ([string]::IsNullOrWhiteSpace([string]$entry)) {
  throw 'No existe la entrada de inicio. Instala la versión 0.25.1 o activa Inicio con Windows en Ajustes.'
}

Write-Host "Entrada registrada: $entry"
if ([string]$entry -notmatch '--background') {
  throw 'La entrada de inicio no usa el modo --background.'
}

$match = [regex]::Match([string]$entry, '^"(?<exe>[^"]+)"')
if (-not $match.Success) {
  throw 'La entrada de inicio no contiene una ruta ejecutable entre comillas.'
}

$executable = $match.Groups['exe'].Value
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "No existe el ejecutable registrado: $executable"
}

Write-Host 'OK: inicio en segundo plano registrado y ejecutable localizado.' -ForegroundColor Green
