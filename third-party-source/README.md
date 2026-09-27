# Corresponding source for distributed GPL runtimes

This directory holds exact corresponding-source materials for GPL runtimes
that Clear Download Manager prepares and may distribute. The active FFmpeg and
FFprobe runtime is the distributor-approved SAFE LEAN 9.0.2 build. Its exact
complete source package, build inputs, executable hashes, and review record are
linked in `corresponding-source.json`. aria2 and yt-dlp remain PENDING, so overall GPL
source readiness and binary release remain blocked.

The release gate requires each runtime's exact version, source commit, runtime hashes, corresponding-source archive, build-input record, matching release asset name/hash, and required distributor review. Do not substitute a generic upstream source URL or nearby version. Technical source candidates for aria2 and yt-dlp are now present; distributor reviews remain PENDING.

## Active FFmpeg/FFprobe SAFE LEAN runtime

- Runtime outputs: `ffmpeg.exe` and `ffprobe.exe` with the canonical hashes in
  `corresponding-source.json`.
- Corresponding source: `ffmpeg/ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz`.
- The archive preserves FFmpeg, x264, LAME, and dav1d source inputs, their
  hashes, build scripts/options, the pinned MSYS2 UCRT64 toolchain inventory,
  and upstream license files.
- `scripts/prepare-safe-lean-ffmpeg.ps1` validates the source archive and
  distributor review, rebuilds the pair from those inputs, and rejects outputs
  whose byte count or SHA-256 differs from the approved pair.
- The active Tauri preparation script uses these rebuilt executables. It does
  not download Gyan binaries or include Gyan files in the installer notices.
- Human approval is recorded in
  `reviews/ffmpeg-9.0.2-safe-lean-distributor-review.md`. The gate verifies its
  digest; it does not make an independent legal determination.

The corresponding-source archive does not contain compiled executables or the
binary toolchain packages. Windows builds require the exact pinned MSYS2
UCRT64 package closure plus the locked Meson and Ninja wheels. Build output is
verified against the recorded canonical hashes before packaging.

## Remaining distributor work

1. Review the aria2 candidate and its reproducibility limits. The upstream Windows recipe uses --without-openssl and the source bundle contains six static dependency sources and notices. Its Ubuntu/apt inputs are not pinned and no independent rebuild was performed.
2. Review the yt-dlp candidate for the GPL combined executable. It includes pinned yt-dlp, PyInstaller and builder sources, Python inputs, observed package source distributions, native build inputs, and the license inventory. No clean Windows rebuild or functional source-versus-binary comparison was performed; the host lacks the pinned Python/MSVC/CMake toolchain.
3. Keep release-asset inspection fail-closed. Exact source archives must accompany matching component packages and be linked by the signed catalog before binary readiness can pass.
4. Preserve each archive, build script, patches, dependency source, notices, hashes, and review record. A written offer is a separate reviewed method, not a generic URL.

The archived Gyan build records under `reviews/` are historical evidence only.
They are excluded from active runtime notices and are not eligible as a
corresponding-source mapping for the SAFE LEAN binaries.

References: [FFmpeg licensing](https://ffmpeg.org/legal.html),
[GNU GPL v2, section 3](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html),
and [GNU GPL v3, section 6](https://www.gnu.org/licenses/gpl-3.0.en.html).
