# SAFE LEAN deterministic build evidence

**Captured:** 2026-09-26
**Status:** Candidate prepared for distributor review. No production runtime, runtime manifest, corresponding-source registry, release workflow, or release gate was changed.

## Result summary

Four clean builds were compared: A2 and B2 from separate clean build roots, C4 rebuilt from the extracted source package, and D rebuilt again from that exact extracted package. Each produced the same files:

| Output | Bytes | SHA-256 |
| --- | ---: | --- |
| `ffmpeg.exe` | 31,374,848 | `e88ac9e6896275df773cde74e48a88312c3c76814956682440a0f8e52c35b74f` |
| `ffprobe.exe` | 31,156,736 | `787482513fe1031d2b8ec400aae34204f6f18d1ea9cc27d8b0643e5d3772c6c3` |
| `build-config.json` | 2,787 | `eda2d9121dd4816626c6c106e20a1ea1fe37bde70c2d81941931b3c58d545c4d` |

The four output sets are bit-identical to each other. PE COFF and export-directory timestamps are zero; the binaries contain no original user/temp-root paths. The build fixes `SOURCE_DATE_EPOCH=1784011149` (`2026-07-14T06:39:09Z`), locale `C`, timezone `UTC`, `PYTHONHASHSEED=0`, GCC prefix maps for source/build roots, and GNU ld `--no-insert-timestamp`.

## Comparison with the originally tested prototype

The original prototype hashes remain:

| Original candidate output | SHA-256 |
| --- | --- |
| `ffmpeg.exe` | `bfd6a61157c2b123124cd76c0acfc8c24d6406e064fa3b7d792a04dbaba9bf3e` |
| `ffprobe.exe` | `6fca76ec1ba51984fef6c2b97fc604f030aeb30533fb3ffa6df44b5400b30bb3` |
| build configuration | `4bcef85bcb3974d39f0a554166df3a36c07aab496ed1b2397b0cbdd0898a4d6` |

The new pair is **not** bit-identical to those original executables, so this archive must not be described as corresponding source for the original hashes. The prototype used a dav1d Git checkout with `.git` metadata; its generated `vcs_version.h` embedded `1.5.4-0-g54706fc`. The source archive intentionally has no `.git` directory; its upstream Meson metadata reports `1.5.4`. The old FFmpeg build also embedded its temporary build paths in `-version` output; the canonical prefix maps remove those machine-specific paths. The old and new x264 object members were identical; LAME object members were identical despite archive metadata differences; the dav1d archive differed in the generated `lib.c` object consistent with its version string.

The rebuilt pair passed the same synthetic media profile checks: FFmpeg/FFprobe version, MP4 H.264/AAC probe and decode, WebM VP9/Opus probe and decode, AV1/Opus remux/probe/decode, MP4 merge/probe/decode, MP3, M4A/AAC, FLAC, and H.264/AAC fallback encode/probe/decode (**28 checks passed**). These are local synthetic fixtures, not a live YouTube test. This supports functional equivalence for the exercised profile; it does not prove bit identity or every possible behavior.

## Corresponding-source candidate package

The candidate archive is:

- Asset name: `ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz`
- Size: 20,504,148 bytes
- SHA-256: `b2891ffafd30bf26e7db0a6d68c1f98844fa02977919a895da561d297208cf58`
- Packaging check: Windows PowerShell 5.1 and PowerShell 7 produced byte-identical archives with the same SHA-256.

It contains the exact FFmpeg 9.0.2 commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`, x264 commit `b35605ace3ddf7c1a5d67a2eb553f034aef41d55`, LAME 3.100 source, and dav1d 1.5.4 commit `54706fc6bc0cdecab7e9593974a4039cc038fca7`; source archive hashes, build scripts/options, toolchain lock, and upstream license files are included. `SHA256SUMS.txt` validates 14 package files. `PACKAGE-CONTENTS.json` records byte counts and hashes for 15 files, including `SHA256SUMS.txt`.

The final archive was extracted into a clean directory. Its TAR listing contained 21 entries including directories and no `.exe` files. Its listed source hashes were checked, its package contents were checked, its tooling tests reported 7 pass and 4 intentional skips (the maintainer packager is not part of the redistributable source archive), and the FFmpeg pair was rebuilt from that extracted copy with the same hashes shown above. The package includes source and build inputs, not FFmpeg runtime binaries or compiled dependency libraries.

The toolchain lock records the observed 57-package MSYS2 UCRT64 closure, exact package versions, upstream repository URLs, sizes and SHA-256 digests, plus pinned Meson/Ninja wheels. Running the included verifier from the documented UCRT64 shell confirmed all 57 locked package versions. It does **not** bundle those toolchain packages, and a fully offline toolchain bootstrap was not demonstrated. The source package is therefore reproducible with the documented pinned toolchain inputs, but is not a self-contained offline build environment.

PE import inspection found only Windows system/UCRT imports (`CRYPT32`, `KERNEL32`, UCRT API sets, `NCrypt`, `Secur32`, `SHELL32`, and `WS2_32`). The configured external libraries are statically linked: x264, LAME, and dav1d. FFmpeg's internal libraries are part of the FFmpeg source archive. The build enables `--enable-gpl` and `--enable-version3`; metadata records effective build licensing as `GPL-3.0-or-later`. Upstream license and notice files for FFmpeg, x264, LAME, and dav1d are retained in their full source archives. This is an inventory for review, not legal approval.

## Gate simulation

Simulation used copies of the registry, runtime manifest, contract, and release-asset directory under the system temporary directory. The production registry and gates were not edited.

- With the current production exact-name/runtime contract, the SAFE LEAN candidate correctly fails the existing FFmpeg asset-name and runtime-file identity rules.
- In a copied contract with only the FFmpeg asset-name rule changed from `essentials` to `safe-lean`, the candidate produces no validation failures. The gate remains `PENDING` for the required human distributor review and for aria2/yt-dlp requirements.
- A deliberately wrong source archive hash is rejected.
- A false `humanReview: APPROVED` without a review record is rejected.

The real corresponding-source and runtime registries remain unchanged. Binary release remains fail-closed.

## Human decision before production use

The distributor must decide whether the newly reproducible pair is the SAFE LEAN runtime candidate to adopt. If approved, the production runtime hashes and exact corresponding-source asset mapping must be updated together, then revalidated. The original prototype hashes cannot be claimed as reconstructed by this package. Human review of the GPL distribution materials remains pending, and aria2/yt-dlp remain independent binary-release blockers.
