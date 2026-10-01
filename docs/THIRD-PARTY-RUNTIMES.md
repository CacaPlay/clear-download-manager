# Third-party runtime inventory

`src-tauri/resources/bin/runtime-manifest.json` pins the optional Windows
executables by version and SHA-256. `third-party-source/corresponding-source.json`
records their source commits, licenses, corresponding-source assets, build
inputs, and distributor approval. Run `npm.cmd run verify:binaries` to compare
prepared local executables with the runtime manifest.

The normal Core and Microsoft Store installers omit these runtime executables.
CDM downloads optional MediaTools and Torrent Engine packages separately;
their signed catalog and package gates verify the runtime files and notices.
These runtimes operate outside CDM's main process; see the [residual network
boundary in `SECURITY.md`](../SECURITY.md#frontera-de-red-de-procesos-externos)
for the scope of DNS and connection controls.

## Runtime pins

| Runtime | Version and license | Windows executable SHA-256 | Corresponding-source material |
| --- | --- | --- | --- |
| yt-dlp | 2026.08.19; the upstream project uses Unlicense, while the PyInstaller Windows executable is treated as GPL-3.0-or-later and includes Mutagen under GPL-2.0-or-later. | `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a` | `yt-dlp-2026.08.19-win64-corresponding-source.tar.xz`; exact digest and build inputs are in the source registry. A clean Windows rebuild was not established. |
| Deno | 2.9.7, `x86_64-pc-windows-msvc`; MIT. Used for yt-dlp EJS challenges. | `e020f3e232bd16e33768dee528e5983349c962952051ced0a5d58ad42f5d9b33` | Official release archive and notices are pinned in the runtime manifest and license inventory. |
| aria2c | 1.37.0; GPL-2.0-or-later. The archived MinGW configuration uses `--without-openssl`. | `be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2` | `aria2-1.37.0-win64-corresponding-source.tar.xz`; exact digest and build inputs are in the source registry. The record does not claim an independent bit-for-bit rebuild. |
| FFmpeg / FFprobe | 9.0.2 SAFE LEAN; GPL-3.0-or-later (`--enable-gpl`, `--enable-version3`). | FFmpeg `e88ac9e6896275df773cde74e48a88312c3c76814956682440a0f8e52c35b74f`; FFprobe `787482513fe1031d2b8ec400aae34204f6f18d1ea9cc27d8b0643e5d3772c6c3`. | `ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz`; source/build-input digests and approval record are in the source registry. |

The release registry is the canonical source for corresponding-source hashes
and approval states; this table avoids copying those values into a second
record. Distributor approval does not certify every distribution channel or
replace review of the exact package and applicable license obligations.

## License and notice inventories

- `NPM-SBOM.spdx.json` records npm build and development dependencies from the
  locked package tree; it is not a claim that every listed package ships in the
  executable.
- `CARGO-DEPENDENCY-LICENSES.txt` lists Cargo registry dependencies resolved
  from the application and native-host lockfiles for Windows x64. It preserves
  upstream license expressions and does not replace upstream license texts.
- `THIRD_PARTY_NOTICES.txt` is generated for packaging from project and
  third-party notices. The extension ZIP includes `LICENSE.md`, `COPYING`, and
  `NOTICE.md` but not the Windows runtime executables.
- The upstream archives preserve the original license and copyright files.
  The SAFE LEAN FFmpeg package also records pinned FFmpeg, x264, LAME, dav1d,
  and toolchain inputs.

## Distribution checks

The source registry and its files are checked with:

```powershell
npm.cmd run check:gpl-source
```

This verifies the declared source commits, licenses, approval records, archive
names, sizes, hashes, and build-input records. It does not prove that a
particular GitHub Release contains the materials. The binary gate additionally
checks the exact source assets uploaded with the release, the signed component
catalog, optional packages, Core installer contents, and checksums.

A source-only archive is checked separately:

```powershell
npm.cmd run source:archive
npm.cmd run check:source-release -- --archive "<path to source archive>"
```

It contains project source, notices, manifests, SBOMs, and compliance records,
but no installers or runtime executables. Passing this gate does not authorize
binary distribution.

For a binary package, run `check:binary-release` on the exact source archive,
Core installer, extracted inspection tree, optional component packages, and
release-asset directory. A distribution must provide the applicable
corresponding source or a legally valid written offer alongside the binaries.
GPLv2 and GPLv3 describe different offer and network-distribution routes; see
the official [GPLv2 text](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html),
[GPLv3 text](https://www.gnu.org/licenses/gpl-3.0.en.html), and
[FSF FAQ](https://www.gnu.org/licenses/gpl-faq.en.html). The automated gates
check recorded materials and hashes; they do not make an independent legal
determination.
