# FFmpeg 9.0.2 SAFE LEAN distributor review

- Review date: 2026-09-26
- Distributor / reviewer: CacaPlay
- Status: **APPROVED**
- Scope: the canonical SAFE LEAN `ffmpeg.exe` and `ffprobe.exe` pair and the exact corresponding-source package named below.
- Distribution method approved: corresponding-source archive.
- Effective configured build license: GPL-3.0-or-later.

## Approved artifacts

| Artifact | SHA-256 |
| --- | --- |
| `ffmpeg.exe` (31,374,848 bytes) | `e88ac9e6896275df773cde74e48a88312c3c76814956682440a0f8e52c35b74f` |
| `ffprobe.exe` (31,156,736 bytes) | `787482513fe1031d2b8ec400aae34204f6f18d1ea9cc27d8b0643e5d3772c6c3` |
| `ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz` (20,504,148 bytes) | `b2891ffafd30bf26e7db0a6d68c1f98844fa02977919a895da561d297208cf58` |

The four independently reproduced builds were byte-identical to this new canonical pair. The original prototype executables are historical evidence only; they were not reproduced and are not covered by this approval.

The build toolchain is pinned by package versions, URLs, and SHA-256 digests in `tools/ffmpeg-safe-lean/toolchain.lock.json`. The corresponding-source package does not bundle those toolchain packages or provide a complete offline toolchain bootstrap.

## Limits and follow-up

This approval covers only the SAFE LEAN FFmpeg/FFprobe pair and its corresponding-source package. It does not approve aria2 or yt-dlp; both remain PENDING, so overall GPL-source readiness and binary-release readiness remain blocked.

The active production FFmpeg/FFprobe files and their Gyan runtime metadata are unchanged by this preparation PR. A separate runtime-replacement PR must install the approved SAFE LEAN executables, update the active runtime metadata and preparation flow, verify package inspection against the exact hashes above, and rerun the release gates before any binary distribution. This approval does not authorize a tag or release.

## Distributor authorization

The following authorization was supplied directly by the distributor and is recorded verbatim:

> “Apruebo el par canónico SAFE LEAN y su corresponding-source package para integrarlos en CDM. Autoriza registrar la revisión humana y continuar con PR #16, sin tag ni release.”
