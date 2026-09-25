param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDirectory,
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,
  [string]$PlaylistSource = '',
  [string]$OnlyKey = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$assetMap = [ordered]@{
  archive      = 'Comprimido.png'
  document     = 'Docx.png'
  ebook        = 'Ebook.png'
  package      = 'EXE.png'
  torrent      = 'Icono.png'
  font         = 'Icono2.png'
  text         = 'Icono3.png'
  sheet        = 'icono4.png'
  code         = 'icono5.png'
  image        = 'Imagenes.png'
  disk         = 'ISO.png'
  audio        = 'MP3.png'
  video        = 'Multimedia.png'
  pdf          = 'PDF.png'
  presentation = 'PowerPoint.png'
  generic      = 'Sin formato.png'
}
if ($PlaylistSource) { $assetMap['playlist-prep'] = $PlaylistSource }
if ($OnlyKey) {
  if (-not $assetMap.Contains($OnlyKey)) { throw "Clave de icono desconocida: $OnlyKey" }
  $assetMap = [ordered]@{ $OnlyKey = $assetMap[$OnlyKey] }
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

function Test-Blue([System.Drawing.Color]$Color) {
  $max = [math]::Max($Color.R, [math]::Max($Color.G, $Color.B))
  $min = [math]::Min($Color.R, [math]::Min($Color.G, $Color.B))
  # Navy artwork is neutral; only the brighter saturated blue accent is
  # recolored by the interface theme.
  return ($Color.B -ge 100) -and ($Color.B -ge ($Color.R + 22)) -and ($Color.B -ge ($Color.G + 4)) -and (($max - $min) -ge 24)
}

foreach ($entry in $assetMap.GetEnumerator()) {
  $sourcePath = if ([System.IO.Path]::IsPathRooted([string]$entry.Value)) {
    [string]$entry.Value
  } else {
    Join-Path $SourceDirectory ([string]$entry.Value)
  }
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Falta el PNG de origen para $($entry.Key): $sourcePath"
  }

  $source = [System.Drawing.Bitmap]::new($sourcePath)
  $workingSize = 512
  $working = [System.Drawing.Bitmap]::new($workingSize, $workingSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $workingGraphics = [System.Drawing.Graphics]::FromImage($working)
  try {
    $workingGraphics.Clear([System.Drawing.Color]::Transparent)
    $workingGraphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $workingGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $workingGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $workingGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $sourceScale = [math]::Min($workingSize / [double]$source.Width, $workingSize / [double]$source.Height)
    $sourceDrawWidth = [math]::Max(1, [math]::Round($source.Width * $sourceScale))
    $sourceDrawHeight = [math]::Max(1, [math]::Round($source.Height * $sourceScale))
    $sourceDrawX = [math]::Round(($workingSize - $sourceDrawWidth) / 2)
    $sourceDrawY = [math]::Round(($workingSize - $sourceDrawHeight) / 2)
    $workingGraphics.DrawImage($source, [System.Drawing.Rectangle]::new($sourceDrawX, $sourceDrawY, $sourceDrawWidth, $sourceDrawHeight))
  } finally { $workingGraphics.Dispose() }
  $neutralFull = [System.Drawing.Bitmap]::new($workingSize, $workingSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $accentFull = [System.Drawing.Bitmap]::new($workingSize, $workingSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $flatFull = if ($entry.Key -eq 'audio') { [System.Drawing.Bitmap]::new($workingSize, $workingSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb) } else { $null }
  $minX = $working.Width; $minY = $working.Height; $maxX = -1; $maxY = -1

  # Some supplied PNGs have an opaque black canvas while others are already
  # transparent. Remove only dark pixels connected to the canvas edge so dark
  # navy artwork inside the logo is preserved as neutral gray.
  $backgroundMask = [bool[]]::new($workingSize * $workingSize)
  $queue = [System.Collections.Generic.Queue[int]]::new()
  function Test-DarkCanvas([System.Drawing.Color]$Color) {
    return ($Color.A -gt 4) -and ($Color.R -lt 72) -and ($Color.G -lt 72) -and ($Color.B -lt 72)
  }
  for ($edge = 0; $edge -lt $workingSize; $edge++) {
    foreach ($index in @($edge, (($workingSize - 1) * $workingSize) + $edge, ($edge * $workingSize), ($edge * $workingSize) + ($workingSize - 1))) {
      if ($backgroundMask[$index]) { continue }
      $edgePixel = $working.GetPixel(($index % $workingSize), [math]::Floor($index / $workingSize))
      if (Test-DarkCanvas $edgePixel) {
        $backgroundMask[$index] = $true
        $queue.Enqueue($index)
      }
    }
  }
  while ($queue.Count -gt 0) {
    $index = $queue.Dequeue()
    $x = [int]($index % $workingSize); $y = [int][math]::Floor($index / $workingSize)
    $dx = @(-1, 1, 0, 0); $dy = @(0, 0, -1, 1)
    for ($direction = 0; $direction -lt 4; $direction++) {
      $nx = $x + [int]$dx[$direction]; $ny = $y + [int]$dy[$direction]
      if ($nx -lt 0 -or $ny -lt 0 -or $nx -ge $workingSize -or $ny -ge $workingSize) { continue }
      $neighborIndex = ($ny * $workingSize) + $nx
      if ($backgroundMask[$neighborIndex]) { continue }
      $neighborPixel = $working.GetPixel($nx, $ny)
      if (Test-DarkCanvas $neighborPixel) {
        $backgroundMask[$neighborIndex] = $true
        $queue.Enqueue($neighborIndex)
      }
    }
  }

  try {
    for ($y = 0; $y -lt $working.Height; $y++) {
      for ($x = 0; $x -lt $working.Width; $x++) {
        $pixel = $working.GetPixel($x, $y)
        $alpha = [int]$pixel.A
        if ($alpha -le 4) { continue }

        if ($backgroundMask[($y * $workingSize) + $x]) { continue }
        if ($entry.Key -eq 'playlist-prep' -and $pixel.R -gt 235 -and $pixel.G -gt 235 -and $pixel.B -gt 235) {
          # The requested playlist source contains white matte/saw-tooth pixels
          # around the artwork. They are not part of the logo and must vanish.
          continue
        }

        $isBlue = Test-Blue $pixel
        if ($alpha -le 4) { continue }

        if ($isBlue) {
          $accentFull.SetPixel($x, $y, [System.Drawing.Color]::FromArgb([int]$alpha, 255, 255, 255))
        } else {
          # A fixed neutral gray remains readable in both themes and does not
          # change with the user's accent color.
          $neutralFull.SetPixel($x, $y, [System.Drawing.Color]::FromArgb([int]$alpha, 187, 199, 212))
        }
        if ($flatFull) {
          # Audio is intentionally rendered as one recolorable silhouette; it
          # must not retain a separate accent circle from the source artwork.
          $flatFull.SetPixel($x, $y, [System.Drawing.Color]::FromArgb([int]$alpha, 255, 255, 255))
        }
        if ($x -lt $minX) { $minX = $x }; if ($y -lt $minY) { $minY = $y }
        if ($x -gt $maxX) { $maxX = $x }; if ($y -gt $maxY) { $maxY = $y }
      }
    }

    if ($maxX -lt $minX -or $maxY -lt $minY) { throw "El PNG $sourcePath no contiene arte visible" }
    $cropWidth = $maxX - $minX + 1; $cropHeight = $maxY - $minY + 1
    $canvasWidth = 256
    $canvasHeight = if ($entry.Key -eq 'playlist-prep') { 171 } else { 256 }
    $padding = if ($entry.Key -eq 'playlist-prep') { 8 } else { 16 }
    $availableWidth = $canvasWidth - ($padding * 2)
    $availableHeight = $canvasHeight - ($padding * 2)
    $scale = [math]::Min($availableWidth / [double]$cropWidth, $availableHeight / [double]$cropHeight)
    $drawWidth = [math]::Max(1, [math]::Round($cropWidth * $scale)); $drawHeight = [math]::Max(1, [math]::Round($cropHeight * $scale))
    $drawX = [math]::Round(($canvasWidth - $drawWidth) / 2); $drawY = [math]::Round(($canvasHeight - $drawHeight) / 2)

    $layers = @(@('neutral', $neutralFull), @('accent', $accentFull))
    if ($flatFull) { $layers += ,@('flat', $flatFull) }
    foreach ($layer in $layers) {
      $canvas = [System.Drawing.Bitmap]::new($canvasWidth, $canvasHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $graphics = [System.Drawing.Graphics]::FromImage($canvas)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.DrawImage($layer[1], [System.Drawing.Rectangle]::new($drawX, $drawY, $drawWidth, $drawHeight), $minX, $minY, $cropWidth, $cropHeight, [System.Drawing.GraphicsUnit]::Pixel)
      } finally { $graphics.Dispose() }
      $destination = Join-Path $OutputDirectory "$($entry.Key)-$($layer[0]).png"
      $canvas.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
      $canvas.Dispose()
    }
  } finally {
    $source.Dispose(); $working.Dispose(); $neutralFull.Dispose(); $accentFull.Dispose(); if ($flatFull) { $flatFull.Dispose() }
  }
  Write-Output "OK: $($entry.Key) <- $([System.IO.Path]::GetFileName($sourcePath))"
}
