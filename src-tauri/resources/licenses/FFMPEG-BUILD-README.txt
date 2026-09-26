Clear Download Manager bundles the canonical SAFE LEAN FFmpeg 9.0.2 pair as external local tools.

Profile: SAFE LEAN
Effective license: GPL-3.0-or-later (--enable-gpl --enable-version3)
Upstream FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/946fcce07b6dcd0331c8cc609192aeff5e1924f8
Corresponding-source asset: ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz
Corresponding-source SHA-256: b2891ffafd30bf26e7db0a6d68c1f98844fa02977919a895da561d297208cf58
Distributor review SHA-256: c09b218561033019939b2b076fca72cee253f743ec583467044b0d796fe1e0c9

Canonical Windows x64 outputs:
ffmpeg.exe  31,374,848 bytes  e88ac9e6896275df773cde74e48a88312c3c76814956682440a0f8e52c35b74f
ffprobe.exe 31,156,736 bytes  787482513fe1031d2b8ec400aae34204f6f18d1ea9cc27d8b0643e5d3772c6c3

The source package records the exact FFmpeg, x264, LAME, and dav1d source archives, their hashes, all build options, and the pinned MSYS2 UCRT64/Meson/Ninja toolchain. The package build script does not download source code or reuse prior binaries.

FFmpeg configuration includes static GPL/version 3 builds with FFmpeg, FFprobe, network and Schannel enabled; codecs include libx264, libmp3lame, and libdav1d. Exact configure and dependency flags are in build-options.json and the build script in the source package; each build generates build-config.json with its output hashes.

The complete corresponding source and notices are provided in the adjacent source archive. The source package does not include compiled outputs or compiler/runtime toolchain package binaries.
