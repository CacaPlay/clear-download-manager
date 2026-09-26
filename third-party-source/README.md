# Corresponding source for distributed GPL runtimes

This directory is the controlled intake point for the exact corresponding
source materials of GPL binaries distributed by Clear Download Manager. The
canonical SAFE LEAN FFmpeg/FFprobe candidate and its source archive have been
reproduced and approved for integration. The active production FFmpeg runtime
is still the Gyan build until a separate runtime-replacement change activates
SAFE LEAN. aria2 and yt-dlp remain pending.

The release gate reads `corresponding-source.json`. Keep every downloaded
archive, build script, patch, dependency source manifest, license/notice, hash
record, and human review record under this directory. Do not substitute a
generic upstream source URL or a nearby version. Match the exact binary version,
configuration, linked libraries, and source package to the artifact being
distributed. For FFmpeg this includes the enabled external libraries shown in
`docs/THIRD-PARTY-RUNTIMES.md`, not only the FFmpeg core tree.

## Distributor work still required

1. Obtain the exact source package and build inputs from the upstream
   distributor/build provider for each binary. For aria2, identify the exact
   Windows build recipe and linked libraries. For FFmpeg, obtain the complete
   source for the Gyan build and every linked library, plus its build
   scripts/configuration and patches. The SAFE LEAN FFmpeg candidate package
   and build inputs are recorded in `corresponding-source.json` and the
   distributor review under `reviews/`; before distribution, a separate PR
   must activate those exact binaries and package inspection must confirm
   their hashes. For yt-dlp, the PyInstaller Windows
   executable is identified upstream as a GPLv3+ combined work; obtain the
   exact source of its included GPL components (including the bundled Mutagen
   version) and the build/packaging inputs. The yt-dlp source tarball alone is
   not sufficient evidence: upstream says that tarball contains only
   Unlicense-licensed code.
2. Record immutable upstream references and SHA-256 values; preserve the
   unmodified source archives and all additional scripts/files required to
   build and install the executables.
3. Have the distributor or counsel review that these are the complete,
   corresponding sources for the precise distributed binaries and select the
   lawful delivery method. The automated gate can check file presence and
   hashes; it cannot decide legal sufficiency.
4. For network downloads, publish the exact corresponding-source archive from
   the same release page/channel with equivalent access to the binary. If the
   source must live elsewhere, put clear instructions beside each binary and
   keep the source available for as long as that binary is distributed.
5. A written offer is a separate compliance route, not a URL placeholder. It
   must accompany the binary and be reviewed against that runtime's GPL version
   and the actual distribution method. For example, GPLv2 section 3(b)
   specifies an offer valid for at least three years; GPLv3 section 6 has
   distinct methods, including a network-source route and a physical-product
   written-offer route. Do not assume the physical-product offer applies to a
   downloaded MSI/MSIX. Record the selected legal basis and fulfillment owner.
6. Verify the source/offer assets beside the binaries before the release is
   published. Preserve the complete source inputs and keep fulfillment/source
   access active for the applicable period.

If the exact corresponding source cannot be obtained, do not distribute the
affected Windows bundle. Keep the existing license texts, SBOM, dependency
license inventory, and `THIRD_PARTY_NOTICES.txt`; they are useful notices but
are not a substitute for corresponding source.

References: [GNU GPL v2, section 3](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html),
[GNU GPL v3, section 6](https://www.gnu.org/licenses/gpl-3.0.en.html),
[GNU licensing FAQ on source distribution](https://www.gnu.org/licenses/gpl-faq.en.html), and
[FFmpeg licensing](https://ffmpeg.org/legal.html).
