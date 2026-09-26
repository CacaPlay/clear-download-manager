# SAFE LEAN FFmpeg 9.0.2 corresponding source candidate

This tooling reconstructs the isolated SAFE LEAN Windows x64 FFmpeg/FFprobe pair selected for technical evaluation. It does not replace CDM's current runtime, alter product behavior, or connect to the production preparation script. The corresponding-source package is a candidate for review; it is not an approval to distribute binaries.

## Fixed source inputs

`source-inputs.json` locks the exact FFmpeg, x264, LAME, and dav1d source archives by commit/version and SHA-256. The build script accepts local archives only and fails before extraction if a name or hash is wrong. It has no download step.

The configured build enables GPL and version 3 components, so its effective FFmpeg license metadata is `GPL-3.0-or-later`. x264's source license is GPL-2.0-or-later; LAME is LGPL-2.0-or-later; dav1d is BSD-2-Clause. The full upstream source archives, including their license and notice files, are preserved in the candidate package. This inventory is technical evidence, not a legal approval.

The LAME build disables its standalone console frontend because the distributed FFmpeg uses only the static `libmp3lame` library. LAME 3.100 does not install the pkg-config record FFmpeg expects, so the script writes that record from a fixed template pointing to the freshly built library. No LAME library or configuration is copied from the earlier prototype.

## Toolchain

Use the exact MSYS2 UCRT64 package versions in `toolchain.lock.json`, plus the pinned Meson and Ninja wheels recorded there. From PowerShell, prepare the two wheels into a new external toolchain directory; the helper downloads only their exact locked URLs and validates byte count and SHA-256 before extracting:

```powershell
$wheelCache = Join-Path $env:TEMP 'safe-lean-wheels'
$localToolchain = Join-Path $env:TEMP 'safe-lean-toolchain'
New-Item -ItemType Directory -Force -Path $wheelCache | Out-Null
.\tools\ffmpeg-safe-lean\prepare-toolchain-wheels.ps1 `
  -WheelDirectory $wheelCache `
  -ToolchainDirectory $localToolchain
```

The helper requires the pinned MSYS2 Python 3.12.11 and refuses to reuse an existing toolchain destination. In the MSYS2 UCRT64 shell, set paths to that external toolchain and verify the complete package closure before building:

```sh
export PATH="$(cygpath -u "$TEMP/safe-lean-toolchain/bin"):/ucrt64/bin:/usr/bin"
export PYTHONPATH="$(cygpath -u "$TEMP/safe-lean-toolchain/site-packages")"
python -m mesonbuild.mesonmain --version
ninja --version
python tools/ffmpeg-safe-lean/verify-toolchain.py --lock toolchain.lock.json
```

Ensure UCRT64 tools precede MSYS tools in `PATH`. `verify-toolchain.py` checks the complete 57-package dependency closure before compilation. NASM/YASM are not installed; the x264, dav1d, and FFmpeg build options disable assembly. Do not substitute a newer toolchain or unpinned package set when claiming reproduction.

The lock describes the observed build environment. It does not claim that all MSYS2 package archives were cached or that an offline toolchain bootstrap has been demonstrated. The package hashes and cache coverage are recorded as observed evidence.

## Deterministic build settings

The build script pins `SOURCE_DATE_EPOCH=1784011149` (`2026-07-14T06:39:09Z`), the committer timestamp of the latest pinned source commit, dav1d `54706fc6bc0cdecab7e9593974a4039cc038fca7`. It also pins `LC_ALL=C`, `LANG=C`, `TZ=UTC`, and `PYTHONHASHSEED=0`. GCC therefore expands any `__DATE__` and `__TIME__` macros against one documented UTC instant.

The FFmpeg compile flags map the physical build root and source-archive root to `/safe-lean/build` and `/safe-lean/sources` with GCC `-ffile-prefix-map`. The final PE link uses GNU ld `--no-insert-timestamp`, which zeroes both the COFF timestamp and the export-directory timestamp in `.edata`; the PE checksum is consequently stable once the remaining bytes are stable. The selected MSYS2 GNU `ar` produces deterministic static archives, confirmed by byte-for-byte comparisons of x264, LAME, and dav1d archives from separate clean build roots.

The pinned dav1d source archive is the exact locked source commit and has no `.git` directory. Its upstream `meson.build` declares version `1.5.4`; the build script checks that version through the freshly installed `dav1d.pc` and records it alongside the full commit and source archive hash. The `-0-g<commit>` suffix seen in an earlier Git checkout came from `git describe` metadata that is absent from the corresponding source archive; it is not used or fabricated by this build.

These settings define the canonical SAFE LEAN build inputs. Each output's `build-config.json` records the fixed epoch, normalized path maps, linker option, source identity, dependency versions, toolchain versions, configure options, and executable hashes. The source package contains this build script and configuration.

## Build from extracted candidate package

From the extracted package directory, in an MSYS2 UCRT64 shell with the pinned Meson Python wheel and Ninja executable installed:

```sh
python -m mesonbuild.mesonmain --version
ninja --version
bash tools/ffmpeg-safe-lean/verify-sha256.sh <expected-sha256> sources/<archive>
bash tools/ffmpeg-safe-lean/build-safe-lean.sh \
  --sources "$PWD/sources" \
  --build-dir "$PWD/rebuild/work" \
  --output-dir "$PWD/rebuild/output"
```

The build and output paths must be new. Build logs and intermediate libraries stay in the build directory. The output directory contains only `ffmpeg.exe`, `ffprobe.exe`, and `build-config.json`.

No existing prototype objects, installed prototype libraries, or previous FFmpeg binaries are used by the build script. The source archive and tool hashes are checked before compilation. The script refuses a different major tool version and does not download missing dependencies.

## Corresponding source contents

The package includes the exact upstream source archives and SHA-256 lock, this script, the hash verifier, toolchain package inventory, FFmpeg configure options, and a license/notice inventory. It excludes compiled FFmpeg binaries, dependency libraries, intermediate objects, and caches.

Repository maintainers can create the archive with `tools/ffmpeg-safe-lean/package-source.ps1`, passing the verified source directory and an output path outside the repository. The packager supports Windows PowerShell 5.1 and PowerShell 7 and writes canonical LF/UTF-8 manifests so the archive hash is stable across those shells.

## Review status

Human distributor review remains `PENDING`. This package must not change `third-party-source/corresponding-source.json`, `runtime-manifest.json`, or any release gate. Binary release remains fail-closed until the distributor approves the exact archive and the project gate records that review.
