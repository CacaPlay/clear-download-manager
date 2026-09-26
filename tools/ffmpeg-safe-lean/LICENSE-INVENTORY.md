# SAFE LEAN source license and notice inventory

The candidate package preserves the complete original source archives; this list identifies the principal license files found in those sources.

| Component | Pinned source | License evidence included in source archive | Build result metadata |
| --- | --- | --- | --- |
| FFmpeg 9.0.2 | `946fcce07b6dcd0331c8cc609192aeff5e1924f8` | `COPYING.GPLv2`, `COPYING.GPLv3`, `COPYING.LGPLv2.1`, `COPYING.LGPLv3`, `LICENSE.md` | `GPL-3.0-or-later`, from `--enable-gpl --enable-version3` |
| x264 | `b35605ace3ddf7c1a5d67a2eb553f034aef41d55` | `COPYING` | `GPL-2.0-or-later` |
| LAME 3.100 | official 3.100 source archive | `COPYING`, `LICENSE` | `LGPL-2.0-or-later` |
| dav1d 1.5.4 | `54706fc6bc0cdecab7e9593974a4039cc038fca7` | `COPYING` | `BSD-2-Clause` |

The exact upstream license and copyright texts remain in each bundled source archive rather than being reconstructed from summaries. The effective FFmpeg build is GPL-3.0-or-later because this configuration enables GPL code and version 3. Human review is still required before distribution.
