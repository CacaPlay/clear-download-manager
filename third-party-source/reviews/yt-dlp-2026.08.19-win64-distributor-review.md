# yt-dlp 2026.08.19 distributor review

- Review date: 2026-09-27
- Distributor / reviewer: CacaPlay
- Status: **APPROVED**
- Runtime: yt-dlp 2026.08.19
- Scope: the recorded Windows `yt-dlp.exe` runtime and its exact generated corresponding-source archive for distribution with Clear Download Manager.
- Distribution method approved: corresponding-source archive.

## Approved artifacts

| Artifact | Identity |
| --- | --- |
| `yt-dlp.exe` | SHA-256 `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a` |
| Upstream source | `yt-dlp/yt-dlp`, version `2026.08.19`, commit `3a08beaf031ab68f966401ead017ac81fe8486cf` |
| Archive identity at the 2026-09-27 approval review (historical; superseded by the metadata revision below) | 89,850,884 bytes; SHA-256 `03063667338e2e2f6b0f5c4ddb348f7690699f8f43e1f6017590c915427265bb` |
| Custom PyInstaller wheel source | `yt-dlp/Pyinstaller-Builds`, immutable release `2026.08.19.215425` |
| `pyinstaller-6.22.0-py3-none-win_amd64.whl` | SHA-256 `294099ecb5fdd2a13ae4c29006d4e335b697a63b6a16cf052b90ec2b40bef05a` |
| PyInstaller source | commit `70fc17210920bce17f4ab09bbf8104b0dbd45338` |

The distributor's explicit authorization was: “Apruebo los correspondientes source packages de aria2 1.37.0 y yt-dlp 2026.08.19 para la distribución de CDM, manteniendo registradas las limitaciones de reproducibilidad documentadas.”

## Positive preparation evidence

- Clean empty staging fetch: **PASS**.
- All 40 pinned inputs were verified by size and SHA-256; the pinned source-distribution inventory was also verified.
- At the time of the 2026-09-27 review, source assembly reproduced the archive size and SHA-256 recorded above.

## Archive identity correction for v1.0.0

The v1.0.0 clean-fetch assembly exposed that the previous archive pin referenced an older distributor notice whose first line still named CacaTools. The current source tree contains the Clear Download Manager notice. I rebuilt from the same 40 hash-pinned inputs and verified that the internal manifest changed in exactly one of 8,185 entries: `notices/YT-DLP-NOTICE.txt`. The other 8,184 entries, including the upstream source, dependency sources, build inputs, and runtime identity, match the previously approved package. The approved runtime and source-distribution scope remains the same; the corrected archive identity above replaces the stale archive hash.

## Generated metadata archive revision (2026-10-01)

The current assembler changed the generated `BUILD-INPUTS.json` field from `humanReview` to `distributionApproval`. Two independent builds from clean staging directories, each populated by 40 hash-pinned downloads and the verified source-distribution inventory, produced the same archive: 89,855,212 bytes; SHA-256 `78f552ec5c4bd5c05012cc1c9c1c8eb526d301bdd3f2cbbe1bab79d507c27184`; internal manifest SHA-256 `7cb5d0d0a0e1e818b0e7f800a3ecefb85a3231be8e1186180cc587eec0bb186d`.

Compared with the historical archive identity above, 8,184 of 8,186 package files are byte-identical. The only changed files are `BUILD-INPUTS.json` and `SOURCE-PACKAGE-MANIFEST.sha256`. No upstream source, source distribution, native input, dependency, notice, version, runtime identity, or binary identity changed. The prior archive hash is retained as historical evidence; this generated-metadata revision records the current technical archive identity and does not claim a new approval event or a bit-identical runtime rebuild.

## Accepted build and inventory limitations

The distributor approves distribution while expressly accepting these documented limitations:

**Limitations are explicitly accepted by the distributor.**

- No clean Windows rebuild was performed.
- No bit-identical rebuild has been established.
- The upstream `windows-2025` runner is a moving environment.
- Python 3.10 patch selection is not a fully frozen environment.
- The runtime binary does not expose a complete cryptographic inventory of every bundled compiled/native module.

These are recorded limitations, not a claim of a failed source archive or a bit-identical build. No stronger reproducibility or binary-inventory claim is made.

This record documents the distributor's direct approval and the artifact identities reviewed. The automated gate verifies the referenced file hashes and registry linkage; it does not provide an independent legal determination.
