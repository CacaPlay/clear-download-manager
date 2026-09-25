# Some Windows runners expose PowerShell without Microsoft.PowerShell.Utility's
# Get-FileHash cmdlet. Keep build verification deterministic with a .NET fallback.
if (-not (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {
  function Get-FileHash {
    [CmdletBinding()]
    param(
      [Parameter(Position = 0, ValueFromPipeline = $true)]
      [string]$Path,
      [string]$LiteralPath,
      [ValidateSet('SHA256')]
      [string]$Algorithm = 'SHA256'
    )

    process {
      $Target = if (-not [string]::IsNullOrWhiteSpace($LiteralPath)) { $LiteralPath } else { $Path }
      if ([string]::IsNullOrWhiteSpace($Target)) { throw 'A file path is required to calculate SHA-256.' }

      $Hasher = [Security.Cryptography.SHA256]::Create()
      try {
        $Stream = [IO.File]::OpenRead($Target)
        try { $Bytes = $Hasher.ComputeHash($Stream) }
        finally { $Stream.Dispose() }
      }
      finally { $Hasher.Dispose() }

      [pscustomobject]@{
        Algorithm = $Algorithm
        Hash = ([BitConverter]::ToString($Bytes) -replace '-', '').ToLowerInvariant()
        Path = $Target
      }
    }
  }
}
