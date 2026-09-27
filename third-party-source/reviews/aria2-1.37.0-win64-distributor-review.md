# aria2 1.37.0 distributor review

- Review date: 2026-09-27
- Distributor / reviewer: CacaPlay
- Status: **APPROVED**
- Runtime: aria2 1.37.0
- Scope: the recorded Windows `aria2c.exe` runtime and its exact corresponding-source archive for distribution with Clear Download Manager.
- Distribution method approved: corresponding-source archive.

## Approved artifacts

| Artifact | Identity |
| --- | --- |
| `aria2c.exe` | SHA-256 `be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2` |
| Upstream source | `aria2/aria2`, commit `02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a` |
| `aria2-1.37.0-win64-corresponding-source.tar.xz` | 11,482,952 bytes; SHA-256 `ef538f14aa306fd66c7bf8b0d09ae82ba7f881e013d8c0f8eee9eed0ed1e0234` |

The distributor's explicit authorization was: “Apruebo los correspondientes source packages de aria2 1.37.0 y yt-dlp 2026.08.19 para la distribución de CDM, manteniendo registradas las limitaciones de reproducibilidad documentadas.”

## Accepted reproducibility limitations

The distributor approves distribution while expressly accepting these documented limitations:

**Limitations are explicitly accepted by the distributor.**

- No byte-identical rebuild has been established.
- The Ubuntu base image digest is not pinned.
- apt package versions are not pinned.
- The upstream recipe does not verify dependency archive hashes.
- No independent rebuild was performed.

These are recorded limitations, not a claim of a failed source archive or a byte-identical build. No stronger reproducibility claim is made.

This record documents the distributor's direct approval and the artifact identities reviewed. The automated gate verifies the referenced file hashes and registry linkage; it does not provide an independent legal determination.
